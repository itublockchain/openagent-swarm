import { IChainPort } from '../../../../../shared/ports';

export class MockChain implements IChainPort {
  private stakes = new Map<string, string>();
  private plannerClaims = new Map<string, string>(); // taskId -> agentId
  private subtaskClaims = new Map<string, string>(); // nodeId -> agentId

  constructor(private agentId: string) {}

  async stake(taskId: string, amount: string): Promise<string> {
    this.stakes.set(taskId, amount);
    return `fake-tx-hash-${Math.random().toString(36).substring(7)}`;
  }

  async claimPlanner(taskId: string): Promise<boolean> {
    if (!this.plannerClaims.has(taskId)) {
      this.plannerClaims.set(taskId, this.agentId);
      return true;
    }
    return false;
  }

  async claimSubtask(nodeId: string): Promise<boolean> {
    if (!this.subtaskClaims.has(nodeId)) {
      this.subtaskClaims.set(nodeId, this.agentId);
      return true;
    }
    return false;
  }

  async challenge(nodeId: string): Promise<void> {
    console.warn(`[MockChain] Challenge initiated for node: ${nodeId}`);
  }

  async settle(taskId: string, winners: string[]): Promise<void> {
    console.log(`[MockChain] Settlement for task ${taskId}. Winners:`, winners);
  }

  async resetSubtask(nodeId: string): Promise<void> {
    this.subtaskClaims.delete(nodeId);
    console.log(`[MockChain] subtask reset: ${nodeId}`);
  }
}
