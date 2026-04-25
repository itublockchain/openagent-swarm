import { IChainPort } from '../../../../../shared/ports';
import * as fs from 'fs';
import * as path from 'path';

const STATE_FILE = path.join(process.cwd(), '../../../../mock-chain-state.json');

export class MockChain implements IChainPort {
  constructor(private agentId: string) {
    if (!fs.existsSync(STATE_FILE)) {
      fs.writeFileSync(STATE_FILE, JSON.stringify({
        stakes: {},
        plannerClaims: {},
        subtaskClaims: {}
      }));
    }
  }

  private getState() {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  }

  private saveState(state: any) {
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  }

  async stake(taskId: string, amount: string): Promise<string> {
    const state = this.getState();
    state.stakes[taskId] = amount;
    this.saveState(state);
    return `fake-tx-hash-${Math.random().toString(36).substring(7)}`;
  }

  async claimPlanner(taskId: string): Promise<boolean> {
    const state = this.getState();
    if (!state.plannerClaims[taskId]) {
      state.plannerClaims[taskId] = this.agentId;
      this.saveState(state);
      return true;
    }
    return state.plannerClaims[taskId] === this.agentId;
  }

  async claimSubtask(nodeId: string): Promise<boolean> {
    const state = this.getState();
    if (!state.subtaskClaims[nodeId]) {
      state.subtaskClaims[nodeId] = this.agentId;
      this.saveState(state);
      return true;
    }
    return state.subtaskClaims[nodeId] === this.agentId;
  }

  async challenge(nodeId: string): Promise<void> {
    console.warn(`[MockChain] Challenge initiated for node: ${nodeId}`);
  }

  async settle(taskId: string, winners: string[]): Promise<void> {
    console.log(`[MockChain] Settlement for task ${taskId}. Winners:`, winners);
  }

  async getActiveTasks(): Promise<string[]> {
    return Object.keys(this.getState().plannerClaims);
  }

  async getPlannerOf(taskId: string): Promise<string> {
    return this.getState().plannerClaims[taskId] || '';
  }

  async getClaimedSubtasks(agentId: string): Promise<string[]> {
    const state = this.getState();
    return Object.entries(state.subtaskClaims)
      .filter(([_, id]) => id === agentId)
      .map(([nodeId, _]) => nodeId);
  }
}
