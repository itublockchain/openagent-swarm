import { IStoragePort, IComputePort, INetworkPort, IChainPort } from '../shared/ports';
import { EventType, AXLEvent, DAGNode } from '../shared/types';

/**
 * Mock implementation of IStoragePort for testing purposes.
 */
const mockStorage: IStoragePort = {
  append: async (data: string) => `hash:${data.length}`,
  fetch: async (hash: string) => ({ data: 'test' })
};

/**
 * Mock implementation of IComputePort for testing purposes.
 */
const mockCompute: IComputePort = {
  buildDAG: async (spec: string) => [
    { id: '1', subtask: 'task1', prevHash: '0', status: 'idle' }
  ],
  complete: async (subtask: any) => 'receipt:done',
  judge: async (output: any, schema: any) => true
};

/**
 * Mock implementation of INetworkPort for testing purposes.
 */
const mockNetwork: INetworkPort = {
  emit: async (event: AXLEvent) => console.log('Emitted:', event.type),
  on: (type: EventType, handler: (event: AXLEvent) => void) => {
    console.log('Registered listener for:', type);
  }
};

/**
 * Mock implementation of IChainPort for testing purposes.
 */
const mockChain: IChainPort = {
  stake: async (taskId: string, amount: string) => 'tx:0x123',
  claimPlanner: async (taskId: string) => true,
  claimSubtask: async (nodeId: string) => true,
  challenge: async (nodeId: string) => console.log('Challenged:', nodeId),
  settle: async (taskId: string, winners: string[]) => console.log('Settled:', taskId)
};

async function runLayer1Test() {
  console.log('--- Starting Layer 1 (Types & Ports) Verification ---');

  // 1. Test Storage
  const hash = await mockStorage.append('Hello Swarm');
  console.log('Storage Append Result:', hash);

  // 2. Test Compute
  const dag = await mockCompute.buildDAG('Main Task');
  console.log('Generated DAG Nodes:', dag.length);

  // 3. Test Network
  const event: AXLEvent = {
    type: EventType.TASK_SUBMITTED,
    payload: { taskId: '123' },
    timestamp: Date.now(),
    agentId: 'agent_01'
  };
  await mockNetwork.emit(event);

  // 4. Test Chain
  const tx = await mockChain.stake('123', '1000');
  console.log('Stake Transaction:', tx);

  console.log('--- Layer 1 Verification Completed Successfully ---');
}

runLayer1Test().catch(console.error);
