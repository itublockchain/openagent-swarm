import { IComputePort } from '../../../../../shared/ports';
import { DAGNode } from '../../../../../shared/types';

export class MockCompute implements IComputePort {
  constructor(private agentId: string) {}

  async buildDAG(spec: string): Promise<DAGNode[]> {
    return [
      {
        id: 'node-1',
        subtask: `Process part 1 of ${spec}`,
        prevHash: null,
        status: 'idle',
        claimedBy: null
      },
      {
        id: 'node-2',
        subtask: `Process part 2 of ${spec}`,
        prevHash: 'placeholder-1',
        status: 'idle',
        claimedBy: null
      },
      {
        id: 'node-3',
        subtask: `Process part 3 of ${spec}`,
        prevHash: 'placeholder-2',
        status: 'idle',
        claimedBy: null
      }
    ];
  }

  async complete(subtask: string, context: string | null): Promise<string> {
    return `[${subtask}] completed with context: ${context ?? 'none'}`;
  }

  async judge(output: string): Promise<boolean> {
    // Return true to ensure demo completes successfully
    return true;
  }

  async assess(_subtask: string, _systemPrompt: string): Promise<boolean> {
    // Mock agents claim everything — the production self-selection logic
    // belongs in ZGComputeAdapter.
    return true;
  }

  /**
   * Stub chat for the agent loop. Echoes a canned final-action JSON so
   * loop runs deterministically in mock mode without hitting any LLM.
   * The agent loop will treat this as a final answer and exit cleanly.
   */
  async chat(messages: Array<{ role: string; content: string }>, _maxTokens?: number): Promise<string> {
    const lastUser = [...messages].reverse().find((m) => m.role === 'user')?.content ?? ''
    const stub = `[mock] processed: ${lastUser.slice(0, 100)}`
    return JSON.stringify({ action: 'final', answer: stub })
  }
}
