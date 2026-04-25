import { IChainPort, INetworkPort } from '../../../../shared/ports'
import { EventType } from '../../../../shared/types'
import { AgentRole } from '../../../../shared/types'

interface BootstrapState {
  role: AgentRole | 'idle'
  taskId: string | null
  nodeIds: string[]
}

export class StateSync {
  private intervalId: ReturnType<typeof setInterval> | null = null

  constructor(
    private chain: IChainPort,
    private network: INetworkPort,
    private agentId: string,
  ) {}

  async bootstrap(): Promise<BootstrapState> {
    try {
      const activeTasks = await this.chain.getActiveTasks()

      for (const taskId of activeTasks) {
        const planner = await this.chain.getPlannerOf(taskId)
        if (planner === this.agentId) {
          console.log(`[StateSync] resuming as planner for ${taskId}`)
          return { role: 'planner', taskId, nodeIds: [] }
        }

        const nodeIds = await this.chain.getClaimedSubtasks(this.agentId)
        if (nodeIds.length > 0) {
          console.log(`[StateSync] resuming as worker, nodes: ${nodeIds}`)
          return { role: 'worker', taskId, nodeIds }
        }
      }

      console.log(`[StateSync] no active role found, idle`)
      return { role: 'idle', taskId: null, nodeIds: [] }
    } catch (err) {
      console.error('[StateSync] bootstrap error:', err)
      return { role: 'idle', taskId: null, nodeIds: [] }
    }
  }

  async reconcile(): Promise<void> {
    try {
      const state = await this.bootstrap()
      await this.network.emit({
        type: EventType.STATE_RECONCILED,
        payload: state,
        timestamp: Date.now(),
        agentId: this.agentId,
      })
    } catch (err) {
      console.error('[StateSync] reconcile error:', err)
    }
  }

  start(intervalMs = 30_000): void {
    this.intervalId = setInterval(() => this.reconcile(), intervalMs)
    console.log(`[StateSync] started, interval: ${intervalMs}ms`)
  }

  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId)
      this.intervalId = null
    }
  }
}
