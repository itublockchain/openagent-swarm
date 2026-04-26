import * as dotenv from 'dotenv';
import { SwarmAgent, AgentDeps } from './SwarmAgent';
import { MockStorage } from './adapters/mock/MockStorage';
import { MockCompute } from './adapters/mock/MockCompute';
import { MockChain } from './adapters/mock/MockChain';
import { EventBus } from './core/EventBus';
import { EventType } from '../../../shared/types';
import { createAdapters } from './adapters';

// Load environment variables
dotenv.config();

const agentId = process.env.AGENT_ID || 'swarm-agent-001';
const stakeAmount = process.env.STAKE_AMOUNT || '100';

async function bootstrap() {
  const adapters = await createAdapters(agentId);
  
  const deps: AgentDeps = {
    ...adapters,
    config: {
      agentId,
      stakeAmount
    }
  };

  const agent = new SwarmAgent(deps);
  await agent.start();
  console.log(`[Agent ${agentId}] started and waiting for tasks...`);
}

bootstrap().catch(err => {
  console.error('Bootstrap error:', err);
});
