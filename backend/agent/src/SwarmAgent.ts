import { IStoragePort, IComputePort, INetworkPort, IChainPort } from '../../../shared/ports';
import { EventType, DAGNode, AgentConfig, AXLEvent } from '../../../shared/types';

export interface AgentDeps {
  storage: IStoragePort;
  compute: IComputePort;
  network: INetworkPort;
  chain: IChainPort;
  config: AgentConfig;
}

export class SwarmAgent {
  private dagCache = new Map<string, DAGNode>();

  constructor(private deps: AgentDeps) {}

  public async start(): Promise<void> {
    try {
      this.deps.network.on(EventType.TASK_SUBMITTED, (event) => {
        this.onTaskSubmitted(event);
      });
      this.deps.network.on(EventType.TASK_REOPENED, (event) => {
        this.onTaskReopened(event);
      });
      this.deps.network.on(EventType.DAG_READY, (event) => {
        this.onDAGReady(event);
      });
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
      }
    } catch (err) {
      console.error(`[Agent ${this.deps.config.agentId}] onTaskSubmitted error:`, err);
    }
  }

  private async runAsPlanner(event: AXLEvent<any>): Promise<void> {
    try {
      const { taskId, spec } = event.payload;
      const agentId = this.deps.config.agentId;

      console.log(`[Agent ${agentId}] runAsPlanner started, spec: ${spec}`);

      const nodes = await this.deps.compute.buildDAG(spec);
      console.log(`[Agent ${agentId}] DAG built, nodes: ${nodes.length}`);

      const dagHash = await this.deps.storage.append(nodes);
      console.log(`[Agent ${agentId}] DAG stored, hash: ${dagHash}`);

      await this.deps.chain.stake(taskId, this.deps.config.stakeAmount);
      console.log(`[Agent ${agentId}] staked`);

      await this.deps.network.emit(this.buildEvent(EventType.PLANNER_SELECTED, { agentId, taskId }));
      console.log(`[Agent ${agentId}] PLANNER_SELECTED emitted`);

      for (const node of nodes) {
        await this.deps.storage.append(node);
      }

      await this.deps.network.emit(this.buildEvent(EventType.DAG_READY, { dagHash, nodes, taskId }));
      console.log(`[Agent ${agentId}] DAG_READY emitted`);

      this.deps.network.on(EventType.DAG_COMPLETED, (event) => {
        this.runAsKeeper();
      });
    } catch (err) {
      console.error(`[Agent ${this.deps.config.agentId}] runAsPlanner FAILED:`, err);
    }
  }


  private async onDAGReady(event: AXLEvent<any>): Promise<void> {
    try {
      const { nodes, taskId } = event.payload;
      const agentId = this.deps.config.agentId;

      nodes.forEach((node: DAGNode) => this.dagCache.set(node.id, node));

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
          await this.challengeNode(node, taskId);
          return;
        }
      }

      const output = await this.deps.compute.complete(node.subtask, prevOutput as string | null);
      const outputHash = await this.deps.storage.append(output);

      await this.deps.network.emit(this.buildEvent(EventType.SUBTASK_DONE, { nodeId: node.id, outputHash, agentId, taskId }));
    } catch (err) {
      console.error(`[Agent ${this.deps.config.agentId}] executeSubtask error:`, err);
    }
  }

  private async runAsKeeper(): Promise<void> {
    // TODO Katman 5 — KeeperHub entegrasyonu
    console.log(`[Agent ${this.deps.config.agentId}] keeper role — not implemented yet`);
  }

  private async challengeNode(node: DAGNode, taskId: string): Promise<void> {
    try {
      await this.deps.chain.challenge(node.id);
      
      await this.deps.network.emit(this.buildEvent(EventType.CHALLENGE, {
        nodeId: node.id,
        taskId,
        agentId: this.deps.config.agentId,
      }));

      await this.deps.chain.resetSubtask(node.id);

      await this.deps.network.emit(this.buildEvent(EventType.TASK_REOPENED, {
        nodeId: node.id,
        taskId,
        reason: 'validation_failed',
      }));

      console.log(`[Agent ${this.deps.config.agentId}] challenged node ${node.id}, reopened for re-auction`);
    } catch (err) {
      console.error(`[Agent ${this.deps.config.agentId}] challenge error:`, err);
    }
  }

  private async onTaskReopened(event: AXLEvent<any>): Promise<void> {
    const { nodeId, taskId } = event.payload;

    if (event.agentId === this.deps.config.agentId) return;

    console.log(`[Agent ${this.deps.config.agentId}] heard TASK_REOPENED for node ${nodeId}, attempting re-claim`);

    try {
      const claimed = await this.deps.chain.claimSubtask(nodeId);
      if (!claimed) {
        console.log(`[Agent ${this.deps.config.agentId}] node ${nodeId} already claimed by another agent`);
        return;
      }

      const node = this.dagCache.get(nodeId);
      if (!node) {
        console.warn(`[Agent ${this.deps.config.agentId}] node ${nodeId} not in cache, skipping`);
        return;
      }

      console.log(`[Agent ${this.deps.config.agentId}] re-claimed node ${nodeId}, executing`);
      await this.executeSubtask(node, taskId);
    } catch (err) {
      console.error(`[Agent ${this.deps.config.agentId}] re-claim error:`, err);
    }
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
