import { IStoragePort, IComputePort, INetworkPort, IChainPort } from '../../../shared/ports';
import { EventType, DAGNode, AgentConfig, AXLEvent } from '../../../shared/types';
import { ConfirmationTimeoutError, TransactionFailedError } from './core/ConfirmationGuard';

export interface AgentDeps {
  storage: IStoragePort;
  compute: IComputePort;
  network: INetworkPort;
  chain: IChainPort;
  config: AgentConfig;
}

export class SwarmAgent {
  constructor(private deps: AgentDeps) {}

  public async start(): Promise<void> {
    try {
      this.deps.network.on(EventType.TASK_SUBMITTED, (event) => this.onTaskSubmitted(event));
      console.log(`[Agent ${this.deps.config.agentId}] started`);
    } catch (err) {
      console.error(`[Agent ${this.deps.config.agentId}] start error:`, err);
    }
  }

  private async onTaskSubmitted(event: AXLEvent<any>): Promise<void> {
    try {
      const taskId = event.payload.taskId;
      const claimed = await this.deps.chain.claimPlanner(taskId);

      if (claimed) {
        await this.runAsPlanner(event);
      } else {
        this.waitForDAG();
      }
    } catch (err) {
      if (err instanceof ConfirmationTimeoutError || err instanceof TransactionFailedError) {
        console.warn(`[Agent ${this.deps.config.agentId}] L2 confirmation failed, pulling out of task: ${err.message}`);
        return;
      }
      console.error(`[Agent ${this.deps.config.agentId}] onTaskSubmitted error:`, err);
    }
  }

  private async runAsPlanner(event: AXLEvent<any>): Promise<void> {
    try {
      const { taskId, spec } = event.payload;
      const agentId = this.deps.config.agentId;

      console.log(`[Agent ${agentId}] acting as Planner for task ${taskId}`);

      const nodes = await this.deps.compute.buildDAG(spec);
      const dagHash = await this.deps.storage.append(nodes);

      await this.deps.chain.stake(taskId, this.deps.config.stakeAmount);

      await this.deps.network.emit(this.buildEvent(EventType.PLANNER_SELECTED, { agentId, taskId }));

      // Append each node to storage for workers to fetch if needed
      for (const node of nodes) {
        await this.deps.storage.append(node);
      }

      await this.deps.network.emit(this.buildEvent(EventType.DAG_READY, { dagHash, nodes, taskId }));

      this.deps.network.on(EventType.DAG_COMPLETED, () => this.runAsKeeper());
    } catch (err) {
      if (err instanceof ConfirmationTimeoutError || err instanceof TransactionFailedError) {
        console.warn(`[Agent ${this.deps.config.agentId}] L2 confirmation failed as Planner: ${err.message}`);
        return;
      }
      console.error(`[Agent ${this.deps.config.agentId}] runAsPlanner error:`, err);
    }
  }

  private waitForDAG(): void {
    console.log(`[Agent ${this.deps.config.agentId}] waiting for DAG...`);
    this.deps.network.on(EventType.DAG_READY, (event: AXLEvent<any>) => this.onDAGReady(event));
  }

  private async onDAGReady(event: AXLEvent<any>): Promise<void> {
    try {
      const { nodes, taskId } = event.payload;
      const agentId = this.deps.config.agentId;

      for (const node of nodes) {
        const claimed = await this.deps.chain.claimSubtask(node.id);
        if (claimed) {
          console.log(`[Agent ${agentId}] claimed subtask ${node.id}`);
          await this.executeSubtask(node, taskId);
          break; // Claim one subtask at a time in this simple mock
        }
      }
    } catch (err) {
      console.error(`[Agent ${this.deps.config.agentId}] onDAGReady error:`, err);
    }
  }

  private async executeSubtask(node: DAGNode, taskId: string): Promise<void> {
    try {
      const agentId = this.deps.config.agentId;
      await this.deps.chain.stake(taskId, this.deps.config.stakeAmount);

      await this.deps.network.emit(this.buildEvent(EventType.SUBTASK_CLAIMED, { nodeId: node.id, agentId, taskId }));

      let prevOutput: unknown = null;
      if (node.prevHash) {
        prevOutput = await this.deps.storage.fetch(node.prevHash);
        const isValid = await this.deps.compute.judge(prevOutput as string);
        if (!isValid) {
          await this.deps.chain.challenge(node.id);
          await this.deps.network.emit(this.buildEvent(EventType.CHALLENGE, { nodeId: node.id, agentId, taskId }));
          return;
        }
      }

      const output = await this.deps.compute.complete(node.subtask, prevOutput as string | null);
      const outputHash = await this.deps.storage.append(output);

      await this.deps.network.emit(this.buildEvent(EventType.SUBTASK_DONE, { nodeId: node.id, outputHash, agentId, taskId }));
    } catch (err) {
      if (err instanceof ConfirmationTimeoutError || err instanceof TransactionFailedError) {
        console.warn(`[Agent ${this.deps.config.agentId}] L2 confirmation failed as Worker: ${err.message}`);
        return;
      }
      console.error(`[Agent ${this.deps.config.agentId}] executeSubtask error:`, err);
    }
  }

  private async runAsKeeper(): Promise<void> {
    // TODO Katman 5 — KeeperHub entegrasyonu
    console.log(`[Agent ${this.deps.config.agentId}] keeper role — not implemented yet`);
  }

  private buildEvent<T>(type: EventType, payload: T): AXLEvent<T> {
    return {
      type,
      payload,
      timestamp: Date.now(),
      agentId: this.deps.config.agentId
    };
  }
}
