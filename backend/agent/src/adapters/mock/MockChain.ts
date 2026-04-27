import { IChainPort } from '../../../../../shared/ports';

export class MockChain implements IChainPort {
  private static stakes = new Map<string, string>();
  private static plannerClaims = new Map<string, string>();
  private static subtaskClaims = new Map<string, string>();
  private static completedTasks = new Map<string, string>();
  private static dagRegistry = new Map<string, string[]>();
  private static outputs = new Map<string, string>();
  private static validated = new Set<string>();

  constructor(private agentId: string) {
    console.log(`[MockChain] Initialized for ${agentId}`);
  }

  async stake(taskId: string, amount: string): Promise<string> {
    MockChain.stakes.set(taskId, amount);
    return `fake-tx-hash-${Math.random().toString(36).substring(7)}`;
  }

  async claimPlanner(taskId: string): Promise<boolean> {
    const existing = MockChain.plannerClaims.get(taskId);
    if (existing && existing !== this.agentId) return false;

    MockChain.plannerClaims.set(taskId, this.agentId);
    return true;
  }

  async registerDAG(taskId: string, nodeIds: string[]): Promise<void> {
    MockChain.dagRegistry.set(taskId, nodeIds);
    console.log(`[MockChain] DAG registered for task ${taskId} with ${nodeIds.length} nodes`);
  }

  // External sync from network events
  async syncPlannerClaim(taskId: string, agentId: string): Promise<void> {
    const existing = MockChain.plannerClaims.get(taskId);
    // Tie-break: smallest agentId wins to ensure all agents agree on same planner
    if (!existing || agentId < existing) {
      MockChain.plannerClaims.set(taskId, agentId);
    }
  }

  async claimSubtask(nodeId: string): Promise<boolean> {
    if (MockChain.subtaskClaims.has(nodeId)) return false;
    MockChain.subtaskClaims.set(nodeId, this.agentId);
    return true;
  }

  async syncSubtaskClaim(nodeId: string, agentId: string): Promise<void> {
    MockChain.subtaskClaims.set(nodeId, agentId);
  }

  async isSubtaskClaimed(nodeId: string): Promise<boolean> {
    return MockChain.subtaskClaims.has(nodeId);
  }

  async submitOutput(nodeId: string, outputHash: string): Promise<void> {
    MockChain.outputs.set(nodeId, outputHash);
    console.log(`[MockChain] Output submitted for node ${nodeId}: ${outputHash}`);
  }

  async markValidated(nodeId: string): Promise<void> {
    MockChain.validated.add(nodeId);
    console.log(`[MockChain] Node ${nodeId} marked validated`);
  }

  async completeTask(taskId: string): Promise<boolean> {
    if (MockChain.completedTasks.has(taskId)) return false;
    MockChain.completedTasks.set(taskId, this.agentId);
    return true;
  }

  async syncTaskCompletion(taskId: string, agentId: string): Promise<void> {
    MockChain.completedTasks.set(taskId, agentId);
  }

  async challenge(nodeId: string): Promise<void> {
    console.warn(`[MockChain] Challenge initiated for node: ${nodeId}`);
  }

  async settle(taskId: string, winners: string[]): Promise<void> {
    console.log(`[MockChain] Settlement for task ${taskId}. Winners:`, winners);
  }

  async resetSubtask(nodeId: string): Promise<void> {
    MockChain.subtaskClaims.delete(nodeId);
    MockChain.outputs.delete(nodeId);
    MockChain.validated.delete(nodeId);
    console.log(`[MockChain] subtask reset: ${nodeId}`);
  }
}

