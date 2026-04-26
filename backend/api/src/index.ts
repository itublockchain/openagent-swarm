import 'dotenv/config';
import createServer from './server';
import { MockStorage } from '../../agent/src/adapters/mock/MockStorage';
import { AxlNetwork } from '@swarm/shared-infra';
import { AgentManager } from './AgentRunner';

const PORT = Number(process.env.PORT) || 3001;

async function start() {
  const agentId = 'api-core';
  
  // Choose implementation based on ENV
  const storage = new MockStorage(agentId);
  const network = new AxlNetwork();
  await network.connect();
  
  const manager = new AgentManager();

  const server = await createServer({
    storage,
    network,
    manager
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
