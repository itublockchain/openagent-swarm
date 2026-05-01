import { Wallet, randomBytes, hexlify, parseUnits, solidityPackedKeccak256, id as keccakId } from 'ethers'
import { IStoragePort, IComputePort, INetworkPort, IChainPort } from '../../../shared/ports'
import { EventType, DAGNode, AgentConfig, AXLEvent } from '../../../shared/types'
import { runAgentLoop } from './agentLoop'
import { JsonAgentFormat } from './agentFormat'
import { TOOLS } from './tools/definitions'
import { REACT_SYSTEM_PROMPT } from './prompts/react'

/**
 * Storage may hold either the new structured payload (post tool-aware loop)
 * or a legacy plain-string output. Coerce to a single readable string for
 * judge() / context propagation.
 */
function extractFinal(stored: unknown): string {
  if (stored == null) return ''
  if (typeof stored === 'string') return stored
  if (typeof stored === 'object') {
    const obj = stored as any
    if (typeof obj.finalAnswer === 'string') return obj.finalAnswer
    return JSON.stringify(stored).slice(0, 4000)
  }
  return String(stored)
}

export interface AgentDeps {
  storage: IStoragePort
  compute: IComputePort
  network: INetworkPort
  chain: IChainPort
  config: AgentConfig
}

export class SwarmAgent {
  // taskId → { nodes, taskId, plannerAgentId }
  private tasks = new Map<string, { nodes: DAGNode[], taskId: string, plannerAgentId?: string }>()
  private currentTaskId: string | null = null
  private lastActivity: number = Date.now()
  // Track which tasks this agent is planner for (keeper responsibility)
  private plannerFor = new Set<string>()
  // nodeId-keyed reentrancy guard for executeSubtask. Multiple paths can
  // race into execution for the same node (SUBTASK_DONE re-entry, fallback
  // timer, watchdog, AXL gossip-loopback) — without this, the second path
  // re-stakes a node that's already mid-flight and the contract reverts
  // with "Already staked". Cleared in the finally block.
  private inflightSubtasks = new Set<string>()
  // Commit-reveal jury state. Holds the salt + verdict between the commit
  // tx and the scheduled reveal tx (~30 min later). In-memory only — a
  // process restart between phases forfeits this juror's vote.
  private pendingReveals = new Map<string, {
    taskId: string
    accusedGuilty: boolean
    salt: string
    revealAt: number
  }>()

  constructor(private deps: AgentDeps) { }

  public async start(): Promise<void> {
    this.deps.network.on(EventType.TASK_SUBMITTED, (event) => {
      this.onTaskSubmitted(event)
    })
    this.deps.network.on(EventType.TASK_REOPENED, (event) => {
      this.onTaskReopened(event)
    })
    this.deps.network.on(EventType.DAG_READY, (event) => {
      this.onDAGReady(event)
    })

    // --- Synchronization listeners (shared state) ---
    this.deps.network.on(EventType.PLANNER_SELECTED, (event) => {
      const { taskId, agentId } = event.payload as any
      if (agentId !== this.deps.config.agentId) {
        this.deps.chain.syncPlannerClaim(taskId, agentId)
      }
    })

    this.deps.network.on(EventType.SUBTASK_CLAIMED, (event) => {
      const { nodeId, agentId, taskId } = event.payload as any
      if (agentId !== this.deps.config.agentId) {
        console.log(`[Agent ${this.deps.config.agentId}] sync: subtask ${nodeId} claimed by ${agentId}`)
        this.deps.chain.syncSubtaskClaim(nodeId, agentId)

        // Track who owns the slot in our local cache so the SUBTASK_DONE
        // dispatch knows whether to fire executeSubtask for this node when
        // prev finishes (it shouldn't, since the peer holds it).
        const task = this.tasks.get(taskId)
        if (task) {
          const node = task.nodes.find(n => n.id === nodeId)
          if (node) {
            node.status = 'claimed'
            node.claimedBy = agentId
          }
        }
      }
    })

    this.deps.network.on(EventType.SUBTASK_DONE, (event) => {
      const { nodeId, outputHash, taskId } = event.payload as any
      if (taskId === this.currentTaskId) {
        this.lastActivity = Date.now()
      }
      const task = this.tasks.get(taskId)
      if (!task) return

      const doneIndex = task.nodes.findIndex(n => n.id === nodeId)
      const doneNode = task.nodes[doneIndex]
      if (doneNode) {
        doneNode.status = 'done'
        doneNode.outputHash = outputHash
      }

      // Critical for parallel-claim/sequential-execute: lift the next node's
      // prevHash from "placeholder-..." to the real outputHash so any agent
      // (including the one holding the claim) can now execute it. Without
      // this update, a peer who pre-claimed node-2 has no way to know prev
      // is ready.
      const nextNode = task.nodes[doneIndex + 1]
      if (nextNode && nextNode.prevHash && nextNode.prevHash.includes('placeholder-')) {
        nextNode.prevHash = outputHash
      }

      // Deferred-execute dispatch: if WE pre-claimed the next node and were
      // waiting on prev, now's the time to run it.
      if (
        nextNode &&
        nextNode.claimedBy === this.deps.config.agentId &&
        nextNode.status === 'claimed'
      ) {
        console.log(`[Agent ${this.deps.config.agentId}] prev done, dispatching held claim ${nextNode.id}`)
        this.executeSubtask(nextNode, taskId).catch(err =>
          console.error(`[Agent ${this.deps.config.agentId}] deferred execute error:`, err),
        )
      }

      // Always try to claim more — a slot we passed on earlier (prev not
      // ready, network blip) might be takeable now.
      this.claimFirstAvailable(taskId).catch(() => { })
    })

    // Track peer validations so the next worker can skip its own judge()
    // call. Saves ~5-10s per node when a peer has already accepted the
    // previous output as context.
    this.deps.network.on(EventType.SUBTASK_PEER_VALIDATED, (event) => {
      const { nodeId, taskId } = event.payload as any
      const task = this.tasks.get(taskId)
      if (!task) return
      const node = task.nodes.find(n => n.id === nodeId)
      if (node) node.peerValidated = true
    })

    this.deps.network.on(EventType.SUBTASK_VALIDATED, (event) => {
      const { nodeId, taskId } = event.payload as any
      const task = this.tasks.get(taskId)
      if (!task) return
      const node = task.nodes.find(n => n.id === nodeId)
      if (node) node.peerValidated = true
    })

    this.deps.network.on(EventType.CHALLENGE, (event) => {
      this.onChallengeRaised(event).catch(err =>
        console.error(`[Agent ${this.deps.config.agentId}] juror flow error:`, err),
      )
    })

    this.deps.network.on(EventType.DAG_COMPLETED, async (event) => {
      const { taskId, agentId, lastNodeId, lastOutputHash, needsPlannerValidation, settled } = event.payload as any
      console.log(`[Agent ${this.deps.config.agentId}] Received DAG_COMPLETED for ${taskId} from ${agentId || event.agentId}`)

      // Planner keeper sorumluluğu: Başka bir agent son node'u tamamladıysa,
      // planner olarak son çıktıyı denetle
      if (needsPlannerValidation && this.plannerFor.has(taskId) && event.agentId !== this.deps.config.agentId) {
        console.log(`[Agent ${this.deps.config.agentId}] KEEPER: Received last node for validation`)
        await this.validateLastNodeAsPlanner(lastNodeId, lastOutputHash, taskId)
        return
      }

      this.deps.chain.syncTaskCompletion(taskId, agentId || event.agentId)

      // task bitti, boşa çık
      if (this.currentTaskId === taskId) {
        console.log(`[Agent ${this.deps.config.agentId}] Resetting busy state for task ${taskId}`)
        this.currentTaskId = null
        this.tasks.delete(taskId)
        this.plannerFor.delete(taskId)
      }
    })

    console.log(`[Agent ${this.deps.config.agentId}] started and listening for ALL events`)

    this.startSurplusWatchdog()
  }

  /**
   * Periodically forward USDC earned above the configured stakeAmount back
   * to the owner's wallet. The check is balance > stakeWei; when an agent is
   * mid-task its 10% subtask stake is locked in escrow so balance briefly
   * dips BELOW stakeWei, naturally preventing a sweep mid-flight. After
   * settlement the released stake + reward push balance above stakeWei and
   * the next tick forwards the surplus.
   *
   * Disabled when ownerAddress is missing (no recipient) or the chain
   * adapter doesn't support balance/transfer (Mock).
   */
  private startSurplusWatchdog(): void {
    const owner = this.deps.config.ownerAddress
    const id = this.deps.config.agentId
    if (!owner) {
      console.log(`[Agent ${id}] surplus sweep disabled (no ownerAddress)`)
      return
    }
    if (
      typeof this.deps.chain.getOwnUsdcBalance !== 'function' ||
      typeof this.deps.chain.transferUsdc !== 'function'
    ) {
      console.log(`[Agent ${id}] surplus sweep disabled (chain adapter lacks USDC methods)`)
      return
    }

    // mUSDC ships at 18 decimals (default OZ ERC20). If the deployment ever
    // pins a different value, override via env or extend AgentConfig.
    const USDC_DECIMALS = 18
    let stakeWei: bigint
    try {
      stakeWei = parseUnits(this.deps.config.stakeAmount || '0', USDC_DECIMALS)
    } catch (err) {
      console.warn(`[Agent ${id}] surplus sweep disabled — bad stakeAmount "${this.deps.config.stakeAmount}":`, err)
      return
    }

    const SWEEP_INTERVAL_MS = 60_000
    const tick = async () => {
      try {
        const balanceStr = await this.deps.chain.getOwnUsdcBalance!()
        const balance = BigInt(balanceStr)
        if (balance <= stakeWei) return
        const surplus = balance - stakeWei
        console.log(`[Agent ${id}] sweeping surplus ${surplus.toString()} wei → ${owner}`)
        const txHash = await this.deps.chain.transferUsdc!(owner, surplus.toString())
        console.log(`[Agent ${id}] surplus payout tx ${txHash}`)
      } catch (err) {
        console.warn(`[Agent ${id}] surplus sweep tick failed:`, err)
      }
    }

    const timer = setInterval(tick, SWEEP_INTERVAL_MS)
    if (typeof timer.unref === 'function') timer.unref()
    console.log(`[Agent ${id}] surplus sweep running every ${SWEEP_INTERVAL_MS / 1000}s, owner=${owner}, floor=${stakeWei.toString()} wei`)
  }

  private isBusyWithTimeout(newTaskId: string): boolean {
    if (!this.currentTaskId) return false
    if (this.currentTaskId === newTaskId) return false

    // 15 saniye sessizlik varsa meşgul sayılma (timeout)
    const silentDuration = Date.now() - this.lastActivity
    if (silentDuration > 15000) {
      console.log(`[Agent ${this.deps.config.agentId}] Previous task ${this.currentTaskId} timed out (${Math.round(silentDuration / 1000)}s silent). Resetting.`)
      // Drop the stale local cache too — leaving it in this.tasks lets a
      // late SUBTASK_DONE / SUBTASK_PEER_VALIDATED event for the abandoned
      // task re-enter dispatch logic and try to operate on its old node list.
      const stale = this.currentTaskId
      this.tasks.delete(stale)
      this.plannerFor.delete(stale)
      this.currentTaskId = null
      return false
    }

    return true
  }

  private async onTaskSubmitted(event: AXLEvent<any>): Promise<void> {
    try {
      const taskId = event.payload.taskId

      if (this.isBusyWithTimeout(taskId)) {
        console.log(`[Agent ${this.deps.config.agentId}] busy with ${this.currentTaskId}, ignoring ${taskId}`)
        return
      }

      this.lastActivity = Date.now()
      // Plancı olmak için niyetini belli et
      await this.deps.network.emit(this.buildEvent(EventType.PLANNER_SELECTED, { agentId: this.deps.config.agentId, taskId }))

      // Race directly. The PLANNER_SELECTED gossip + on-chain FCFS are
      // the actual coordination — the previous 1s sleep was meant to give
      // peers a head start but only added dead time to every task. The
      // first-write-wins claimPlanner contract call already handles ties.
      const claimed = await this.deps.chain.claimPlanner(taskId)
      if (claimed) {
        this.currentTaskId = taskId
        console.log(`[Agent ${this.deps.config.agentId}] WON planner race. Acting as planner.`)
        await this.runAsPlanner(event)
      } else {
        // Lost the race. The planner address is on-chain at planners[taskId];
        // the previous "chosenPlanner" log read a MockChain-only field via
        // `as any` and printed our own id on real chain — misleading. Skip.
        console.log(`[Agent ${this.deps.config.agentId}] LOST planner race. Acting as worker.`)
      }
    } catch (err) {
      console.error(`[Agent ${this.deps.config.agentId}] onTaskSubmitted error:`, err)
    }
  }

  private async runAsPlanner(event: AXLEvent<any>): Promise<void> {
    try {
      const { taskId, spec } = event.payload
      const agentId = this.deps.config.agentId
      console.log(`[Agent ${agentId}] PLANNER for task ${taskId}`)

      const nodes = await this.deps.compute.buildDAG(spec)

      // Storage append is content-addressed and idempotent — fire-and-forget
      // it via appendDeferred so DAG_READY can emit ~30-40s sooner. The
      // hash isn't actually needed by anyone; readers go through outputHash
      // on-chain. We only run it for the audit trail.
      if (typeof this.deps.storage.appendDeferred === 'function') {
        this.deps.storage.appendDeferred(nodes).then(r =>
          r.uploadPromise.catch(err => console.warn('[Planner] DAG metadata upload failed (non-fatal):', err)),
        ).catch(err => console.warn('[Planner] DAG metadata appendDeferred failed (non-fatal):', err))
      } else {
        // Legacy adapter path — still kick it off but don't await.
        this.deps.storage.append(nodes).catch(err =>
          console.warn('[Planner] DAG metadata append failed (non-fatal):', err),
        )
      }

      // Sequential: ethers v6 NonceManager has a known race when
      // sendTransaction calls overlap (delta is snapshotted before await,
      // so both calls observe the same pending nonce). Until we wrap it
      // with a mutex, fall back to sequential order. registerDAG first so
      // a revert there doesn't lock our stake (Fix 3).
      const nodeIds = nodes.map(n => n.id)
      await this.deps.chain.registerDAG(taskId, nodeIds)
      console.log(`[Agent ${agentId}] DAG registered on-chain with ${nodeIds.length} nodes`)
      await this.deps.chain.stake(taskId, this.deps.config.stakeAmount)

      // Mark planner responsibility BEFORE emitting DAG_READY. AxlNetwork.emit
      // schedules local handlers on the microtask queue; if onDAGReady runs
      // before this set is populated, claimFirstAvailable's `plannerFor.has()`
      // guard fails open and the planner ends up racing for its own node-1.
      this.plannerFor.add(taskId)
      this.tasks.set(taskId, { nodes, taskId, plannerAgentId: agentId })

      await this.deps.network.emit(this.buildEvent(EventType.DAG_READY, {
        nodes,
        taskId,
        plannerAgentId: agentId
      }))

      console.log(`[Agent ${agentId}] DAG_READY emitted, ${nodes.length} nodes`)

      // Single-agent fallback: if no peer claims any subtask within this
      // window, the planner self-claims its own DAG. Without this a one-agent
      // swarm hangs forever after DAG_READY (planners normally don't race for
      // their own subtasks because settlement double-pays them). Settlement
      // math still works — escrow happily pays the same address twice.
      // Trimmed from 30s — peers always race in <8s, the longer wait was
      // just demo dead time.
      const SINGLE_AGENT_FALLBACK_MS = 8_000
      setTimeout(async () => {
        const cached = this.tasks.get(taskId)
        if (!cached) return
        const anyClaimed = cached.nodes.some(n => n.status === 'claimed' || n.status === 'done')
        if (anyClaimed) return // peer is on it
        if (!this.plannerFor.has(taskId)) return
        console.log(`[Agent ${agentId}] single-agent fallback: no peer claimed in ${SINGLE_AGENT_FALLBACK_MS}ms, planner self-claiming`)
        await this.claimFirstAvailable(taskId, true, true).catch(err =>
          console.error(`[Agent ${agentId}] self-claim error:`, err),
        )
      }, SINGLE_AGENT_FALLBACK_MS)
    } catch (err) {
      console.error(`[Agent ${this.deps.config.agentId}] runAsPlanner FAILED:`, err)
    }
  }

  private async onDAGReady(event: AXLEvent<any>): Promise<void> {
    try {
      const { nodes, taskId } = event.payload

      if (this.isBusyWithTimeout(taskId)) {
        return
      }

      this.lastActivity = Date.now()
      // cache'e al ve sahiplen
      this.currentTaskId = taskId
      const plannerAgentId = event.payload.plannerAgentId
      this.tasks.set(taskId, { nodes, taskId, plannerAgentId })
      console.log(`[Agent ${this.deps.config.agentId}] DAG cached, trying first node`)
      // Skill-aware first pass — only race for nodes the agent's prompt
      // claims to be a fit for.
      await this.claimFirstAvailable(taskId, false)

      // Fallback: if this window passes with uncllaimed nodes, every agent
      // drops the skill filter and tries again. Prevents a DAG from
      // stalling when no one self-selected as a fit (e.g. very generic
      // prompts that all said NO, or a subtask domain no agent specialised in).
      // Trimmed from 30s — assess() responses arrive in 2-5s; 8s is plenty
      // of margin and shaves ~22s off any task that needs the fallback.
      const FALLBACK_MS = 8_000
      setTimeout(async () => {
        const task = this.tasks.get(taskId)
        if (!task) return // task already completed / abandoned
        if (this.currentTaskId !== taskId) return // we moved on
        const anyUnclaimed = task.nodes.some(n => n.status !== 'claimed' && n.status !== 'done')
        if (!anyUnclaimed) return
        console.log(`[Agent ${this.deps.config.agentId}] skill filter timed out — retrying without filter`)
        await this.claimFirstAvailable(taskId, true).catch(err => {
          console.error(`[Agent ${this.deps.config.agentId}] fallback claim error:`, err)
        })
      }, FALLBACK_MS)
    } catch (err) {
      console.error(`[Agent ${this.deps.config.agentId}] onDAGReady error:`, err)
    }
  }

  /**
   * Cheap one-token YES/NO probe gating subtask claims by the agent's own
   * system prompt. Returns true when the assessor LLM thinks the agent is
   * a good match, OR when no system prompt is set (generalist agents claim
   * everything by default), OR when `bypass=true` (fallback path).
   */
  private async fitsSkill(subtask: string, bypass: boolean): Promise<boolean> {
    if (bypass) return true
    const prompt = this.deps.config.systemPrompt
    if (!prompt || !prompt.trim()) return true
    try {
      return await this.deps.compute.assess(subtask, prompt)
    } catch (err) {
      console.warn(`[Agent ${this.deps.config.agentId}] assess error, claiming anyway:`, err)
      return true
    }
  }

  private async claimFirstAvailable(taskId: string, bypassSkill = false, allowSelfPlanner = false): Promise<void> {
    const task = this.tasks.get(taskId)
    if (!task) return

    // Role separation: the planner of this task is its keeper-validator and
    // does NOT race for its own subtasks. The settlement split (20% planner,
    // 80% workers) collapses to "planner takes everything" if the planner
    // also fills the worker slots — fine in a single-agent swarm but bad
    // when peers exist. Default: skip; only the single-agent fallback timer
    // passes allowSelfPlanner=true after waiting for peers.
    if (this.plannerFor.has(taskId) && !allowSelfPlanner) return

    // Balance-aware cap: a single agent (typically the planner during the
    // single-agent fallback) used to claim every node in the DAG, then run
    // out of USDC mid-execution because each subtask needs its own stake.
    // The mid-DAG ERC20InsufficientBalance revert left orphan claims that
    // peers couldn't recover. Cap upfront based on what we can actually
    // afford, leaving the rest for peers (or, if no peers, the next round
    // of fallback once stakes are released).
    //
    // CRITICAL: pass the *per-subtask* stake (10% of full stakeAmount, see
    // executeSubtask) to getStakeCapacity, NOT the full stakeAmount. The
    // earlier version passed the full amount and under-capped by 10x —
    // benign for 3-node demos but starves larger DAGs.
    const totalStakeNum = parseFloat(this.deps.config.stakeAmount || '100')
    const perSubtaskStakeStr = (totalStakeNum * 0.1).toString()
    let stakeCapacity = Number.MAX_SAFE_INTEGER
    if (typeof this.deps.chain.getStakeCapacity === 'function') {
      try {
        stakeCapacity = await this.deps.chain.getStakeCapacity(perSubtaskStakeStr)
      } catch {
        // unreadable balance → don't claim anything this round; let the
        // next pass try again rather than crash mid-execute.
        stakeCapacity = 0
      }
    }
    let claimedThisRound = 0

    // Pre-warm assess() in parallel for every candidate node. Without this,
    // fitsSkill runs sequentially inside the loop and an agent without a
    // systemPrompt returns instantly while a prompted agent waits 2-5s per
    // node — the promptless agent wins every race by structural advantage.
    // Running the probes concurrently means each agent pays one round-trip
    // of LLM latency total, regardless of prompt presence.
    const candidates = task.nodes.filter(
      n => n.status !== 'done' && n.status !== 'claimed',
    )
    const fitnessByNodeId = new Map<string, boolean>()
    const fitnessResults = await Promise.all(
      candidates.map(async n => [n.id, await this.fitsSkill(n.subtask, bypassSkill)] as const),
    )
    for (const [id, fits] of fitnessResults) fitnessByNodeId.set(id, fits)

    // Shuffle the iteration order. Walking task.nodes in fixed order makes
    // the marginally-fastest agent race for node-1 first, then node-2 etc.,
    // so every FCFS race resolves to the same winner. Shuffling means each
    // agent attempts a different node first — a 3-node DAG with 3 racers
    // naturally distributes claims across the swarm instead of collapsing
    // onto one greedy claimant.
    const shuffled = [...candidates]
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1))
      ;[shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]]
    }

    // Parallel claim, sequential execute: agents race to claim ALL eligible
    // nodes upfront (regardless of whether prev is done). Once a node is
    // claimed, the claimer waits for prev's SUBTASK_DONE — at which point
    // the listener wakes up and dispatches executeSubtask. This breaks the
    // single-agent-zincirleme bias of the old "claim only when prev is
    // ready" rule, since every node opens for FCFS the moment the DAG is
    // sealed.
    for (const node of shuffled) {
      if (claimedThisRound >= stakeCapacity) {
        console.log(
          `[Agent ${this.deps.config.agentId}] balance limit reached (${claimedThisRound}/${stakeCapacity} stakes), leaving rest for peers`,
        )
        break
      }
      // Status may have flipped during pre-warm — a peer claimed it while
      // we were waiting on assess().
      if (node.status === 'done' || node.status === 'claimed') continue

      const fits = fitnessByNodeId.get(node.id) ?? true
      if (!fits) {
        console.log(`[Agent ${this.deps.config.agentId}] passing on ${node.id} — outside skill`)
        this.deps.network.emit(this.buildEvent(EventType.AGENT_PASSED, {
          nodeId: node.id, taskId, agentId: this.deps.config.agentId, reason: 'outside_skill',
        })).catch(() => { })
        continue
      }

      // Wider jitter (was 0-100ms). 500-1500ms gives DAG_READY gossip time
      // to actually reach all peers before any agent attempts the on-chain
      // claim — without it, the agent that received the gossip a few hundred
      // ms earlier wins every race deterministically.
      await new Promise(resolve => setTimeout(resolve, 500 + Math.random() * 1000))

      // Pre-check: if the chain already shows this node claimed, skip the
      // tx. Saves gas and avoids "tx success / verify says not us" noise.
      try {
        if (await this.deps.chain.isSubtaskClaimed(node.id)) {
          node.status = 'claimed'
          continue
        }
      } catch {
        // Read failure → fall through to optimistic claim.
      }

      const claimed = await this.deps.chain.claimSubtask(node.id)
      if (claimed) {
        node.status = 'claimed'
        node.claimedBy = this.deps.config.agentId
        claimedThisRound++
        console.log(`[Agent ${this.deps.config.agentId}] claimed ${node.id} (${claimedThisRound}/${stakeCapacity} stake budget)`)

        // Dispatch decision: if prev is ready (or we're the first node)
        // execute now; otherwise hold the claim and let the SUBTASK_DONE
        // listener kick off execution when prev finishes.
        const prevReady = !node.prevHash || !node.prevHash.includes('placeholder-')
        if (prevReady) {
          // Don't await — keep racing for more nodes in this loop iteration.
          this.executeSubtask(node, taskId).catch(err =>
            console.error(`[Agent ${this.deps.config.agentId}] execute error:`, err),
          )
        } else {
          console.log(`[Agent ${this.deps.config.agentId}] holding ${node.id} — prev not ready`)
        }
        // Continue racing for additional eligible nodes on this same DAG.
      }
    }
  }

  private async executeSubtask(node: DAGNode, taskId: string): Promise<void> {
    // Reentrancy guard — if any other path is mid-execution for this same
    // node, skip. Without this, gossip-loopback / fallback timer / watchdog
    // can each call executeSubtask concurrently and the second one hits
    // "Already staked" on the SwarmEscrow when stakeForSubtask runs again.
    if (this.inflightSubtasks.has(node.id)) {
      console.log(`[Agent ${this.deps.config.agentId}] executeSubtask: ${node.id} already in flight, skipping`)
      return
    }
    this.inflightSubtasks.add(node.id)
    try {
      const agentId = this.deps.config.agentId

      // Dynamic Stake: Each agent risks 10% of their total stakeAmount per subtask.
      // This allows them to handle up to 10 parallel subtasks while scaling the
      // risk/reward based on their total capacity.
      const totalStake = parseFloat(this.deps.config.stakeAmount || '100')
      const perSubtaskStake = (totalStake * 0.1).toString()

      // Fire-and-forget stake: stakeForSubtask is serialized inside the
      // L2Contract tx mutex anyway, so awaiting it here just blocks the LLM
      // from starting. Kick it off, do the slow LLM work concurrently, and
      // await right before submitOutput (which is the next tx that
      // *requires* the stake to have landed). Saves ~5-10s per node.
      const stakePromise = this.deps.chain.stakeForSubtask(taskId, node.id, perSubtaskStake)
      // Don't let an unhandled rejection bubble out before our await — we
      // catch it explicitly later. Attach a noop catch now so Node doesn't
      // log "PromiseRejectionHandledWarning".
      stakePromise.catch(() => {})

      await this.deps.network.emit(this.buildEvent(EventType.SUBTASK_CLAIMED, { nodeId: node.id, agentId, taskId }))

      let prevOutput: unknown = null
      let prevText: string = ''
      if (node.prevHash) {
        prevOutput = await this.deps.storage.fetch(node.prevHash)
        prevText = extractFinal(prevOutput)

        // Find the prev node so we can decide whether to re-judge or trust
        // an existing peer validation.
        const task = this.tasks.get(taskId)
        const currentIndex = task ? task.nodes.findIndex(n => n.id === node.id) : -1
        const prevNode = task && currentIndex > 0 ? task.nodes[currentIndex - 1] : null

        // Skip the LLM-Judge call when another peer (or the planner) has
        // already validated this output — the SUBTASK_PEER_VALIDATED /
        // SUBTASK_VALIDATED listeners set this flag. Saves ~5-10s per
        // node in healthy multi-agent runs. We still judge cold outputs.
        const alreadyValidated = !!prevNode?.peerValidated
        if (!alreadyValidated) {
          const isValid = await this.deps.compute.judge(prevText)
          if (!isValid) {
            console.log(`[Agent ${agentId}] LLM-Judge rejected output. Challenging previous node.`)
            if (prevNode) {
              await this.challengeNode(prevNode, taskId, node.id)
            }
            return // Stop execution of current subtask
          }

          // Peer-validation: judge accepted the previous output. Surface
          // this to peers + UI so the prev box flips green and other
          // workers can skip their own judge() call.
          if (prevNode) {
            prevNode.peerValidated = true
            this.deps.network.emit(this.buildEvent(EventType.SUBTASK_PEER_VALIDATED, {
              nodeId: prevNode.id,
              taskId,
              validatorAgentId: agentId,
            })).catch(() => { })
          }
        } else {
          console.log(`[Agent ${agentId}] skipping judge for ${prevNode!.id} — already peer-validated`)
        }
      }

      // Tool-aware agent loop. Returns a structured record that's preserved
      // verbatim in 0G Storage, so the judge / next agent / UI can see
      // exactly which tools fired and what they returned.
      // Fall back to REACT_SYSTEM_PROMPT when the operator didn't supply a
      // custom prompt — keeps the UI's "System Prompt (optional)" field
      // empty for the user while still giving the model a structured
      // DÜŞÜN→EYLEM→GÖZLEM rhythm by default. Treat whitespace-only as
      // unset so a stray newline in the form doesn't bypass the default.
      const userPrompt = this.deps.config.systemPrompt?.trim()
      const loopResult = await runAgentLoop({
        compute: this.deps.compute,
        tools: TOOLS,
        format: new JsonAgentFormat(),
        systemPrompt: userPrompt && userPrompt.length > 0 ? userPrompt : REACT_SYSTEM_PROMPT,
        subtask: node.subtask,
        context: prevText || null,
        agentId,
      })

      const persisted = {
        subtask: node.subtask,
        finalAnswer: loopResult.finalAnswer,
        transcript: loopResult.transcript,
        toolsUsed: loopResult.toolsUsed,
        iterations: loopResult.iterations,
        stopReason: loopResult.stopReason,
      }

      // Hash-now, upload-later: rootHash is deterministic from the payload,
      // so we submit it on-chain immediately and let the upload run in
      // background. Peer agents fetching this hash retry on miss (3× 2s).
      let outputHash: string
      let uploadPromise: Promise<void> | undefined
      if (typeof this.deps.storage.appendDeferred === 'function') {
        const r = await this.deps.storage.appendDeferred(persisted)
        outputHash = r.rootHash
        uploadPromise = r.uploadPromise
      } else {
        outputHash = await this.deps.storage.append(persisted)
      }
      node.status = 'done'
      node.outputHash = outputHash

      // Now make sure the stake landed before we declare output on-chain.
      // submitOutput on a not-yet-staked node would still succeed at the
      // contract level, but the stake tx is what locks our economic
      // commitment — if it reverted (insufficient balance, etc.) we want
      // to fail before submitting an output that we can't back up.
      try {
        await stakePromise
      } catch (stakeErr) {
        console.error(`[Agent ${agentId}] stake failed for ${node.id}, abandoning subtask:`, stakeErr)
        node.status = undefined as any
        node.outputHash = undefined
        // Try to free the on-chain claim so a peer (or our next claim
        // round) can pick this up. resetSubtask is a no-op on the real
        // L2 contract today, but mock honours it and the call is harmless.
        await this.deps.chain.resetSubtask(node.id).catch(() => {})
        return
      }

      // Submit output hash on-chain (independent of upload completion)
      await this.deps.chain.submitOutput(node.id, outputHash)

      // Track background upload — log only, don't block the hot path.
      uploadPromise?.catch(err =>
        console.error(`[Agent ${agentId}] async upload failed for ${outputHash}:`, err),
      )

      console.log(
        `[Agent ${agentId}] subtask done (${node.id}) iters=${loopResult.iterations} tools=[${loopResult.toolsUsed.join(',')}] reason=${loopResult.stopReason}`,
      )

      // Broadcast a UI-friendly view of the transcript. Tool outputs can
      // be megabytes (web search dumps, file reads) — clipping each to a
      // few KB keeps the WS payload small while preserving the shape of
      // the agent's reasoning for the explorer's per-node detail panel.
      // The full untruncated transcript still lives at `outputHash` in
      // 0G Storage, so judges + downstream agents read the canonical copy.
      const TOOL_OUTPUT_CLIP = 2_000
      const transcriptForBroadcast = loopResult.transcript.map(step =>
        step.kind === 'tool_call'
          ? {
              ...step,
              output:
                step.output.length > TOOL_OUTPUT_CLIP
                  ? step.output.slice(0, TOOL_OUTPUT_CLIP) + `\n…[+${step.output.length - TOOL_OUTPUT_CLIP} chars]`
                  : step.output,
            }
          : step,
      )

      await this.deps.network.emit(this.buildEvent(EventType.SUBTASK_DONE, {
        nodeId: node.id,
        outputHash,
        // Plain-text final answer for downstream context + UI legibility.
        // The full structured payload is in 0G Storage at outputHash.
        result: loopResult.finalAnswer,
        toolsUsed: loopResult.toolsUsed,
        // Reasoning trace + counters drive the explorer's "thinking
        // process" panel — the transcript is the per-step view, the
        // counters give the panel a quick summary.
        transcript: transcriptForBroadcast,
        iterations: loopResult.iterations,
        stopReason: loopResult.stopReason,
        agentId,
        taskId,
      }))

      const task = this.tasks.get(taskId)

      // Local loopback: if WE pre-claimed the next node, we don't wait for the 
      // network event to bounce back. Trigger it immediately so the chain flows.
      const nextNode = task && task.nodes[task.nodes.findIndex(n => n.id === node.id) + 1]
      if (
        nextNode &&
        nextNode.claimedBy === agentId &&
        nextNode.status === 'claimed'
      ) {
        const nextOutputHash = outputHash // current is prev for next
        nextNode.prevHash = nextOutputHash
        console.log(`[Agent ${agentId}] local loopback: triggering held claim ${nextNode.id}`)
        this.executeSubtask(nextNode, taskId).catch(err =>
          console.error(`[Agent ${agentId}] local dispatch error:`, err)
        )
      }

      // Last-node check: under parallel-claim/sequential-execute, the next
      // worker (if any) was already claimed at DAG_READY time and is sitting
      // on its prevHash. Our SUBTASK_DONE broadcast is what unblocks them —
      // so we don't re-claim here. We only need to handle the terminal case.
      const isLastNode = !!task && task.nodes[task.nodes.length - 1]?.id === node.id
      if (isLastNode) {
        if (this.plannerFor.has(taskId)) {
          // We're the planner-keeper — validate immediately.
          await this.validateLastNodeAsPlanner(node.id, outputHash, taskId)
        } else {
          // Different agent finished the last node; signal the planner.
          console.log(`[Agent ${agentId}] last node done, signaling planner for validation`)
          await this.deps.network.emit(this.buildEvent(EventType.DAG_COMPLETED, {
            taskId,
            lastNodeId: node.id,
            lastOutputHash: outputHash,
            needsPlannerValidation: true,
          }))
        }
      }

    } catch (err) {
      console.error(`[Agent ${this.deps.config.agentId}] executeSubtask error:`, err)
      // Hata akışında stuck busy state'e düşmemek için bu task'tan çekil.
      // Eğer hata transient ise yeni task'lar yine de bizden açılabilsin;
      // gerçekten kalıcı bir sorun varsa zaten bir sonraki task'da fail eder.
      if (this.currentTaskId === taskId) {
        this.currentTaskId = null
      }
    } finally {
      this.inflightSubtasks.delete(node.id)
    }
  }

  /**
   * Planner'ın keeper rolü: Son agent'ın çıktısını denetler.
   * Mimari gereği son agent'ı denetleyecek bir sonraki agent olmadığı için
   * bu sorumluluk planner'a aittir.
   */
  private async validateLastNodeAsPlanner(lastNodeId: string, outputHash: string, taskId: string): Promise<void> {
    const agentId = this.deps.config.agentId
    const task = this.tasks.get(taskId)
    if (!task) return

    console.log(`[Agent ${agentId}] KEEPER: Validating last node ${lastNodeId} output`)

    try {
      // Self-claimant guard: if the planner-keeper also worked the last node,
      // a judge → challenge flow is impossible (SlashingVault rejects
      // self-challenge: `accused != msg.sender`). There is also no peer
      // worker to peer-validate the last node. Trust own work and mark
      // validated; the per-node SUBTASK_PEER_VALIDATED signal earlier in the
      // chain still gives meaningful jury coverage to every other node.
      //
      // myAddr: prefer the explicitly configured agentAddress (set in env);
      // fall back to AGENT_PRIVATE_KEY-derived address so we never skip the
      // guard just because the config field was left blank.
      const rawAddr = this.deps.config.agentAddress
        ?? (process.env.AGENT_PRIVATE_KEY
          ? new Wallet(process.env.AGENT_PRIVATE_KEY).address
          : '')
      const myAddr = rawAddr.toLowerCase()
      let claimant = ''
      try {
        claimant = await this.deps.chain.getNodeClaimant(lastNodeId)
      } catch (err) {
        console.warn(`[Agent ${agentId}] KEEPER: getNodeClaimant failed for ${lastNodeId}:`, err)
      }

      const selfClaimed = !!myAddr && !!claimant && myAddr.toLowerCase() === claimant.toLowerCase()

      if (!selfClaimed) {
        // Son node'un çıktısını storage'dan çek ve LLM-Judge ile denetle
        const lastOutput = await this.deps.storage.fetch(outputHash)
        const isValid = await this.deps.compute.judge(extractFinal(lastOutput))

        if (!isValid) {
          console.log(`[Agent ${agentId}] KEEPER: Last node ${lastNodeId} FAILED validation. Challenging.`)
          const lastNode = task.nodes.find(n => n.id === lastNodeId)
          if (lastNode) {
            await this.challengeNode(lastNode, taskId)
          }
          return
        }
      } else {
        console.log(`[Agent ${agentId}] KEEPER: I worked the last node — skipping self-judge, trusting own output`)
      }

      console.log(`[Agent ${agentId}] KEEPER: Last node ${lastNodeId} validated. Marking + settling.`)

      const nodeIds = task.nodes.map(n => n.id)

      // Resolve claimant addresses + compute payouts (read-only, fine to
      // do before the tx burst).
      const workerAddrs = await Promise.all(
        nodeIds.map(id => this.deps.chain.getNodeClaimant(id))
      )
      const budget = BigInt(await this.deps.chain.getTaskBudget(taskId))
      const plannerAddr = this.deps.config.agentAddress ?? this.deps.config.agentId
      const { addresses, amounts } = this.computePayouts(budget, plannerAddr, workerAddrs)

      // Sequential: same NonceManager race as in runAsPlanner. Order
      // matters less here (settle's pre-check reads claimedBy, not
      // validated), but the safer choice is markValidatedBatch first so
      // that subtask stakes are released before the task gets finalized.
      // markValidatedBatch already releases each subtask stake on-chain
      // (DAGRegistry.markValidatedBatch → escrow.releaseSubtaskStake per node),
      // so no separate refund call is needed here.
      await this.deps.chain.markValidatedBatch(nodeIds)

      await this.deps.chain.settleTask(taskId, addresses, amounts.map(a => a.toString()))

      // Per-node validated event so the dashboard can flip each box from
      // 'pending' (yellow / output written) to 'done' (green / validated).
      // Emitting individually keeps the UI animation natural even though the
      // contract validates all in one tx.
      for (const nid of nodeIds) {
        this.deps.network.emit(this.buildEvent(EventType.SUBTASK_VALIDATED, {
          nodeId: nid, taskId, agentId,
        })).catch(() => { })
      }

      // FCFS at planner-claim already guarantees a single keeper reaches this
      // path per task. completeTask is now an idempotent sync hook (no-op on
      // L2; mock dedupes via completedTasks map) — no need to gate the emit
      // on its return value.
      await this.deps.chain.completeTask(taskId)
      console.log(`[Agent ${agentId}] KEEPER: DAG_COMPLETED — paid planner ${amounts[0]} + ${workerAddrs.length} workers`)
      await this.deps.network.emit(this.buildEvent(EventType.DAG_COMPLETED, { taskId, settled: true }))
    } catch (err) {
      console.error(`[Agent ${agentId}] KEEPER validation error:`, err)
    }
  }

  /**
   * Open a challenge against `node`. `challengerNodeId` identifies the
   * challenger's *own* subtask — its stake is what gets slashed if the
   * challenge turns out to be false. Pass undefined when the planner is
   * challenging (their stake lives at task-level, not subtask-level).
   */
  private async challengeNode(node: DAGNode, taskId: string, challengerNodeId?: string): Promise<void> {
    try {
      await this.deps.chain.challenge(node.id, challengerNodeId)
      await this.deps.network.emit(this.buildEvent(EventType.CHALLENGE, {
        nodeId: node.id, taskId, agentId: this.deps.config.agentId,
      }))
      await this.deps.chain.resetSubtask(node.id)
      await this.deps.network.emit(this.buildEvent(EventType.TASK_REOPENED, {
        nodeId: node.id, taskId, reason: 'validation_failed',
      }))
    } catch (err) {
      console.error(`[Agent ${this.deps.config.agentId}] challenge error:`, err)
    } finally {
      // Çıkış kuralı: bu task için sorumluluğumuz challenge ile bitti.
      // Cache'i de temizle — eski subtask stake'imiz kilitli olabilir, eski
      // tasks.get() kayıtları SUBTASK_DONE listener'ını re-entrant claim'e
      // sürüklüyor ve "Already staked" zincirleme revert'ine sebep oluyor.
      if (this.currentTaskId === taskId) {
        console.log(`[Agent ${this.deps.config.agentId}] releasing task ${taskId} after challenge`)
        this.currentTaskId = null
        this.tasks.delete(taskId)
        this.plannerFor.delete(taskId)
      }
    }
  }

  /**
   * LLM-Judge jury vote — commit-reveal flow. When another agent raises a
   * CHALLENGE, every eligible peer runs its own judge() and produces a
   * verdict, then submits a SEALED commit hash on-chain. Votes stay hidden
   * until the reveal phase opens (~30 min later), at which point a scheduled
   * timer here calls revealVoteOnChallenge with the stored salt. Sealing the
   * vote closes the "tail-the-majority" attack the previous direct-vote
   * design exposed.
   *
   * Self-events (we are the challenger), missing local cache, or ineligibility
   * (we are the accused worker, not RUNNING in AgentRegistry, already
   * committed) are silently skipped — the contract is the authoritative gate.
   *
   * KNOWN LIMITATION: pendingReveals is in-memory. A process restart between
   * commit and reveal forfeits this juror's vote. For demo only.
   */
  private async onChallengeRaised(event: AXLEvent<any>): Promise<void> {
    const { nodeId, taskId } = event.payload
    const myAgentId = this.deps.config.agentId

    if (event.agentId === myAgentId) return

    const task = this.tasks.get(taskId)
    if (!task) return
    const node = task.nodes.find(n => n.id === nodeId)
    if (!node?.outputHash) {
      console.log(`[Agent ${myAgentId}] CHALLENGE: no cached output for ${nodeId}, abstain`)
      return
    }

    if (node.claimedBy === myAgentId) return
    if (this.pendingReveals.has(nodeId)) {
      console.log(`[Agent ${myAgentId}] CHALLENGE: already committed for ${nodeId}, skipping`)
      return
    }

    // Need the agent's wallet address to bind the commit hash to msg.sender.
    // Also used for the on-chain eligibility lookup below.
    const myAddr = this.deps.config.agentAddress
    if (!myAddr) {
      console.warn(`[Agent ${myAgentId}] cannot commit — agentAddress missing in config`)
      return
    }

    // Random jury gate. SlashingVault.challenge() picks JURY_SIZE jurors at
    // tx-time; everyone else self-filters here with a single mapping read,
    // skipping the expensive storage-fetch + LLM judge() round entirely.
    let eligible = false
    try {
      eligible = await this.deps.chain.isJuryEligible(nodeId, myAddr)
    } catch (err) {
      console.warn(`[Agent ${myAgentId}] eligibility check failed for ${nodeId}:`, err)
      return
    }
    if (!eligible) {
      console.log(`[Agent ${myAgentId}] CHALLENGE: not selected as juror for ${nodeId}, abstaining`)
      return
    }

    let output: unknown
    try {
      output = await this.deps.storage.fetch(node.outputHash)
    } catch (err) {
      console.warn(`[Agent ${myAgentId}] juror could not fetch output for ${nodeId}:`, err)
      return
    }

    const isValid = await this.deps.compute.judge(extractFinal(output))
    const accusedGuilty = !isValid
    console.log(
      `[Agent ${myAgentId}] JUROR verdict on ${nodeId}: ${accusedGuilty ? 'GUILTY' : 'INNOCENT'} (sealing commit)`,
    )

    // Build the commit hash. Format must match SlashingVault.revealVote:
    //   keccak256(abi.encodePacked(bytes32 nodeId, bool guilty, bytes32 salt, address juror))
    // nodeId here is the off-chain string; keccakId mirrors L2Contract.formatId.
    const salt = hexlify(randomBytes(32))
    const nodeIdBytes32 = keccakId(nodeId)
    const commitHash = solidityPackedKeccak256(
      ['bytes32', 'bool', 'bytes32', 'address'],
      [nodeIdBytes32, accusedGuilty, salt, myAddr],
    )

    try {
      await this.deps.chain.commitVoteOnChallenge(nodeId, commitHash)
      this.deps.network.emit(this.buildEvent(EventType.JUROR_COMMITTED, {
        nodeId, taskId, agentId: myAgentId,
      })).catch(() => { })
    } catch (err) {
      console.warn(`[Agent ${myAgentId}] juror commit failed for ${nodeId}:`, err)
      return
    }

    // Demo timing — must match SlashingVault's COMMIT_WINDOW / REVEAL_WINDOW
    // (currently 20s each) so the full challenge resolves inside ~1 minute.
    // Reveal scheduled at commitDeadline + 3s grace so block.timestamp lands
    // safely past on-chain commitDeadline; finalize scheduled at the end of
    // reveal window + 3s. Multiple jurors may schedule finalize — first one
    // wins, the rest revert silently with "Already resolved", harmless.
    const COMMIT_WINDOW_MS = 20_000
    const REVEAL_WINDOW_MS = 20_000
    const REVEAL_GRACE_MS = 3_000
    const FINALIZE_GRACE_MS = 3_000
    const revealDelay = COMMIT_WINDOW_MS + REVEAL_GRACE_MS
    const finalizeDelay = COMMIT_WINDOW_MS + REVEAL_WINDOW_MS + FINALIZE_GRACE_MS

    this.pendingReveals.set(nodeId, {
      taskId,
      accusedGuilty,
      salt,
      revealAt: Date.now() + revealDelay,
    })

    setTimeout(() => {
      this.tryReveal(nodeId).catch(err =>
        console.error(`[Agent ${myAgentId}] reveal scheduler error for ${nodeId}:`, err),
      )
    }, revealDelay)

    setTimeout(() => {
      this.deps.chain.finalizeChallenge(nodeId).catch(err =>
        console.log(`[Agent ${myAgentId}] finalize attempt for ${nodeId} skipped: ${err?.message ?? err}`),
      )
    }, finalizeDelay)
  }

  /**
   * Send the second half of the commit-reveal pair. Called by the timer set
   * up in onChallengeRaised. Idempotent at the contract layer (revealVote
   * reverts if we already revealed), so retries from a manual nudge are safe.
   */
  private async tryReveal(nodeId: string): Promise<void> {
    const pending = this.pendingReveals.get(nodeId)
    if (!pending) return
    const myAgentId = this.deps.config.agentId
    try {
      await this.deps.chain.revealVoteOnChallenge(nodeId, pending.accusedGuilty, pending.salt)
      console.log(
        `[Agent ${myAgentId}] revealed vote for ${nodeId}: ${pending.accusedGuilty ? 'GUILTY' : 'INNOCENT'}`,
      )
      this.deps.network.emit(this.buildEvent(EventType.JUROR_VOTED, {
        nodeId,
        taskId: pending.taskId,
        agentId: myAgentId,
        accusedGuilty: pending.accusedGuilty,
      })).catch(() => { })
    } catch (err) {
      console.warn(`[Agent ${myAgentId}] reveal failed for ${nodeId}:`, err)
    } finally {
      this.pendingReveals.delete(nodeId)
    }
  }

  private async onTaskReopened(event: AXLEvent<any>): Promise<void> {
    const { nodeId, taskId } = event.payload

    // Kendi yayınladığımız REOPEN event'inde re-claim'e gitmeyelim:
    //   1) challengeNode sonrası bu task'tan zaten çekildik (currentTaskId temizlendi).
    //   2) Vault `slashSubtaskPartial` sadece QUORUM sonrası subtask stake'ini
    //      temizliyor — kimse oy vermediyse stake hâlâ bizde kilitli, yeniden
    //      stakeForSubtask çağırırsak "Already staked" revert'ine düşeriz.
    //   3) Adillik: kendi challenge ettiğimiz node'u kendimiz tekrar almak
    //      ekonomik olarak garip; başka agent'lara bırak.
    if (event.agentId === this.deps.config.agentId) {
      return
    }

    const task = this.tasks.get(taskId)
    if (!task) return

    const node = task.nodes.find(n => n.id === nodeId)
    if (node) {
      node.status = undefined as any
      node.outputHash = undefined
    }

    // Try once immediately in case the on-chain reset has already landed
    // (jury hit quorum before this event reached us). If still un-claimed
    // locally afterwards, schedule a polling watchdog — the vault only
    // resets the node after QUORUM guilty votes or finalizeExpired.
    await this.claimFirstAvailable(taskId)

    const fresh = task.nodes.find(n => n.id === nodeId)
    if (fresh && fresh.status !== 'claimed' && fresh.status !== 'done') {
      this.scheduleReopenWatchdog(nodeId, taskId)
    }
  }

  /**
   * After a CHALLENGE, the vault only calls registry.resetNode once the
   * commit-reveal flow finalizes with a majority-guilty verdict. Until that
   * happens, claimSubtask returns false because claimedBy is still the
   * slashed worker. Poll the registry periodically and re-attempt the claim
   * once the slot is empty. Also nudges finalize() every few iterations so
   * a fully-revealed window resolves without a manual operator step.
   */
  private scheduleReopenWatchdog(nodeId: string, taskId: string): void {
    // Tight polling to match the demo-tuned commit+reveal total of ~50s.
    // Each commit-side juror also schedules a one-shot finalize, so this
    // watchdog is mostly a safety net for the re-claim path after resetNode.
    const POLL_MS = 5_000
    // ~5 minutes of total runway — well past the ~1-min resolution window,
    // covers retries when 0G testnet RPC throttles individual finalize calls.
    const MAX_ITERATIONS = 60
    const ZERO = '0x0000000000000000000000000000000000000000'
    let attempt = 0
    const agentId = this.deps.config.agentId

    const tick = async (): Promise<void> => {
      attempt++
      const task = this.tasks.get(taskId)
      if (!task) return // task abandoned / completed
      const node = task.nodes.find(n => n.id === nodeId)
      if (node && (node.status === 'claimed' || node.status === 'done')) return
      if (attempt > MAX_ITERATIONS) {
        console.log(`[Agent ${agentId}] reopen watchdog: giving up on ${nodeId}`)
        return
      }

      // Best-effort kick to close the challenge once the reveal window has
      // elapsed. Reverts with "Reveal still open" before the deadline;
      // harmless to attempt.
      if (attempt % 4 === 0) {
        try {
          await this.deps.chain.finalizeChallenge(nodeId)
        } catch { /* expected before reveal deadline */ }
      }

      try {
        const claimant = await this.deps.chain.getNodeClaimant(nodeId)
        if (!claimant || claimant.toLowerCase() === ZERO) {
          console.log(`[Agent ${agentId}] reopen watchdog: ${nodeId} reset detected, retrying claim`)
          await this.claimFirstAvailable(taskId)
        }
      } catch (err) {
        console.warn(`[Agent ${agentId}] reopen watchdog poll failed:`, err)
      }

      setTimeout(tick, POLL_MS)
    }

    setTimeout(tick, POLL_MS)
  }

  private buildEvent<T>(type: EventType, payload: T): AXLEvent<T> {
    return { type, payload, timestamp: Date.now(), agentId: this.deps.config.agentId }
  }

  /**
   * Settlement split: 20% to planner, 80% split equally among the workers
   * who claimed subtasks. Returns parallel addresses[]/amounts[] arrays for
   * SwarmEscrow.settleWithAmounts; the planner is always at index 0.
   *
   * If the planner also worked on a subtask, their address legitimately
   * appears twice — the escrow refunds their stake on the first iteration
   * and treats the second as a pure reward, which is correct.
   */
  private computePayouts(
    budget: bigint,
    plannerAddr: string,
    workerAddrs: string[],
  ): { addresses: string[]; amounts: bigint[] } {
    const PLANNER_BPS = 2000n // 20%
    const WORKER_BPS = 8000n  // 80%
    const BPS = 10000n

    const plannerShare = (budget * PLANNER_BPS) / BPS
    const workerPool = (budget * WORKER_BPS) / BPS
    const workerShare = workerAddrs.length > 0
      ? workerPool / BigInt(workerAddrs.length)
      : 0n

    const addresses = [plannerAddr, ...workerAddrs]
    const amounts = [plannerShare, ...workerAddrs.map(() => workerShare)]
    return { addresses, amounts }
  }
}
