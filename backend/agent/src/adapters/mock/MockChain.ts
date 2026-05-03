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

  async isTaskFinalized(taskId: string): Promise<boolean> {
    // The keeper-timeout watchdog reads this before paying gas on
    // forceComplete. Reuse the existing completedTasks map — it's set
    // by completeTask + syncTaskCompletion, which is the closest mock
    // analogue to "tasks[taskId].finalized" on the real escrow.
    return MockChain.completedTasks.has(taskId);
  }

  async forceComplete(taskId: string): Promise<void> {
    // Apply the same end-state the on-chain forceComplete would: mark
    // every node validated and finalize the task. No payouts to surface
    // because mock has no escrow ledger; tests can still assert that
    // the watchdog reached this method by inspecting completedTasks.
    const nodeIds = MockChain.dagRegistry.get(taskId) ?? [];
    for (const nid of nodeIds) MockChain.validated.add(nid);
    MockChain.completedTasks.set(taskId, this.agentId);
    console.log(`[MockChain] forceComplete fired for ${taskId} by ${this.agentId} (nodes=${nodeIds.length})`);
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

  async commitVoteOnChallenge(nodeId: string, commitHash: string): Promise<void> {
    console.log(`[MockChain] commitVote on ${nodeId} by ${this.agentId}: hash=${commitHash.slice(0, 18)}...`);
  }

  async isJuryEligible(_nodeId: string, _address: string): Promise<boolean> {
    // No on-chain selection in mock — every agent participates as a juror.
    return true;
  }

  async revealVoteOnChallenge(nodeId: string, accusedGuilty: boolean, salt: string): Promise<void> {
    console.log(`[MockChain] revealVote on ${nodeId}: ${accusedGuilty ? 'GUILTY' : 'INNOCENT'} (salt=${salt.slice(0, 10)}...)`);
  }

  async finalizeChallenge(nodeId: string): Promise<void> {
    console.log(`[MockChain] finalize for ${nodeId} (no-op in mock)`);
  }

  async resetSubtask(nodeId: string): Promise<void> {
    MockChain.subtaskClaims.delete(nodeId);
    MockChain.outputs.delete(nodeId);
    MockChain.validated.delete(nodeId);
    console.log(`[MockChain] subtask reset: ${nodeId}`);
  }

  async getStakeCapacity(_stakeAmount: string): Promise<number> {
    // Mock has no escrow accounting; agents in tests have unbounded stake.
    return Number.MAX_SAFE_INTEGER;
  }

  async getOwnUsdcBalance(): Promise<string> {
    // No on-chain accounting in mock — return 0 so surplus watchdog never
    // triggers a sweep during tests.
    return '0';
  }

  async transferUsdc(to: string, amountWei: string): Promise<string> {
    console.log(`[MockChain] transferUsdc: ${amountWei} wei → ${to} (no-op)`);
    return `mock-tx-${Math.random().toString(36).slice(2, 10)}`;
  }
}

