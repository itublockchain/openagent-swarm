import * as fs from 'fs'
import * as path from 'path'
import { ethers } from 'ethers'
import { getChainClient, USDC_DECIMALS } from './v1/chain'

/**
 * Watches USDCGateway.Deposited events on Base Sepolia and mirrors them
 * into SwarmTreasury.balanceOf on 0G. The operator EOA holds the keys
 * for both writes — getChainClient() owns the wallets.
 *
 * Idempotency: every processed event is keyed by `${txHash}:${logIndex}`
 * and persisted to disk. On boot we scan from `lastProcessedBlock - 5`
 * (a small overlap to catch reorgs / missed events) up to the current
 * head, then switch to a real-time `provider.on('block')` poll for
 * incremental events. We don't use eth_subscribe because the Base
 * Sepolia public RPC sometimes drops it; polling is robust and the
 * trickle of deposit events doesn't justify the complexity.
 */

const STATE_DIR = process.env.BRIDGE_STATE_DIR || '/data'
const STATE_FILE = 'bridge-watcher.json'
const POLL_INTERVAL_MS = 12_000 // Base block time ~2s; 12s = 6 blocks behind, fine for UX
const REORG_OVERLAP_BLOCKS = 5

interface PersistedState {
  lastProcessedBlock: number
  processedKeys: string[]
}

export class BridgeWatcher {
  private lastProcessedBlock = 0
  private processedKeys = new Set<string>()
  private timer: NodeJS.Timeout | null = null
  private statePath: string
  private inFlight = false

  constructor() {
    this.statePath = path.join(STATE_DIR, STATE_FILE)
  }

  /** Boot: load persisted state, then run a single catch-up pass and
   *  schedule the periodic poll. Safe to call repeatedly — second call
   *  is a no-op while the first poll is in flight. */
  async start(): Promise<void> {
    const client = getChainClient()
    if (!client.gatewayAddr || !client.readGateway) {
      console.warn('[BridgeWatcher] gateway address missing — bridge disabled')
      return
    }
    if (!client.writeTreasury) {
      console.warn('[BridgeWatcher] PRIVATE_KEY missing — bridge disabled (read-only)')
      return
    }

    this.loadState()

    // First-time boot: start at the gateway's current head instead of
    // scanning unbounded history. Any pre-existing deposits would have
    // been credited already; restart-time backfill is the only thing
    // we need to handle here.
    if (this.lastProcessedBlock === 0) {
      try {
        const head = await client.baseProvider.getBlockNumber()
        this.lastProcessedBlock = Math.max(0, head - 1)
        console.log(`[BridgeWatcher] First-run init: starting at block ${this.lastProcessedBlock}`)
        this.persistState()
      } catch (err) {
        console.error('[BridgeWatcher] failed to read base head; will retry on next tick:', err)
      }
    }

    console.log(
      `[BridgeWatcher] starting; gateway=${client.gatewayAddr} treasury=${client.treasuryAddr} fromBlock=${this.lastProcessedBlock}`,
    )

    // Run an initial catch-up immediately, then poll on interval.
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

  private async tick(): Promise<void> {
    if (this.inFlight) return
    this.inFlight = true
    try {
      const client = getChainClient()
      const head = await client.baseProvider.getBlockNumber()
      const fromBlock = Math.max(0, this.lastProcessedBlock - REORG_OVERLAP_BLOCKS)
      const toBlock = head
      if (fromBlock > toBlock) return

      const filter = client.readGateway.filters.Deposited()
      const events = await client.readGateway.queryFilter(filter, fromBlock, toBlock)
      for (const event of events) {
        await this.processEvent(event as ethers.EventLog)
      }
      // Advance the cursor only after we successfully processed everything.
      this.lastProcessedBlock = toBlock
      this.persistState()
    } finally {
      this.inFlight = false
    }
  }

  private async processEvent(event: ethers.EventLog): Promise<void> {
    const key = `${event.transactionHash}:${event.index}`
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
        `[BridgeWatcher] Credited ${ethers.formatUnits(amount, USDC_DECIMALS)} USDC to ${user} (base tx ${event.transactionHash.slice(0, 12)}, og tx ${ogTxHash.slice(0, 12)})`,
      )
      this.processedKeys.add(key)
    } catch (err) {
      console.error(`[BridgeWatcher] creditBalance failed for ${key}:`, err)
      // Don't add to processedKeys — next tick will retry. Re-throw so the
      // caller logs `tick failed` but doesn't advance lastProcessedBlock.
      throw err
    }
  }

  private loadState(): void {
    try {
      if (!fs.existsSync(this.statePath)) return
      const raw = fs.readFileSync(this.statePath, 'utf-8')
      const parsed = JSON.parse(raw) as PersistedState
      this.lastProcessedBlock = parsed.lastProcessedBlock || 0
      this.processedKeys = new Set(parsed.processedKeys || [])
      console.log(
        `[BridgeWatcher] state loaded: lastBlock=${this.lastProcessedBlock} processedKeys=${this.processedKeys.size}`,
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
        lastProcessedBlock: this.lastProcessedBlock,
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
