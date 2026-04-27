import * as dotenv from 'dotenv';
import { ethers } from 'ethers';
import { SwarmAgent, AgentDeps } from './SwarmAgent';
import { MockStorage } from './adapters/mock/MockStorage';
import { MockCompute } from './adapters/mock/MockCompute';
import { MockChain } from './adapters/mock/MockChain';
import { EventBus } from './core/EventBus';
import { EventType } from '../../../shared/types';
import { createAdapters } from './adapters';

// Load environment variables from root
dotenv.config({ path: '../../.env' });

const agentId = process.env.AGENT_ID || 'swarm-agent-001';
const stakeAmount = process.env.STAKE_AMOUNT || '100';
// Derive on-chain address from the private key so settlement / slashing logic
// can refer to the agent's actual wallet. Falls back to agentId for mock setups.
const agentPk = process.env.AGENT_PRIVATE_KEY || process.env.PRIVATE_KEY;
const agentAddress = agentPk ? new ethers.Wallet(agentPk).address : agentId;

async function bootstrap() {
  const adapters = await createAdapters(agentId);

  const deps: AgentDeps = {
    ...adapters,
    config: {
      agentId,
      stakeAmount,
      agentAddress,
    }
  };

  const agent = new SwarmAgent(deps);
  await agent.start();
  console.log(`[Agent ${agentId}] started and waiting for tasks...`);
}

bootstrap().catch(err => {
  console.error('Bootstrap error:', err);
});
