import { SwarmAgent, AgentDeps } from '../../backend/agent/src/SwarmAgent';
import { MockStorage } from '../../backend/agent/src/adapters/mock/MockStorage';
import { MockCompute } from '../../backend/agent/src/adapters/mock/MockCompute';
import { MockChain } from '../../backend/agent/src/adapters/mock/MockChain';
import { EventBus } from '../../backend/agent/src/core/EventBus';
import { EventType } from '../../shared/types';

async function testKatman3() {
  console.log('--- Katman 3 (SwarmAgent Logic) Testi Başlıyor ---');

  const agent1Id = 'agent-1-planner';
  const agent2Id = 'agent-2-worker';

  // Shared instances for the same "network"
  const bus = new EventBus('shared-bus');
  const sharedChain = new MockChain('shared-chain'); // Shared state
  const sharedStorage = new MockStorage('shared-storage'); // Shared state

  const createAgent = (id: string) => {
    const deps: AgentDeps = {
      storage: sharedStorage,
      compute: new MockCompute(id), // Compute can be local or shared, here local is fine
      chain: sharedChain,
      network: bus,
      config: { agentId: id, stakeAmount: '100' }
    };
    return new SwarmAgent(deps);
  };

  const agent1 = createAgent(agent1Id);
  const agent2 = createAgent(agent2Id);

  agent1.start();
  agent2.start();

  // Listen for final events to verify flow
  let subtaskDoneCount = 0;
  bus.on(EventType.SUBTASK_DONE, (event) => {
    subtaskDoneCount++;
    console.log(`[Test Verify] Subtask done by ${event.agentId}. Total: ${subtaskDoneCount}`);
  });

  // Emit task
  console.log('[Test] Emitting TASK_SUBMITTED...');
  await bus.emit({
    type: EventType.TASK_SUBMITTED,
    payload: { taskId: 'task-test', spec: 'Multi-agent test spec' },
    timestamp: Date.now(),
    agentId: 'user'
  });

  // Wait for flow to complete (since it's mock and async)
  await new Promise(resolve => setTimeout(resolve, 2000));

  if (subtaskDoneCount > 0) {
    console.log('--- Katman 3 Testi Başarıyla Tamamlandı ---');
  } else {
    console.error('--- Katman 3 Testi Başarısız: Hiç subtask tamamlanmadı ---');
    process.exit(1);
  }
}

testKatman3().catch(console.error);
