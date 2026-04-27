import { ZGComputeAdapter } from './ZGComputeAdapter'
import { MockCompute } from './mock/MockCompute'
import { MockStorage } from './mock/MockStorage'
import { ZeroGStorage } from './ZeroGStorage'
import { FallbackStorage } from './FallbackStorage'
import { L2Contract } from './L2Contract'
import { MockChain } from './mock/MockChain'
import { AxlNetwork } from '@swarm/shared-infra'
import { IStoragePort } from '../../../../shared/ports'

export async function createAdapters(agentId: string) {
  const useMock = process.env.USE_MOCK === 'true'

  const compute = useMock
    ? new MockCompute(agentId)
    : new ZGComputeAdapter()

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
