import * as fs from 'fs'
import * as path from 'path'
import { ethers } from 'ethers'
import { getChainClient, USDC_DECIMALS } from './v1/chain'
import type { ColonyStore } from './v1/colonyStore'
import type { TaskStateStore } from './v1/taskStateStore'
import type { AgentManager } from './AgentRunner'
import type { INetworkPort } from '../../../shared/ports'
import { EventType } from '../../../shared/types'

/**
 * Watches `Slashed(taskId, agent, amount)` events on `SwarmEscrow` (0G)
 * and tears down the affected agent's colony memberships. Without this,
 * an agent that fails (or is challenged on) a colony task keeps pulling
 * future colony-scoped tasks because its membership row in
 * `colony_members` is never updated.
 *
 * Pipeline:
 *   1. Poll SwarmEscrow.Slashed every POLL_INTERVAL_MS (eth_subscribe is
 *      avoided for the same reason as BridgeWatcher — public RPCs drop it).
 *   2. For each fresh event, resolve `agent` (EVM address) → local
 *      `agentId` via AgentManager. Slashed agents managed by another
 *      operator have no local secret; we no-op those (their colony
 *      memberships, if any, live in their operator's SQLite).
 *   3. Remove the agent from every colony it belonged to and broadcast
 *      a per-colony COLONY_MEMBERSHIP_CHANGED so peer agents drop the
 *      colony from `myColonies` immediately rather than waiting for the
 *      30s poll. Also emit a single SLASH_EXECUTED event for the
 *      explorer log panel (the frontend already has the icon/label
 *      mapping wired but no producer until now).
 *
 * Idempotency: each event is keyed by `${txHash}:${logIndex}` and
 * persisted; restart-safe. State file lives in BRIDGE_STATE_DIR alongside
 * the deposit watcher so all on-chain reconciliation state is in one place.
 *
 * On boot we pin the cursor at `head - 1` if there is no prior state,
 * matching BridgeWatcher's behaviour — we don't want to stream an
 * unbounded slash backlog into the colony layer because every member
 * was already removed manually before this watcher existed.
 */

const STATE_DIR = process.env.BRIDGE_STATE_DIR || '/data'
const STATE_FILE = 'slash-watcher.json'
const POLL_INTERVAL_MS = 12_000
// 0G block time is comparable to Base; 5 blocks of overlap covers
// short reorgs without re-emitting events the dedupe set already saw.
const REORG_OVERLAP_BLOCKS = 5

interface PersistedState {
  lastProcessedBlock: number
  /** `${txHash}:${logIndex}` */
  processedKeys: string[]
}

interface SlashWatcherDeps {
  colonyStore: ColonyStore
  /** Persistent DAG + slash mirror. SlashWatcher writes the slash record
   *  here AND flips the affected node's status to 'failed' so a deep-link
   *  reload after WS state evaporated still shows the red node + reason. */
  taskState: TaskStateStore
  manager: AgentManager
  network: INetworkPort
}

export class SlashWatcher {
  private lastProcessedBlock = 0
  private processedKeys = new Set<string>()
  private timer: NodeJS.Timeout | null = null
  private statePath: string
  private inFlight = false

  constructor(private deps: SlashWatcherDeps) {
    this.statePath = path.join(STATE_DIR, STATE_FILE)
  }

  async start(): Promise<void> {
    const client = getChainClient()
    if (!client.readEscrow) {
      console.warn('[SlashWatcher] readEscrow missing — disabled')
      return
    }

    const head = await client.ogProvider.getBlockNumber().catch(() => 0)
    this.loadState()
    if (this.lastProcessedBlock === 0) {
      this.lastProcessedBlock = Math.max(0, head - 1)
      this.persistState()
      console.log(`[SlashWatcher] First-run init: pinning cursor at block ${this.lastProcessedBlock}`)
    }

    console.log(
      `[SlashWatcher] starting; escrow=${client.escrowAddr} cursor=${this.lastProcessedBlock}`,
    )

    await this.tick().catch(err => console.error('[SlashWatcher] initial tick failed:', err))
    this.timer = setInterval(() => {
      this.tick().catch(err => console.error('[SlashWatcher] tick failed:', err))
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
      const head = await client.ogProvider.getBlockNumber()
      const fromBlock = Math.max(0, this.lastProcessedBlock - REORG_OVERLAP_BLOCKS)
      const toBlock = head
      if (fromBlock > toBlock) return

      const filter = client.readEscrow.filters.Slashed()
      const events = await client.readEscrow.queryFilter(filter, fromBlock, toBlock)
      for (const event of events) {
        await this.processEvent(event as ethers.EventLog)
      }
      this.lastProcessedBlock = toBlock
      this.persistState()
    } finally {
      this.inFlight = false
    }
  }

  private async processEvent(event: ethers.EventLog): Promise<void> {
    const key = `${event.transactionHash.toLowerCase()}:${event.index}`
    if (this.processedKeys.has(key)) return

    const args = event.args ?? ([] as any)
    const taskId = args[0] as string | undefined
    const agentAddr = args[1] as string | undefined
    const amount = args[2] as bigint | undefined
    if (!agentAddr) {
      console.warn(`[SlashWatcher] malformed Slashed event ${key} — skipping`)
      this.processedKeys.add(key)
      this.persistState()
      return
    }

    // Mark + persist before any side effects so a crash mid-processing
    // doesn't replay the colony removal (idempotent at the SQLite layer
    // anyway, but the AXL re-broadcast would spam peers).
    this.processedKeys.add(key)
    this.persistState()

    const agentId = this.deps.manager.findAgentIdByAddress(agentAddr)

    // Best-effort node correlation. The Slashed event doesn't carry a
    // nodeId — we infer it from the DAG by which node this agent was
    // claiming. findNodeByAgent returns null when the agent claimed
    // multiple nodes (rare), in which case the slash is recorded
    // task-level and the UI shows a generic banner instead of a per-node
    // overlay.
    const nodeId =
      taskId && agentId ? this.deps.taskState.findNodeByAgent(taskId, agentId) : null

    // Reason inference: pull the matching CHALLENGE event's reason if
    // there is one. Slashes that bypass challenges (e.g. direct vault
    // execution after a peer-validation failure) fall through to a
    // generic 'on_chain_slash' so the row never has an empty string.
    const reason =
      taskId && nodeId
        ? this.deps.taskState.getLastChallengeReason(taskId, nodeId) ?? 'on_chain_slash'
        : 'on_chain_slash'

    const formattedAmount =
      amount !== undefined ? ethers.formatUnits(amount, USDC_DECIMALS) : '0'

    if (taskId) {
      try {
        this.deps.taskState.recordSlash({
          taskId,
          nodeId,
          agentId,
          agentAddress: agentAddr,
          amount: formattedAmount,
          reason,
          txKey: key,
        })
      } catch (err) {
        console.warn('[SlashWatcher] taskState.recordSlash failed:', err)
      }

      // Flip the affected node's status to 'failed' so deep-link reloads
      // (which read taskState.getDag) repaint the slashed node red even
      // after the WS state buffer drained. Skipped when nodeId couldn't
      // be inferred — rather not corrupt a healthy DAG row than guess.
      if (nodeId) {
        try {
          this.deps.taskState.setStatus(taskId, nodeId, { status: 'failed' })
        } catch (err) {
          console.warn('[SlashWatcher] taskState.setStatus failed:', err)
        }
      }
    }

    if (!agentId) {
      // Slashed agent belongs to a different operator (or its secret was
      // already purged). No local colony membership to clean up — slash
      // is still persisted + broadcast above, surface SLASH_EXECUTED for
      // explorer transparency.
      console.log(
        `[SlashWatcher] Slashed ${agentAddr} (task ${taskId?.slice(0, 12) ?? '?'}) — no local agent secret, skipping colony cleanup`,
      )
      await this.broadcastSlashExecuted({
        taskId,
        nodeId,
        agentId: null,
        agentAddr,
        amount,
        reason,
        removedFromColonies: [],
      })
      return
    }

    const removedColonies = this.deps.colonyStore.removeAgentFromAllColonies(agentId)
    console.log(
      `[SlashWatcher] Slashed agent ${agentId} (${agentAddr}) amount=${formattedAmount} task=${taskId?.slice(0, 12) ?? '?'} node=${nodeId ?? '?'} reason=${reason} removed_from=[${removedColonies.join(', ') || '(none)'}]`,
    )

    // Per-colony broadcast lets each member agent's local `myColonies`
    // set drop this id immediately. SwarmAgent's
    // COLONY_MEMBERSHIP_CHANGED handler ignores events whose payload
    // agentId doesn't match its own, so only the slashed agent (if it's
    // still running anywhere) reacts. The 30s repoll is the fallback
    // path if the AXL emit fails.
    for (const colonyId of removedColonies) {
      await this.deps.network
        .emit({
          type: EventType.COLONY_MEMBERSHIP_CHANGED,
          payload: { colonyId, agentId, change: 'removed' },
          timestamp: Date.now(),
          agentId: 'api-server',
        })
        .catch(err => console.warn('[SlashWatcher] membership broadcast failed:', err))
    }

    await this.broadcastSlashExecuted({
      taskId,
      nodeId,
      agentId,
      agentAddr,
      amount,
      reason,
      removedFromColonies: removedColonies,
    })
  }

  private async broadcastSlashExecuted(opts: {
    taskId: string | undefined
    nodeId: string | null
    agentId: string | null
    agentAddr: string
    amount: bigint | undefined
    reason: string
    removedFromColonies: string[]
  }): Promise<void> {
    await this.deps.network
      .emit({
        type: EventType.SLASH_EXECUTED,
        payload: {
          taskId: opts.taskId,
          nodeId: opts.nodeId,
          agentId: opts.agentId,
          agentAddress: opts.agentAddr,
          amount: opts.amount?.toString() ?? '0',
          reason: opts.reason,
          removedFromColonies: opts.removedFromColonies,
        },
        timestamp: Date.now(),
        agentId: 'api-server',
      })
      .catch(err => console.warn('[SlashWatcher] SLASH_EXECUTED broadcast failed:', err))
  }

  private loadState(): void {
    try {
      if (!fs.existsSync(this.statePath)) return
      const raw = fs.readFileSync(this.statePath, 'utf-8')
      const parsed = JSON.parse(raw) as PersistedState
      this.lastProcessedBlock = parsed.lastProcessedBlock || 0
      this.processedKeys = new Set(parsed.processedKeys || [])
      console.log(
        `[SlashWatcher] state loaded: cursor=${this.lastProcessedBlock} processedKeys=${this.processedKeys.size}`,
      )
    } catch (err) {
      console.warn('[SlashWatcher] failed to load state, starting fresh:', err)
    }
  }

  private persistState(): void {
    try {
      if (!fs.existsSync(STATE_DIR)) {
        fs.mkdirSync(STATE_DIR, { recursive: true })
      }
      const state: PersistedState = {
        lastProcessedBlock: this.lastProcessedBlock,
        // Cap so the file doesn't grow unbounded; REORG_OVERLAP_BLOCKS
        // bounds how far back we'd ever re-scan.
        processedKeys: [...this.processedKeys].slice(-50_000),
      }
      fs.writeFileSync(this.statePath, JSON.stringify(state, null, 2))
    } catch (err) {
      console.warn('[SlashWatcher] failed to persist state:', err)
    }
  }
}
