import 'dotenv/config';
import createServer from './server';
import { MockStorage } from '../../agent/src/adapters/mock/MockStorage';
import { EventBus } from '../../agent/src/core/EventBus';
import { AgentRunner } from './AgentRunner';

const PORT = Number(process.env.PORT) || 3001;
const USE_MOCK = process.env.USE_MOCK !== 'false';

async function start() {
  const agentId = 'api-core';
  
  // Choose implementation based on ENV
  const storage = new MockStorage(agentId); // In a real app, this would check USE_MOCK
  const network = new EventBus(agentId);
  const runner = new AgentRunner();

  const server = await createServer({
    storage,
    network,
    runner
  });

  try {
    await server.listen({ port: PORT, host: '0.0.0.0' });
    console.log(`[API] Server listening on port ${PORT}`);
  } catch (err) {
    server.log.error(err);
    process.exit(1);
  }
}

start();
