import { ZGComputeAdapter } from './ZGComputeAdapter'
import { MockCompute } from './mock/MockCompute'
import { MockStorage } from './mock/MockStorage'
import { MockChain } from './mock/MockChain'
import { AxlNetwork } from '@swarm/shared-infra'

export async function createAdapters(agentId: string) {
  const useMock = process.env.USE_MOCK === 'true'

  const compute = useMock
    ? new MockCompute(agentId)
    : new ZGComputeAdapter()

  const network = new AxlNetwork()
  await network.connect()

  return {
    storage: new MockStorage(agentId),
    compute,
    network,
    chain: new MockChain(agentId),
  }
}
