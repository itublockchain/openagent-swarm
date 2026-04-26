import { IComputePort } from '../../../../../shared/ports';
import { DAGNode } from '../../../../../shared/types';

export class MockCompute implements IComputePort {
  constructor(private agentId: string) {}

  async buildDAG(spec: string): Promise<DAGNode[]> {
    const suffix = Math.random().toString(36).substring(7);
    const n1 = `node-1-${suffix}`;
    const n2 = `node-2-${suffix}`;
    const n3 = `node-3-${suffix}`;

    return [
      {
        id: n1,
        subtask: `Process part 1 of ${spec}`,
        prevHash: null,
        status: 'idle',
        claimedBy: null
      },
      {
        id: n2,
        subtask: `Process part 2 of ${spec}`,
        prevHash: `${n1}-hash`,
        status: 'idle',
        claimedBy: null
      },
      {
        id: n3,
        subtask: `Process part 3 of ${spec}`,
        prevHash: `${n2}-hash`,
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
}
