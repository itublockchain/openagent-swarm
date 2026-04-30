import { ZGComputeAdapter } from './ZGComputeAdapter'
import { CentralizedZGCompute } from './CentralizedZGCompute'
import { MockCompute } from './mock/MockCompute'
import { MockStorage } from './mock/MockStorage'
import { ZeroGStorage } from './ZeroGStorage'
import { FallbackStorage } from './FallbackStorage'
import { L2Contract } from './L2Contract'
import { MockChain } from './mock/MockChain'
import { AxlNetwork } from '@swarm/shared-infra'
import { IComputePort, IStoragePort } from '../../../../shared/ports'

/**
 * Compute mode selection. Three options:
 *   central (default) — agent calls back to the API's /internal/compute/chat
 *                       endpoint. Single shared 0G Compute ledger across the
 *                       whole swarm. Used for demos to keep per-agent OG cost
 *                       low (~0.5 OG gas vs ~3.5 OG with own ledger).
 *   local            — agent holds its own 0G Compute broker + ledger.
 *                       Production-grade isolation, ~3 OG ledger cost.
 *   mock             — deterministic stub, no network. Tests / dev.
 *
 * Falls back gracefully if env is unset (USE_MOCK=true legacy → mock).
 */
function pickComputeMode(): 'central' | 'local' | 'mock' {
  const raw = process.env.COMPUTE_MODE?.toLowerCase()
  if (raw === 'central' || raw === 'local' || raw === 'mock') return raw
  if (process.env.USE_MOCK === 'true') return 'mock' // legacy alias
  return 'central' // demo default
}

export async function createAdapters(agentId: string) {
  const computeMode = pickComputeMode()

  let compute: IComputePort
  if (computeMode === 'mock') compute = new MockCompute(agentId)
  else if (computeMode === 'local') compute = new ZGComputeAdapter()
  else compute = new CentralizedZGCompute()

  const network = new AxlNetwork()
  await network.connect()

  let storage: IStoragePort
  if (process.env.USE_ZG_STORAGE === 'true') {
    const zg = new ZeroGStorage()
    storage = process.env.STORAGE_FALLBACK === 'true'
      ? new FallbackStorage(zg, new MockStorage(agentId), `FallbackStorage(${agentId})`)
      : zg
  } else {
    storage = new MockStorage(agentId)
  }
  console.log(`[Adapters] Storage: ${storage.constructor.name}`)

  const chain = process.env.USE_L2 === 'true'
    ? new L2Contract(agentId)
    : new MockChain(agentId)
  console.log(`[Adapters] Chain: ${chain.constructor.name}`)

  console.log(`[Adapters] Compute: ${compute.constructor.name}`)

  return {
    storage,
    compute,
    network,
    chain,
  }
}
