import * as fs from 'fs'
import * as path from 'path'
import { ethers } from 'ethers'
import { getChainClient, CCTP_SOURCE_CHAINS } from './v1/chain'
import type { BridgeWatcher } from './BridgeWatcher'

/**
 * Relays Circle CCTP V2 cross-chain USDC burns into Base Sepolia.
 *
 * Flow per pending burn:
 *   1. FE POSTs the source-chain burn txHash to /v1/cctp/burn → enqueueBurn().
 *   2. tick(): pull the source-chain receipt, extract the
 *      `MessageSent(bytes message)` event from MessageTransmitterV2, derive
 *      messageHash = keccak256(message). Status → awaiting-attestation.
 *   3. tick(): poll Iris (`GET /v2/messages/{srcDomain}/{messageHash}`) until
 *      `status: complete`. Status → ready.
 *   4. tick(): submit `MessageTransmitterV2.receiveMessage(message, attestation)`
 *      on Base Sepolia from the operator wallet (gas paid by us). Status →
 *      relayed. The mint + hook handler runs atomically, emits Deposited
 *      from CCTPDepositReceiver, BridgeWatcher picks it up and credits the
 *      0G Treasury.
 *
 * Persistence: a single JSON file at /data/cctp-relayer.json tracks pending
 * messages. Adaptive tick interval: 5s when there's pending work, 30s when
 * idle (Iris rate limits to 35 req/sec — we're nowhere near, but no point
 * burning quota on empty queues).
 *
 * Failure: 5 attempts then status=failed. failed entries surface via
 * /v1/cctp/status so the FE can tell the user "retry from the source chain"
 * rather than spinning forever.
 */

const STATE_DIR = process.env.BRIDGE_STATE_DIR || '/data'
const STATE_FILE = 'cctp-relayer.json'
const IRIS_API_URL = process.env.CCTP_IRIS_API_URL || 'https://iris-api-sandbox.circle.com'
const TICK_BUSY_MS = 5_000
const TICK_IDLE_MS = 30_000
const MAX_ATTEMPTS = 5
const ATTEMPT_BACKOFF_MS = 30_000

// MessageTransmitterV2 emits `event MessageSent(bytes message)`. Same
// signature as V1 — just the new contract address.
const MESSAGE_SENT_TOPIC = ethers.id('MessageSent(bytes)')

export type RelayerStage =
  | 'awaiting-message'
  | 'awaiting-attestation'
  | 'ready'
  | 'relayed'
  | 'settling'
  | 'credited'
  | 'failed'

export interface PendingMessage {
  srcChainId: number
  srcDomain: number
  txHash: string // source-chain burn tx
  /** FE-asserted user address (jwt.address). Used for status filtering
   *  only — does NOT affect the credit recipient (the contract uses
   *  messageSender from the signed CCTP attestation). */
  userAddr: string
  messageHash?: string
  message?: string
  attestation?: string
  status: RelayerStage
  /** Hash of the receiveMessage tx submitted on Base. */
  baseTxHash?: string
  /** Hash of the receiver.settle tx — this is where Deposited is
   *  emitted, so BridgeWatcher's hasProcessed() must match against
   *  THIS hash, not the earlier receiveMessage tx. */
  settleTxHash?: string
  firstSeenAt: number
  lastAttemptAt: number
  attempts: number
  lastError?: string
}

interface PersistedState {
  pending: PendingMessage[]
}

export class CCTPRelayer {
  private pending: Map<string, PendingMessage> = new Map() // keyed by `${srcChainId}:${txHash.toLowerCase()}`
  private timer: NodeJS.Timeout | null = null
  private statePath: string
  private inFlight = false

  constructor(private readonly bridgeWatcher?: BridgeWatcher) {
    this.statePath = path.join(STATE_DIR, STATE_FILE)
  }

  async start(): Promise<void> {
    const client = getChainClient()
    if (!client.writeMessageTransmitter) {
      console.warn('[CCTPRelayer] MessageTransmitterV2 wallet missing — relayer disabled')
      return
    }
    if (!client.cctpReceiverAddr) {
      console.warn('[CCTPRelayer] BASE_CCTP_RECEIVER_ADDRESS missing — relayer disabled')
      return
    }
    if (Object.keys(client.sourceProviders).length === 0) {
      console.warn('[CCTPRelayer] no source-chain providers configured — relayer disabled')
      return
    }
    this.loadState()
    console.log(
      `[CCTPRelayer] starting; pending=${this.pending.size} iris=${IRIS_API_URL} sources=${Object.keys(CCTP_SOURCE_CHAINS).join(',')}`,
    )
    this.scheduleTick(this.pending.size > 0 ? TICK_BUSY_MS : TICK_IDLE_MS)
  }

  stop(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }

  /** Record a new burn for relay. Idempotent — re-submitting the same
   *  txHash returns the existing entry. */
  async enqueueBurn(
    srcChainId: number,
    txHash: string,
    userAddr: string,
  ): Promise<{ messageHash?: string; status: RelayerStage }> {
    const cfg = CCTP_SOURCE_CHAINS[srcChainId]
    if (!cfg) throw new Error(`unsupported source chain ${srcChainId}`)
    const key = `${srcChainId}:${txHash.toLowerCase()}`
    const existing = this.pending.get(key)
    if (existing) {
      return { messageHash: existing.messageHash, status: existing.status }
    }
    const entry: PendingMessage = {
      srcChainId,
      srcDomain: cfg.domain,
      txHash,
      userAddr: userAddr.toLowerCase(),
      status: 'awaiting-message',
      firstSeenAt: Date.now(),
      lastAttemptAt: 0,
      attempts: 0,
    }
    this.pending.set(key, entry)
    this.persistState()
    // Kick a tick immediately so the user sees fast feedback.
    this.scheduleTick(0)
    return { status: entry.status }
  }

  /** Status lookup for /v1/cctp/status. Filtered by user when provided
   *  so one user can't enumerate another's pending bridges. */
  getStatus(srcChainId: number, txHash: string, userAddr?: string): PendingMessage | null {
    const key = `${srcChainId}:${txHash.toLowerCase()}`
    const entry = this.pending.get(key)
    if (!entry) return null
    if (userAddr && entry.userAddr !== userAddr.toLowerCase()) return null
    return entry
  }

  private scheduleTick(delayMs: number): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.tick().catch(err => console.error('[CCTPRelayer] tick failed:', err))
    }, delayMs)
    if (typeof this.timer.unref === 'function') this.timer.unref()
  }

  private async tick(): Promise<void> {
    if (this.inFlight) {
      this.scheduleTick(TICK_BUSY_MS)
      return
    }
    this.inFlight = true
    try {
      let didWork = false
      for (const entry of this.pending.values()) {
        if (entry.status === 'failed' || entry.status === 'credited') continue
        if (entry.status === 'settling') {
          // Promote to credited as soon as BridgeWatcher confirms the
          // 0G credit. The Deposited event is emitted in the settle tx,
          // not the earlier receiveMessage tx — match against settleTxHash.
          if (
            entry.settleTxHash &&
            this.bridgeWatcher?.hasProcessed(getChainClient().cctpReceiverAddr, entry.settleTxHash)
          ) {
            entry.status = 'credited'
            this.persistState()
          }
          continue
        }
        if (entry.attempts >= MAX_ATTEMPTS) {
          entry.status = 'failed'
          this.persistState()
          continue
        }
        const sinceLast = Date.now() - entry.lastAttemptAt
        if (sinceLast < ATTEMPT_BACKOFF_MS && entry.attempts > 0) continue

        try {
          if (entry.status === 'awaiting-message') {
            await this.advanceAwaitingMessage(entry)
          } else if (entry.status === 'awaiting-attestation') {
            await this.advanceAwaitingAttestation(entry)
          } else if (entry.status === 'ready') {
            await this.advanceReady(entry)
          } else if (entry.status === 'relayed') {
            await this.advanceRelayed(entry)
          }
          didWork = true
        } catch (err: any) {
          entry.attempts += 1
          entry.lastAttemptAt = Date.now()
          entry.lastError = err?.shortMessage ?? err?.message ?? String(err)
          console.warn(
            `[CCTPRelayer] ${entry.status} step failed (attempt ${entry.attempts}/${MAX_ATTEMPTS}) ${entry.txHash.slice(0, 12)}: ${entry.lastError}`,
          )
          this.persistState()
        }
      }
      const stillPending = [...this.pending.values()].some(
        e => e.status !== 'failed' && e.status !== 'credited',
      )
      this.scheduleTick(stillPending ? TICK_BUSY_MS : TICK_IDLE_MS)
      if (!didWork) return
    } finally {
      this.inFlight = false
    }
  }

  private async advanceAwaitingMessage(entry: PendingMessage): Promise<void> {
    const client = getChainClient()
    const provider = client.sourceProviders[entry.srcChainId]
    if (!provider) throw new Error(`no provider for chain ${entry.srcChainId}`)

    const receipt = await provider.getTransactionReceipt(entry.txHash)
    if (!receipt) {
      // Tx might still be pending — bump attempts gently.
      entry.lastAttemptAt = Date.now()
      throw new Error('burn receipt not yet available')
    }
    const log = receipt.logs.find(l => l.topics[0] === MESSAGE_SENT_TOPIC)
    if (!log) {
      throw new Error('no MessageSent event in burn receipt')
    }
    const decoded = ethers.AbiCoder.defaultAbiCoder().decode(['bytes'], log.data)
    const message = decoded[0] as string
    const messageHash = ethers.keccak256(message)

    entry.message = message
    entry.messageHash = messageHash
    entry.status = 'awaiting-attestation'
    entry.attempts = 0
    entry.lastAttemptAt = Date.now()
    this.persistState()
    console.log(
      `[CCTPRelayer] message captured for ${entry.txHash.slice(0, 12)} → messageHash ${messageHash.slice(0, 12)}`,
    )
  }

  private async advanceAwaitingAttestation(entry: PendingMessage): Promise<void> {
    if (!entry.messageHash) throw new Error('messageHash missing')
    const url = `${IRIS_API_URL}/v2/messages/${entry.srcDomain}?transactionHash=${entry.txHash}`
    const res = await fetch(url)
    if (!res.ok) {
      throw new Error(`Iris ${res.status}: ${await res.text().catch(() => '')}`)
    }
    const data = (await res.json()) as { messages?: Array<{ status: string; attestation?: string; eventNonce?: string; message?: string; cctpVersion?: number }> }
    const msg = data.messages?.find(
      m => m.message && ethers.keccak256(m.message) === entry.messageHash,
    ) ?? data.messages?.[0]
    if (!msg) {
      // Iris hasn't seen the burn yet — keep polling.
      entry.lastAttemptAt = Date.now()
      throw new Error('attestation pending (no messages returned)')
    }
    if (msg.status !== 'complete' || !msg.attestation) {
      entry.lastAttemptAt = Date.now()
      throw new Error(`attestation ${msg.status}`)
    }
    entry.attestation = msg.attestation
    // Iris may return a normalized message — prefer it over the raw event log.
    if (msg.message) entry.message = msg.message
    entry.status = 'ready'
    entry.attempts = 0
    entry.lastAttemptAt = Date.now()
    this.persistState()
    console.log(`[CCTPRelayer] attestation ready for ${entry.txHash.slice(0, 12)}`)
  }

  private async advanceReady(entry: PendingMessage): Promise<void> {
    if (!entry.message || !entry.attestation) throw new Error('message/attestation missing')
    const client = getChainClient()
    if (!client.writeMessageTransmitter) throw new Error('no writeMessageTransmitter')

    const tx = await client.writeMessageTransmitter.receiveMessage(entry.message, entry.attestation)
    const receipt = await tx.wait()
    entry.baseTxHash = receipt?.hash ?? tx.hash
    entry.status = 'relayed'
    entry.attempts = 0
    entry.lastAttemptAt = Date.now()
    this.persistState()
    console.log(
      `[CCTPRelayer] relayed ${entry.txHash.slice(0, 12)} → base tx ${entry.baseTxHash?.slice(0, 12)}`,
    )
  }

  /**
   * After receiveMessage mints USDC into the receiver, call
   * `receiver.settle(message)` to forward USDC into the gateway and
   * emit `Deposited(user, net)`. CCTP V2 does not auto-execute hooks
   * on the mint recipient, so this second tx is required to complete
   * the deposit. BridgeWatcher then picks up the Deposited event and
   * credits SwarmTreasury on 0G.
   */
  private async advanceRelayed(entry: PendingMessage): Promise<void> {
    if (!entry.message) throw new Error('message missing')
    const client = getChainClient()
    if (!client.writeCctpReceiver) throw new Error('no writeCctpReceiver')

    const tx = await client.writeCctpReceiver.settle(entry.message)
    const receipt = await tx.wait()
    entry.settleTxHash = receipt?.hash ?? tx.hash
    entry.status = 'settling'
    entry.attempts = 0
    entry.lastAttemptAt = Date.now()
    this.persistState()
    console.log(
      `[CCTPRelayer] settled ${entry.txHash.slice(0, 12)} → settle tx ${entry.settleTxHash?.slice(0, 12)}; awaiting BridgeWatcher`,
    )
  }

  private loadState(): void {
    try {
      if (!fs.existsSync(this.statePath)) return
      const raw = fs.readFileSync(this.statePath, 'utf-8')
      const parsed = JSON.parse(raw) as PersistedState
      for (const entry of parsed.pending || []) {
        this.pending.set(`${entry.srcChainId}:${entry.txHash.toLowerCase()}`, entry)
      }
      console.log(`[CCTPRelayer] state loaded: ${this.pending.size} pending`)
    } catch (err) {
      console.warn('[CCTPRelayer] failed to load state:', err)
    }
  }

  private persistState(): void {
    try {
      if (!fs.existsSync(STATE_DIR)) fs.mkdirSync(STATE_DIR, { recursive: true })
      const state: PersistedState = { pending: [...this.pending.values()] }
      fs.writeFileSync(this.statePath, JSON.stringify(state, null, 2))
    } catch (err) {
      console.warn('[CCTPRelayer] failed to persist state:', err)
    }
  }
}
