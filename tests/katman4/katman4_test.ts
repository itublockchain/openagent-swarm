import createServer from '../../backend/api/src/server';
import { MockStorage } from '../../backend/agent/src/adapters/mock/MockStorage';
import { EventBus } from '../../backend/agent/src/core/EventBus';
import { AgentRunner } from '../../backend/api/src/AgentRunner';

// Mock AgentRunner to avoid Docker calls during tests
class MockAgentRunner extends AgentRunner {
  async deploy(config: any) { return 'mock-container-id'; }
  async stop(id: string) { }
  async list() { return [] as any; }
}

async function testKatman4() {
  console.log('--- Katman 4 (API & Runner) Testi Başlıyor ---');

  const storage = new MockStorage('test-api');
  const network = new EventBus('test-api');
  const runner = new MockAgentRunner() as any;

  const server = await createServer({ storage, network, runner });

  // Test POST /task
  const taskResponse = await server.inject({
    method: 'POST',
    url: '/task',
    payload: { spec: 'Test Task', budget: '100' }
  });

  console.log('POST /task Status:', taskResponse.statusCode);
  console.log('POST /task Result:', taskResponse.body);

  const taskId = JSON.parse(taskResponse.body).taskId;

  // Verify event was emitted
  let eventCaptured = false;
  network.on('*', (event) => {
    if (event.payload.taskId === taskId) {
      eventCaptured = true;
      console.log('[Test Verify] TASK_SUBMITTED event captured via EventBus');
    }
  });

  // Test POST /agent/deploy
  const deployResponse = await server.inject({
    method: 'POST',
    url: '/agent/deploy',
    payload: { agentId: 'agent-1', stakeAmount: '50' }
  });

  console.log('POST /agent/deploy Status:', deployResponse.statusCode);
  console.log('POST /agent/deploy Result:', deployResponse.body);

  await server.close();
  
  if (taskResponse.statusCode === 200 && deployResponse.statusCode === 200) {
    console.log('--- Katman 4 Testi Başarıyla Tamamlandı ---');
  } else {
    console.error('--- Katman 4 Testi Başarısız ---');
    process.exit(1);
  }
}

testKatman4().catch(console.error);
