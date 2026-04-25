import { MockStorage } from '../../backend/agent/src/adapters/mock/MockStorage';
import { MockCompute } from '../../backend/agent/src/adapters/mock/MockCompute';
import { MockChain } from '../../backend/agent/src/adapters/mock/MockChain';
import { EventBus } from '../../backend/agent/src/core/EventBus';
import { EventType, AXLEvent } from '../../shared/types';

async function testKatman2() {
  console.log('--- Katman 2 (Mock Adapters & EventBus) Testi Başlıyor ---');

  const agentId = 'test-agent-001';

  // 1. Storage Test
  const storage = new MockStorage(agentId);
  const data = { message: 'Secret Swarm Data' };
  const hash = await storage.append(data);
  console.log('Storage Hash:', hash);
  const fetched = await storage.fetch(hash);
  console.log('Storage Fetch Success:', JSON.stringify(fetched) === JSON.stringify(data));

  // 2. Compute Test
  const compute = new MockCompute(agentId);
  const dag = await compute.buildDAG('Analyze Swarm');
  console.log('DAG Node Count:', dag.length);
  console.log('Judge Result:', await compute.judge('some output'));

  // 3. Chain Test
  const chain = new MockChain(agentId);
  const claim1 = await chain.claimPlanner('task-1');
  const claim2 = await chain.claimPlanner('task-1');
  console.log('First Claim Success:', claim1);
  console.log('Second Claim Failed:', !claim2);

  // 4. EventBus Test
  const bus = new EventBus(agentId);
  bus.on(EventType.TASK_SUBMITTED, (event) => {
    console.log(`[Test] Event Alındı: ${event.type}, Payload:`, event.payload);
  });

  const testEvent: AXLEvent = {
    type: EventType.TASK_SUBMITTED,
    payload: { taskId: 'task-1' },
    timestamp: Date.now(),
    agentId: agentId
  };

  await bus.emit(testEvent);

  console.log('--- Katman 2 Testi Tamamlandı ---');
}

testKatman2().catch(console.error);
