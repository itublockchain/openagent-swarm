import 'dotenv/config';
import createServer from './server';
import { MockStorage, RedisNetwork } from '@swarm/shared-infra';
import { AgentRunner } from './AgentRunner';

const PORT = Number(process.env.PORT) || 3001;

async function start() {
  const agentId = 'api-core';
  
  const storage = new MockStorage(agentId); 
  const network = new RedisNetwork();
  await network.connect();
  
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

  // graceful shutdown
  process.on('SIGTERM', async () => {
    await network.disconnect();
    process.exit(0);
  });
}

start();
