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
  // taskId → { nodes, taskId }
  private tasks = new Map<string, { nodes: DAGNode[], taskId: string }>()
  private currentTaskId: string | null = null
  private lastActivity: number = Date.now()

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

    this.deps.network.on(EventType.DAG_COMPLETED, (event) => {
      const { taskId, agentId } = event.payload as any
      console.log(`[Agent ${this.deps.config.agentId}] Received DAG_COMPLETED for ${taskId} from ${agentId || 'mesh'}`)
      this.deps.chain.syncTaskCompletion(taskId, agentId)
      
      // task bitti, boşa çık
      if (this.currentTaskId === taskId) {
        console.log(`[Agent ${this.deps.config.agentId}] Resetting busy state for task ${taskId}`)
        this.currentTaskId = null
        this.tasks.delete(taskId)
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
      // Sadece planner olmak için yarış, worker dinleyicisi zaten aktif
      const claimed = await this.deps.chain.claimPlanner(taskId)

      if (claimed) {
        this.currentTaskId = taskId
        await this.runAsPlanner(event)
      } else {
        console.log(`[Agent ${this.deps.config.agentId}] lost planner race, acting as worker`)
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

      await this.deps.network.emit(this.buildEvent(EventType.PLANNER_SELECTED, { agentId, taskId }))
      await this.deps.network.emit(this.buildEvent(EventType.DAG_READY, { 
        nodes, 
        taskId, 
        plannerAgentId: agentId 
      }))

      console.log(`[Agent ${agentId}] DAG_READY emitted, ${nodes.length} nodes`)

      // planner DAG_COMPLETED dinler → keeper olur
      this.deps.network.on(EventType.DAG_COMPLETED, () => {
        console.log(`[Agent ${agentId}] keeper role — not implemented yet`)
      })
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
      this.tasks.set(taskId, { nodes, taskId })
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
      // DAG bitti — atomic emit
      const won = await this.deps.chain.completeTask(taskId)
      if (won) {
        console.log(`[Agent ${agentId}] DAG_COMPLETED`)
        await this.deps.network.emit(this.buildEvent(EventType.DAG_COMPLETED, { taskId }))
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
