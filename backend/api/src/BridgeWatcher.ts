import * as fs from 'fs'
import * as path from 'path'
import { ethers } from 'ethers'
import { getChainClient, USDC_DECIMALS } from './v1/chain'

/**
 * Watches `Deposited` events on Base Sepolia from BOTH the legacy
 * USDCGateway (direct deposits) and the CCTPDepositReceiver (cross-chain
 * USDC mints relayed in via Circle CCTP V2). Both contracts emit the
 * exact same event signature, so a single ABI parses both — what differs
 * is which contract address the event came from. We mirror each into
 * SwarmTreasury.balanceOf on 0G.
 *
 * Idempotency: every processed event is keyed by
 *   `${contractAddress}:${txHash}:${logIndex}`
 * and persisted to disk. Per-contract block cursors so adding a new
 * watch source (e.g., another receiver in the future) doesn't reset
 * the others. Old single-cursor state is auto-migrated on first load.
 *
 * On boot we scan from `lastProcessedBlock - 5` (a small overlap to
 * catch reorgs / missed events) up to the current head, then poll every
 * 12s for incremental events. eth_subscribe is avoided because the Base
 * Sepolia public RPC sometimes drops it; polling is robust and the
 * trickle of deposit events doesn't justify the complexity.
 */

const STATE_DIR = process.env.BRIDGE_STATE_DIR || '/data'
const STATE_FILE = 'bridge-watcher.json'
const POLL_INTERVAL_MS = 12_000 // Base block time ~2s; 12s = 6 blocks behind, fine for UX
const REORG_OVERLAP_BLOCKS = 5

type WatchSource = {
  label: string
  address: string
  contract: ethers.Contract
  fallbackStartBlock: number
}

interface PersistedState {
  /** address (lowercase) → last processed block. */
  lastProcessedBlockByContract: Record<string, number>
  /** `${address}:${txHash}:${logIndex}` */
  processedKeys: string[]
  /** Legacy single-cursor field — migrated on load. */
  lastProcessedBlock?: number
}

export class BridgeWatcher {
  private lastProcessedBlockByContract: Record<string, number> = {}
  private processedKeys = new Set<string>()
  private timer: NodeJS.Timeout | null = null
  private statePath: string
  private inFlight = false
  private sources: WatchSource[] = []

  constructor() {
    this.statePath = path.join(STATE_DIR, STATE_FILE)
  }

  /** Boot: load persisted state, then run a single catch-up pass and
   *  schedule the periodic poll. Safe to call repeatedly — second call
   *  is a no-op while the first poll is in flight. */
  async start(): Promise<void> {
    const client = getChainClient()
    if (!client.writeTreasury) {
      console.warn('[BridgeWatcher] PRIVATE_KEY missing — bridge disabled (read-only)')
      return
    }

    const head = await client.baseProvider.getBlockNumber().catch(() => 0)

    if (client.gatewayAddr && client.readGateway) {
      this.sources.push({
        label: 'USDCGateway',
        address: client.gatewayAddr.toLowerCase(),
        contract: client.readGateway,
        fallbackStartBlock: Math.max(0, head - 1),
      })
    }
    if (client.cctpReceiverAddr && client.readCctpReceiver) {
      this.sources.push({
        label: 'CCTPDepositReceiver',
        address: client.cctpReceiverAddr.toLowerCase(),
        contract: client.readCctpReceiver,
        // Receiver was deployed at a known block — start there so we
        // don't miss any mints that landed before this watcher booted.
        fallbackStartBlock: client.cctpReceiverDeployBlock || Math.max(0, head - 1),
      })
    }

    if (this.sources.length === 0) {
      console.warn('[BridgeWatcher] no watch sources configured — bridge disabled')
      return
    }

    this.loadState()

    // First-time init per source: pin the cursor so we don't scan
    // unbounded history. Existing entries are kept as-is.
    for (const src of this.sources) {
      if (this.lastProcessedBlockByContract[src.address] == null) {
        this.lastProcessedBlockByContract[src.address] = src.fallbackStartBlock
        console.log(
          `[BridgeWatcher] First-run init for ${src.label} @ ${src.address}: starting at block ${src.fallbackStartBlock}`,
        )
      }
    }
    this.persistState()

    console.log(
      `[BridgeWatcher] starting; sources=[${this.sources
        .map(s => `${s.label}@${s.address.slice(0, 10)}…(block ${this.lastProcessedBlockByContract[s.address]})`)
        .join(', ')}] treasury=${client.treasuryAddr}`,
    )

    await this.tick().catch(err => console.error('[BridgeWatcher] initial tick failed:', err))
    this.timer = setInterval(() => {
      this.tick().catch(err => console.error('[BridgeWatcher] tick failed:', err))
    }, POLL_INTERVAL_MS)
    if (typeof this.timer.unref === 'function') this.timer.unref()
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  /** Look up whether a specific deposit event was already credited.
   *  Used by /v1/cctp/status to surface the final 0G credit step. */
  hasProcessed(contractAddress: string, txHash: string): boolean {
    const addr = contractAddress.toLowerCase()
    for (const key of this.processedKeys) {
      if (key.startsWith(`${addr}:${txHash.toLowerCase()}:`)) return true
    }
    return false
  }

  private async tick(): Promise<void> {
    if (this.inFlight) return
    this.inFlight = true
    try {
      const client = getChainClient()
      const head = await client.baseProvider.getBlockNumber()

      for (const src of this.sources) {
        const cursor = this.lastProcessedBlockByContract[src.address] ?? src.fallbackStartBlock
        const fromBlock = Math.max(0, cursor - REORG_OVERLAP_BLOCKS)
        const toBlock = head
        if (fromBlock > toBlock) continue

        const filter = src.contract.filters.Deposited()
        const events = await src.contract.queryFilter(filter, fromBlock, toBlock)
        for (const event of events) {
          await this.processEvent(src.label, src.address, event as ethers.EventLog)
        }
        this.lastProcessedBlockByContract[src.address] = toBlock
      }
      this.persistState()
    } finally {
      this.inFlight = false
    }
  }

  private async processEvent(
    label: string,
    contractAddress: string,
    event: ethers.EventLog,
  ): Promise<void> {
    const key = `${contractAddress}:${event.transactionHash.toLowerCase()}:${event.index}`
    if (this.processedKeys.has(key)) return

    const args = event.args ?? ([] as any)
    const user = args[0] as string | undefined
    const amount = args[1] as bigint | undefined
    if (!user || amount === undefined) {
      console.warn(`[BridgeWatcher] malformed Deposited event ${key} — skipping`)
      return
    }

    const client = getChainClient()
    if (!client.writeTreasury) {
      throw new Error('writeTreasury missing — operator wallet went away after start')
    }

    try {
      const tx = await client.writeTreasury.creditBalance(user, amount)
      const receipt = await tx.wait()
      const ogTxHash = receipt?.hash ?? tx.hash
      console.log(
        `[BridgeWatcher] ${label}: credited ${ethers.formatUnits(amount, USDC_DECIMALS)} USDC to ${user} (base tx ${event.transactionHash.slice(0, 12)}, og tx ${ogTxHash.slice(0, 12)})`,
      )
      this.processedKeys.add(key)
    } catch (err) {
      console.error(`[BridgeWatcher] creditBalance failed for ${key}:`, err)
      throw err
    }
  }

  private loadState(): void {
    try {
      if (!fs.existsSync(this.statePath)) return
      const raw = fs.readFileSync(this.statePath, 'utf-8')
      const parsed = JSON.parse(raw) as PersistedState

      this.lastProcessedBlockByContract = parsed.lastProcessedBlockByContract || {}
      this.processedKeys = new Set(parsed.processedKeys || [])

      // Migrate legacy single-cursor field. The pre-CCTP watcher had a
      // single `lastProcessedBlock` that always referred to the gateway —
      // map it onto the gateway address and drop the old field.
      if (parsed.lastProcessedBlock != null && Object.keys(this.lastProcessedBlockByContract).length === 0) {
        const client = getChainClient()
        if (client.gatewayAddr) {
          const addr = client.gatewayAddr.toLowerCase()
          this.lastProcessedBlockByContract[addr] = parsed.lastProcessedBlock
          console.log(`[BridgeWatcher] migrated legacy cursor → ${addr}@${parsed.lastProcessedBlock}`)
        }
      }

      // Migrate legacy dedupe keys (no contract address prefix). They
      // can't be retroactively classified, so we just keep them — old
      // events won't re-emit anyway since the cursor has moved past them.

      console.log(
        `[BridgeWatcher] state loaded: cursors=${JSON.stringify(this.lastProcessedBlockByContract)} processedKeys=${this.processedKeys.size}`,
      )
    } catch (err) {
      console.warn('[BridgeWatcher] failed to load state, starting fresh:', err)
    }
  }

  private persistState(): void {
    try {
      if (!fs.existsSync(STATE_DIR)) {
        fs.mkdirSync(STATE_DIR, { recursive: true })
      }
      const state: PersistedState = {
        lastProcessedBlockByContract: this.lastProcessedBlockByContract,
        // Cap the persisted set so it doesn't grow unbounded. Keys older
        // than the current cursor minus 1000 blocks can't be re-emitted
        // by the catch-up scan, so dropping them is safe.
        processedKeys: [...this.processedKeys].slice(-2000),
      }
      fs.writeFileSync(this.statePath, JSON.stringify(state, null, 2))
    } catch (err) {
      console.warn('[BridgeWatcher] failed to persist state:', err)
    }
  }
}
