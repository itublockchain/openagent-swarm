import 'dotenv/config'
import { IStoragePort, IComputePort, IChainPort } from '../../../../shared/ports'
import { MockStorage } from './mock/MockStorage'
import { MockCompute } from './mock/MockCompute'
import { MockChain } from './mock/MockChain'
import { RedisNetwork } from '@swarm/shared-infra'

export async function createAdapters(agentId: string): Promise<{
  storage: IStoragePort
  compute: IComputePort
  network: RedisNetwork
  chain: IChainPort
}> {
  const network = new RedisNetwork()
  await network.connect()

  return {
    storage: new MockStorage(agentId),
    compute: new MockCompute(agentId),
    network,
    chain: new MockChain(agentId),
  }
}
