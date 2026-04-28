import { IStoragePort, IComputePort, INetworkPort, IChainPort } from '../../../shared/ports'
import { EventType, DAGNode, AgentConfig, AXLEvent } from '../../../shared/types'

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
        
        // Update local DAG cache status if we have it
        const task = this.tasks.get(taskId)
        if (task) {
          const node = task.nodes.find(n => n.id === nodeId)
          if (node) node.status = 'claimed'
        }
      }
    })

    this.deps.network.on(EventType.SUBTASK_DONE, (event) => {
      const { nodeId, outputHash, taskId } = event.payload as any
      this.lastActivity = Date.now()
      const task = this.tasks.get(taskId)
      if (task) {
        const node = task.nodes.find(n => n.id === nodeId)
        if (node) {
          node.status = 'done'
          node.outputHash = outputHash
        }
        // Bir iş bittiğine göre, boşalan başka bir işi almayı deneyebiliriz
        this.claimFirstAvailable(taskId).catch(() => {})
      }
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
      // Who won?
      const chosenPlanner = (this.deps.chain as any).plannerClaims?.get(taskId) || this.deps.config.agentId;

      if (claimed) {
        this.currentTaskId = taskId
        console.log(`[Agent ${this.deps.config.agentId}] WON planner race. Acting as planner.`)
        await this.runAsPlanner(event)
      } else {
        console.log(`[Agent ${this.deps.config.agentId}] LOST planner race to ${chosenPlanner}. Acting as worker.`)
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

      await this.deps.storage.append(nodes)
      await this.deps.chain.stake(taskId, this.deps.config.stakeAmount)

      // Register DAG on-chain (mühürleme)
      const nodeIds = nodes.map(n => n.id)
      await this.deps.chain.registerDAG(taskId, nodeIds)
      console.log(`[Agent ${agentId}] DAG registered on-chain with ${nodeIds.length} nodes`)

      await this.deps.network.emit(this.buildEvent(EventType.PLANNER_SELECTED, { agentId, taskId }))
      await new Promise(r => setTimeout(r, 100))
      await this.deps.network.emit(this.buildEvent(EventType.DAG_READY, {
        nodes,
        taskId,
        plannerAgentId: agentId
      }))

      console.log(`[Agent ${agentId}] DAG_READY emitted, ${nodes.length} nodes`)

      // Track planner responsibility — keeper role for validating last node
      this.plannerFor.add(taskId)
      this.tasks.set(taskId, { nodes, taskId, plannerAgentId: agentId })
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

  private async claimFirstAvailable(taskId: string, bypassSkill = false): Promise<void> {
    const task = this.tasks.get(taskId)
    if (!task) return

    for (const node of task.nodes) {
      // prevHash henüz gerçek storage hash değilse (bağımlılık bitmediyse) atla
      // Gerçek hash'lerde 'placeholder-' kelimesi geçmez.
      if (node.prevHash && node.prevHash.includes('placeholder-')) continue

      // Skill self-selection: skip nodes the agent says don't match its prompt.
      const fits = await this.fitsSkill(node.subtask, bypassSkill)
      if (!fits) {
        console.log(`[Agent ${this.deps.config.agentId}] passing on ${node.id} — outside skill`)
        // Surface the skill miss to the dashboard so viewers can see the
        // self-selection layer at work. Bypass mode (fallback) doesn't pass.
        this.deps.network.emit(this.buildEvent(EventType.AGENT_PASSED, {
          nodeId: node.id, taskId, agentId: this.deps.config.agentId, reason: 'outside_skill',
        })).catch(() => {})
        continue
      }

      // Gentleman's delay to avoid double claims in P2P mesh
      await new Promise(resolve => setTimeout(resolve, Math.random() * 500));

      const claimed = await this.deps.chain.claimSubtask(node.id)
      if (claimed) {
        node.status = 'claimed'
        console.log(`[Agent ${this.deps.config.agentId}] claimed ${node.id}`)
        await this.executeSubtask(node, taskId)
        return  // bir node al ve dur — bir sonrakini execute sonrası alacağız
      }
    }
  }

  private async executeSubtask(node: DAGNode, taskId: string): Promise<void> {
    try {
      const agentId = this.deps.config.agentId
      // Worker stake is locked against this specific subtask. It is auto-released
      // when the planner marks the node validated, or partially slashed if a
      // challenge succeeds.
      await this.deps.chain.stakeForSubtask(taskId, node.id, this.deps.config.stakeAmount)
      await this.deps.network.emit(this.buildEvent(EventType.SUBTASK_CLAIMED, { nodeId: node.id, agentId, taskId }))

      let prevOutput: unknown = null
      if (node.prevHash) {
        prevOutput = await this.deps.storage.fetch(node.prevHash)

        // LLM-Judge step
        const isValid = await this.deps.compute.judge(prevOutput as string)
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

      const output = await this.deps.compute.complete(node.subtask, prevOutput as string | null)
      const outputHash = await this.deps.storage.append(output)
      node.status = 'done'
      node.outputHash = outputHash

      // Submit output hash on-chain
      await this.deps.chain.submitOutput(node.id, outputHash)

      console.log(`[Agent ${agentId}] subtask result (${node.id}):`, output.substring(0, 200))

      await this.deps.network.emit(this.buildEvent(EventType.SUBTASK_DONE, {
        nodeId: node.id, outputHash, result: output, agentId, taskId
      }))

      // BEN tamamladım — BEN bir sonrakini claim ederim
      await this.claimNextAfter(node.id, outputHash, taskId)

    } catch (err) {
      console.error(`[Agent ${this.deps.config.agentId}] executeSubtask error:`, err)
    }
  }

  // sadece bu agent'ın tamamladığı node'dan sonrakini claim et
  private async claimNextAfter(doneNodeId: string, outputHash: string, taskId: string): Promise<void> {
    const task = this.tasks.get(taskId)
    if (!task) return

    const agentId = this.deps.config.agentId
    const nodes = task.nodes
    const doneIndex = nodes.findIndex(n => n.id === doneNodeId)

    // bir sonraki node var mı?
    const nextNode = nodes[doneIndex + 1]
    if (!nextNode) {
      // Son node tamamlandı — planner'a denetleme sorumluluğu devret
      // Eğer biz planner'sak, son node'u validate et ve settlement'ı tetikle
      if (this.plannerFor.has(taskId)) {
        await this.validateLastNodeAsPlanner(doneNodeId, outputHash, taskId)
      } else {
        // Son node'u tamamlayan agent planner değilse, DAG_COMPLETED sinyali gönder
        // Planner bu sinyali alıp son node'u denetleyecek
        console.log(`[Agent ${agentId}] Last node done, signaling planner for validation`)
        await this.deps.network.emit(this.buildEvent(EventType.DAG_COMPLETED, {
          taskId,
          lastNodeId: doneNodeId,
          lastOutputHash: outputHash,
          needsPlannerValidation: true,
        }))
      }
      return
    }

    // sonraki node'un prevHash'ini güncelle
    nextNode.prevHash = outputHash
    nextNode.status = undefined as any

    // Skill check the next node too — sequential DAG nodes can require
    // different specializations (research → write → review). If this agent
    // is a poor fit, hand off to the SUBTASK_DONE listeners on other
    // agents who'll race claimFirstAvailable.
    const fits = await this.fitsSkill(nextNode.subtask, false)
    if (!fits) {
      console.log(`[Agent ${agentId}] next node ${nextNode.id} outside skill, leaving for others`)
      this.deps.network.emit(this.buildEvent(EventType.AGENT_PASSED, {
        nodeId: nextNode.id, taskId, agentId, reason: 'outside_skill',
      })).catch(() => {})
      return
    }

    const claimed = await this.deps.chain.claimSubtask(nextNode.id)
    if (claimed) {
      nextNode.status = 'claimed'
      console.log(`[Agent ${agentId}] claimed next: ${nextNode.id}`)
      await this.executeSubtask(nextNode, taskId)
    } else {
      console.log(`[Agent ${agentId}] next node ${nextNode.id} taken by another agent`)
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
      // Son node'un çıktısını storage'dan çek ve LLM-Judge ile denetle
      const lastOutput = await this.deps.storage.fetch(outputHash)
      const isValid = await this.deps.compute.judge(lastOutput as string)

      if (!isValid) {
        console.log(`[Agent ${agentId}] KEEPER: Last node ${lastNodeId} FAILED validation. Challenging.`)
        const lastNode = task.nodes.find(n => n.id === lastNodeId)
        if (lastNode) {
          await this.challengeNode(lastNode, taskId)
        }
        return
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

    const isValid = await this.deps.compute.judge(output as string)
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
    if (event.agentId === this.deps.config.agentId) return

    const task = this.tasks.get(taskId)
    if (!task) return

    const node = task.nodes.find(n => n.id === nodeId)
    if (node) node.status = undefined as any

    await this.claimFirstAvailable(taskId)
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
