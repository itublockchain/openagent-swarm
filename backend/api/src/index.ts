import * as dotenv from 'dotenv';
dotenv.config({ path: '../../.env' });
import createServer from './server';
import { MockStorage } from '../../agent/src/adapters/mock/MockStorage';
import { ZeroGStorage } from '../../agent/src/adapters/ZeroGStorage';
import { FallbackStorage } from '../../agent/src/adapters/FallbackStorage';
import { AxlNetwork } from '@swarm/shared-infra';
import { AgentManager } from './AgentRunner';
import { CentralComputeProxy } from './CentralComputeProxy';
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

  // Optional shared compute proxy. When COMPUTE_MODE=central (default),
  // agents call back to /internal/compute/chat instead of holding their
  // own broker — saves ~3 OG ledger per agent. Disable by setting
  // COMPUTE_MODE=local on the agent side or by leaving the API's
  // PRIVATE_KEY unset (proxy can't initialize without a wallet).
  const computeMode = (process.env.COMPUTE_MODE ?? 'central').toLowerCase();
  let computeProxy: CentralComputeProxy | undefined;
  if (computeMode === 'central') {
    const apiPk = process.env.PRIVATE_KEY;
    if (!apiPk) {
      console.warn('[API] COMPUTE_MODE=central but PRIVATE_KEY missing — proxy disabled');
    } else {
      // Pool size 1 today; expand to N keys (CSV in COMPUTE_POOL_KEYS) for
      // mainnet to spread provider rate limits.
      const csv = process.env.COMPUTE_POOL_KEYS?.trim();
      const keys = csv ? csv.split(',').map((s) => s.trim()).filter(Boolean) : [apiPk];
      computeProxy = new CentralComputeProxy(keys);
    }
  }

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
    manager,
    computeProxy,
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
