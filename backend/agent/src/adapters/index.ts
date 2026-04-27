import { OpenAICompute } from './OpenAICompute'
import { MockCompute } from './mock/MockCompute'
import { MockStorage } from './mock/MockStorage'
import { ZeroGStorage } from './ZeroGStorage'
import { L2Contract } from './L2Contract'
import { MockChain } from './mock/MockChain'
import { AxlNetwork } from '@swarm/shared-infra'

export async function createAdapters(agentId: string) {
  const useMock = process.env.USE_MOCK === 'true'

  const compute = useMock
    ? new MockCompute(agentId)
    : new OpenAICompute()

  const network = new AxlNetwork()
  await network.connect()

  const storage = process.env.USE_ZG_STORAGE === 'true'
    ? new ZeroGStorage()
    : new MockStorage(agentId)

  const chain = process.env.USE_L2 === 'true'
    ? new L2Contract(agentId)
    : new MockChain(agentId)

  return {
    storage,
    compute,
    network,
    chain,
  }
}
