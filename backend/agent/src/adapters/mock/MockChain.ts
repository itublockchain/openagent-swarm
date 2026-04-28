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

  async stakeForSubtask(taskId: string, nodeId: string, amount: string): Promise<string> {
    console.log(`[MockChain] subtask stake locked: task=${taskId} node=${nodeId} amount=${amount}`);
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

  async markValidatedBatch(nodeIds: string[]): Promise<void> {
    for (const nid of nodeIds) MockChain.validated.add(nid);
    console.log(`[MockChain] ${nodeIds.length} nodes marked validated (batch)`);
  }

  async getNodeClaimant(nodeId: string): Promise<string> {
    // In mock world the agentId serves as the on-chain address proxy.
    return MockChain.subtaskClaims.get(nodeId) ?? '';
  }

  async getTaskBudget(_taskId: string): Promise<string> {
    // Mock has no escrow accounting; return a fixed default so the
    // planner's settle math has a non-zero divisor in tests.
    return '100000000000000000000'; // 100 mUSDC (18 decimals)
  }

  async settleTask(taskId: string, winners: string[], amounts: string[]): Promise<void> {
    console.log(`[MockChain] settleTask ${taskId}:`,
      winners.map((w, i) => `${w}=${amounts[i]}`).join(', '));
  }

  async completeTask(taskId: string): Promise<boolean> {
    if (MockChain.completedTasks.has(taskId)) return false;
    MockChain.completedTasks.set(taskId, this.agentId);
    return true;
  }

  async syncTaskCompletion(taskId: string, agentId: string): Promise<void> {
    MockChain.completedTasks.set(taskId, agentId);
  }

  async challenge(nodeId: string, challengerNodeId?: string): Promise<void> {
    console.warn(`[MockChain] Challenge initiated for node: ${nodeId} (challenger node: ${challengerNodeId ?? 'planner'})`);
  }

  async voteOnChallenge(nodeId: string, agentId: string, accusedGuilty: boolean): Promise<void> {
    console.log(`[MockChain] Vote on challenge ${nodeId} by ${agentId}: ${accusedGuilty ? 'GUILTY' : 'INNOCENT'}`);
  }

  async finalizeExpiredChallenge(nodeId: string): Promise<void> {
    console.log(`[MockChain] finalizeExpired for ${nodeId} (no-op in mock)`);
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

