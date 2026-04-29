import { IStoragePort, IComputePort, INetworkPort, IChainPort } from '../../../shared/ports'
import { EventType, DAGNode, AgentConfig, AXLEvent } from '../../../shared/types'
import { runAgentLoop } from './agentLoop'
import { JsonAgentFormat } from './agentFormat'
import { TOOLS } from './tools/definitions'

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

  constructor(private deps: AgentDeps) {}

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
      this.claimFirstAvailable(taskId).catch(() => {})
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
  }

  private isBusyWithTimeout(newTaskId: string): boolean {
    if (!this.currentTaskId) return false
    if (this.currentTaskId === newTaskId) return false
    
    // 15 saniye sessizlik varsa meşgul sayılma (timeout)
    const silentDuration = Date.now() - this.lastActivity
    if (silentDuration > 15000) {
      console.log(`[Agent ${this.deps.config.agentId}] Previous task ${this.currentTaskId} timed out (${Math.round(silentDuration/1000)}s silent). Resetting.`)
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
      
      // 1 saniye bekle, bakalım başkası daha önce davranmış mı (Sync kontrolü)
      await new Promise(r => setTimeout(r, 1000))
      
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

      // Storage append is content-addressed and idempotent, safe to do early.
      await this.deps.storage.append(nodes)

      // Register DAG on-chain BEFORE staking so a registerDAG revert
      // ("Already registered" / "Empty DAG") doesn't leave funds locked
      // in escrow with no way to recover. Once registerDAG lands the seal
      // is permanent; only then commit the stake.
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
      const SINGLE_AGENT_FALLBACK_MS = 30_000
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

      // Fallback: if 30s pass and the task still has uncllaimed nodes, every
      // agent drops the skill filter and tries again. Prevents a DAG from
      // stalling when no one self-selected as a fit (e.g. very generic
      // prompts that all said NO, or a subtask domain no agent specialised in).
      const FALLBACK_MS = 30_000
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

    // Parallel claim, sequential execute: agents race to claim ALL eligible
    // nodes upfront (regardless of whether prev is done). Once a node is
    // claimed, the claimer waits for prev's SUBTASK_DONE — at which point
    // the listener wakes up and dispatches executeSubtask. This breaks the
    // single-agent-zincirleme bias of the old "claim only when prev is
    // ready" rule, since every node opens for FCFS the moment the DAG is
    // sealed.
    for (const node of task.nodes) {
      // Already handled — either we or a peer claimed/finished it.
      if (node.status === 'done' || node.status === 'claimed') continue

      // Skill self-selection: skip nodes the agent says don't match its prompt.
      const fits = await this.fitsSkill(node.subtask, bypassSkill)
      if (!fits) {
        console.log(`[Agent ${this.deps.config.agentId}] passing on ${node.id} — outside skill`)
        this.deps.network.emit(this.buildEvent(EventType.AGENT_PASSED, {
          nodeId: node.id, taskId, agentId: this.deps.config.agentId, reason: 'outside_skill',
        })).catch(() => {})
        continue
      }

      // Gentleman's delay so peers can race fairly (same agent isn't always
      // first thanks to local network advantages).
      await new Promise(resolve => setTimeout(resolve, Math.random() * 500))

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
        console.log(`[Agent ${this.deps.config.agentId}] claimed ${node.id}`)

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
      // Worker stake is locked against this specific subtask. It is auto-released
      // when the planner marks the node validated, or partially slashed if a
      // challenge succeeds.
      await this.deps.chain.stakeForSubtask(taskId, node.id, this.deps.config.stakeAmount)
      await this.deps.network.emit(this.buildEvent(EventType.SUBTASK_CLAIMED, { nodeId: node.id, agentId, taskId }))

      let prevOutput: unknown = null
      let prevText: string = ''
      if (node.prevHash) {
        prevOutput = await this.deps.storage.fetch(node.prevHash)
        prevText = extractFinal(prevOutput)

        // LLM-Judge step
        const isValid = await this.deps.compute.judge(prevText)
        if (!isValid) {
          console.log(`[Agent ${this.deps.config.agentId}] LLM-Judge rejected output. Challenging previous node.`)

          // Find the previous node id to challenge. The challenger here is
          // the current worker (this agent), whose subtask is `node.id` —
          // pass it so the vault knows where their stake lives.
          const task = this.tasks.get(taskId)
          if (task) {
            const currentIndex = task.nodes.findIndex(n => n.id === node.id)
            if (currentIndex > 0) {
              const prevNode = task.nodes[currentIndex - 1]
              await this.challengeNode(prevNode, taskId, node.id)
            }
          }
          return // Stop execution of current subtask
        }

        // Peer-validation: judge accepted the previous output, so we're about
        // to use it as context. Surface this to the UI so the prev box flips
        // green immediately — the planner's on-chain markValidatedBatch at
        // DAG end is the authoritative finality and still fires later.
        const task = this.tasks.get(taskId)
        if (task) {
          const currentIndex = task.nodes.findIndex(n => n.id === node.id)
          if (currentIndex > 0) {
            const prevNode = task.nodes[currentIndex - 1]
            this.deps.network.emit(this.buildEvent(EventType.SUBTASK_PEER_VALIDATED, {
              nodeId: prevNode.id,
              taskId,
              validatorAgentId: this.deps.config.agentId,
            })).catch(() => {})
          }
        }
      }

      // Tool-aware agent loop. Returns a structured record that's preserved
      // verbatim in 0G Storage, so the judge / next agent / UI can see
      // exactly which tools fired and what they returned.
      const loopResult = await runAgentLoop({
        compute: this.deps.compute,
        tools: TOOLS,
        format: new JsonAgentFormat(),
        systemPrompt: this.deps.config.systemPrompt,
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
      const outputHash = await this.deps.storage.append(persisted)
      node.status = 'done'
      node.outputHash = outputHash

      // Submit output hash on-chain
      await this.deps.chain.submitOutput(node.id, outputHash)

      console.log(
        `[Agent ${agentId}] subtask done (${node.id}) iters=${loopResult.iterations} tools=[${loopResult.toolsUsed.join(',')}] reason=${loopResult.stopReason}`,
      )

      await this.deps.network.emit(this.buildEvent(EventType.SUBTASK_DONE, {
        nodeId: node.id,
        outputHash,
        // Plain-text final answer for downstream context + UI legibility.
        // The full structured payload is in 0G Storage at outputHash.
        result: loopResult.finalAnswer,
        toolsUsed: loopResult.toolsUsed,
        agentId,
        taskId,
      }))

      // Last-node check: under parallel-claim/sequential-execute, the next
      // worker (if any) was already claimed at DAG_READY time and is sitting
      // on its prevHash. Our SUBTASK_DONE broadcast is what unblocks them —
      // so we don't re-claim here. We only need to handle the terminal case.
      const task = this.tasks.get(taskId)
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
          ? new (require('ethers').Wallet)(process.env.AGENT_PRIVATE_KEY).address
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

      console.log(`[Agent ${agentId}] KEEPER: Last node ${lastNodeId} validated. Marking all nodes on-chain (batch).`)

      // Single-tx batch validation. No auto-settle on-chain — the planner
      // controls payout amounts via the explicit settleTask call below.
      const nodeIds = task.nodes.map(n => n.id)
      await this.deps.chain.markValidatedBatch(nodeIds)

      // Per-node validated event so the dashboard can flip each box from
      // 'pending' (yellow / output written) to 'done' (green / validated).
      // Emitting individually keeps the UI animation natural even though the
      // contract validates all in one tx.
      for (const nid of nodeIds) {
        this.deps.network.emit(this.buildEvent(EventType.SUBTASK_VALIDATED, {
          nodeId: nid, taskId, agentId,
        })).catch(() => {})
      }

      // Resolve claimant addresses + compute payouts.
      const workerAddrs = await Promise.all(
        nodeIds.map(id => this.deps.chain.getNodeClaimant(id))
      )
      const budget = BigInt(await this.deps.chain.getTaskBudget(taskId))
      const plannerAddr = this.deps.config.agentAddress ?? this.deps.config.agentId
      const { addresses, amounts } = this.computePayouts(budget, plannerAddr, workerAddrs)

      await this.deps.chain.settleTask(taskId, addresses, amounts.map(a => a.toString()))

      const won = await this.deps.chain.completeTask(taskId)
      if (won) {
        console.log(`[Agent ${agentId}] KEEPER: DAG_COMPLETED — paid planner ${amounts[0]} + ${workerAddrs.length} workers`)
        await this.deps.network.emit(this.buildEvent(EventType.DAG_COMPLETED, { taskId, settled: true }))
      }
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
   * LLM-Judge jury vote. When another agent raises a CHALLENGE on AXL, every
   * other agent in the swarm runs its own judge over the disputed output and
   * casts a verdict. The on-chain SlashingVault auto-resolves the slash once
   * QUORUM votes land — there is no admin path. Self-events (we are the
   * challenger), missing local cache, or ineligibility (we are the accused
   * worker, not RUNNING in AgentRegistry, already voted) are silently skipped:
   * the contract is the authoritative gate, the agent only proposes a verdict.
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

    // Don't vote on a node we ourselves produced — the contract would reject
    // the tx anyway, but skipping early saves an RPC round-trip.
    if (node.claimedBy === myAgentId) return

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
      `[Agent ${myAgentId}] JUROR verdict on ${nodeId}: ${accusedGuilty ? 'GUILTY' : 'INNOCENT'}`,
    )
    try {
      await this.deps.chain.voteOnChallenge(nodeId, myAgentId, accusedGuilty)
      // Surface to the dashboard. We rely on the chain tx succeeding to
      // emit, so a duplicate or ineligible vote (e.g. the contract rejected
      // it because we already voted) doesn't leak into the UI.
      this.deps.network.emit(this.buildEvent(EventType.JUROR_VOTED, {
        nodeId, taskId, agentId: myAgentId, accusedGuilty,
      })).catch(() => {})
    } catch (err) {
      console.warn(`[Agent ${myAgentId}] juror vote failed for ${nodeId}:`, err)
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
   * After a CHALLENGE, the vault only calls registry.resetNode once enough
   * jurors have voted GUILTY (QUORUM = 3) or finalizeExpired closes a
   * majority-guilty window. Until that happens, claimSubtask returns false
   * because claimedBy is still the slashed worker. Poll the registry
   * periodically and re-attempt the claim once the slot is empty. Also nudges
   * finalizeExpiredChallenge every few iterations so a stale window with one
   * or two guilty votes can resolve without a manual operator step.
   */
  private scheduleReopenWatchdog(nodeId: string, taskId: string): void {
    const POLL_MS = 30_000
    // Aligned with SlashingVault.VOTING_WINDOW (1h) + a small grace period
    // so we keep polling until the challenge is definitely resolved. Earlier
    // 24-iter (~12 min) ceiling caused slots to orphan whenever a jury vote
    // landed late — the watchdog gave up before resetNode fired.
    const MAX_ITERATIONS = 130 // ~65 min
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

      // Best-effort kick to close a stale challenge. Reverts with
      // "Still voting" before the deadline; harmless to attempt.
      if (attempt % 4 === 0) {
        try {
          await this.deps.chain.finalizeExpiredChallenge(nodeId)
        } catch { /* expected before deadline */ }
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
