import * as dotenv from 'dotenv';
dotenv.config({ path: '../../.env' });
import createServer from './server';
import { MockStorage } from '../../agent/src/adapters/mock/MockStorage';
import { ZeroGStorage } from '../../agent/src/adapters/ZeroGStorage';
import { FallbackStorage } from '../../agent/src/adapters/FallbackStorage';
import { AxlNetwork } from '@swarm/shared-infra';
import { AgentManager } from './AgentRunner';
import { IStoragePort } from '../../../shared/ports';

const PORT = Number(process.env.PORT) || 3001;

async function start() {
  const agentId = 'api-core';

  let storage: IStoragePort;
  if (process.env.USE_ZG_STORAGE === 'true') {
    const zg = new ZeroGStorage();
    storage = process.env.STORAGE_FALLBACK === 'true'
      ? new FallbackStorage(zg, new MockStorage(agentId), `FallbackStorage(${agentId})`)
      : zg;
  } else {
    storage = new MockStorage(agentId);
  }
  console.log(`[API] Storage: ${storage.constructor.name}`);

  const network = new AxlNetwork();
  await network.connect();
  
  const manager = new AgentManager();
  // Reconcile against on-chain registry + Docker before serving traffic, so
  // /agent/pool reflects reality from the very first request after restart.
  // Failures here are logged but non-fatal — a partially-restored pool is
  // still better than a dead API.
  try {
    await manager.restore();
  } catch (err) {
    console.error('[API] manager.restore() failed:', err);
  }

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
