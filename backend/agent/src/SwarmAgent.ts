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
      // sadece ilk node'u claim etmeye çalış
      await this.claimFirstAvailable(taskId)
    } catch (err) {
      console.error(`[Agent ${this.deps.config.agentId}] onDAGReady error:`, err)
    }
  }

  private async claimFirstAvailable(taskId: string): Promise<void> {
    const task = this.tasks.get(taskId)
    if (!task) return

    for (const node of task.nodes) {
      // prevHash henüz gerçek storage hash değilse (bağımlılık bitmediyse) atla
      // Gerçek hash'lerde 'placeholder-' kelimesi geçmez.
      if (node.prevHash && node.prevHash.includes('placeholder-')) continue

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
      await this.deps.chain.stake(taskId, this.deps.config.stakeAmount)
      await this.deps.network.emit(this.buildEvent(EventType.SUBTASK_CLAIMED, { nodeId: node.id, agentId, taskId }))

      let prevOutput: unknown = null
      if (node.prevHash) {
        prevOutput = await this.deps.storage.fetch(node.prevHash)
        
        // LLM-Judge step
        const isValid = await this.deps.compute.judge(prevOutput as string)
        if (!isValid) {
          console.log(`[Agent ${this.deps.config.agentId}] LLM-Judge rejected output. Challenging previous node.`)
          
          // Find the previous node id to challenge
          const task = this.tasks.get(taskId)
          if (task) {
            const currentIndex = task.nodes.findIndex(n => n.id === node.id)
            if (currentIndex > 0) {
              const prevNode = task.nodes[currentIndex - 1]
              await this.challengeNode(prevNode, taskId)
            }
          }
          return // Stop execution of current subtask
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

      console.log(`[Agent ${agentId}] KEEPER: Last node ${lastNodeId} validated. Marking all nodes on-chain.`)

      // Tüm node'ları on-chain'de validated olarak işaretle
      // markValidated son node'da çağrıldığında, kontrat otomatik olarak
      // tüm DAG'ın bittiğini algılayıp escrow.settle() tetikler
      for (const node of task.nodes) {
        await this.deps.chain.markValidated(node.id)
      }

      const won = await this.deps.chain.completeTask(taskId)
      if (won) {
        console.log(`[Agent ${agentId}] KEEPER: DAG_COMPLETED — settlement triggered on-chain`)
        await this.deps.network.emit(this.buildEvent(EventType.DAG_COMPLETED, { taskId, settled: true }))
      }
    } catch (err) {
      console.error(`[Agent ${agentId}] KEEPER validation error:`, err)
    }
  }

  private async challengeNode(node: DAGNode, taskId: string): Promise<void> {
    try {
      await this.deps.chain.challenge(node.id)
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
}
