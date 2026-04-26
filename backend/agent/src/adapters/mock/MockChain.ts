import { IChainPort } from '../../../../../shared/ports';

export class MockChain implements IChainPort {
  private static stakes = new Map<string, string>();
  private static plannerClaims = new Map<string, string>();
  private static subtaskClaims = new Map<string, string>();
  private static completedTasks = new Map<string, string>();

  constructor(private agentId: string) {
    console.log(`[MockChain] Initialized for ${agentId}`);
  }

  async stake(taskId: string, amount: string): Promise<string> {
    MockChain.stakes.set(taskId, amount);
    return `fake-tx-hash-${Math.random().toString(36).substring(7)}`;
  }

  async claimPlanner(taskId: string): Promise<boolean> {
    if (MockChain.plannerClaims.has(taskId)) return false;
    MockChain.plannerClaims.set(taskId, this.agentId);
    return true;
  }

  async claimSubtask(nodeId: string): Promise<boolean> {
    if (MockChain.subtaskClaims.has(nodeId)) return false;
    MockChain.subtaskClaims.set(nodeId, this.agentId);
    return true;
  }

  async isSubtaskClaimed(nodeId: string): Promise<boolean> {
    return MockChain.subtaskClaims.has(nodeId);
  }

  async completeTask(taskId: string): Promise<boolean> {
    if (MockChain.completedTasks.has(taskId)) return false;
    MockChain.completedTasks.set(taskId, this.agentId);
    return true;
  }

  async challenge(nodeId: string): Promise<void> {
    console.warn(`[MockChain] Challenge initiated for node: ${nodeId}`);
  }

  async settle(taskId: string, winners: string[]): Promise<void> {
    console.log(`[MockChain] Settlement for task ${taskId}. Winners:`, winners);
  }

  async resetSubtask(nodeId: string): Promise<void> {
    MockChain.subtaskClaims.delete(nodeId);
    console.log(`[MockChain] subtask reset: ${nodeId}`);
  }
}

