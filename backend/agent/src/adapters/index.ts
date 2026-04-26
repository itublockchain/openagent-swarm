import 'dotenv/config'
import { IStoragePort, IComputePort, IChainPort } from '@swarm/shared/ports';
import { MockStorage, RedisNetwork } from '@swarm/shared-infra';
import { MockCompute } from './mock/MockCompute';
import { MockChain } from './mock/MockChain';

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
