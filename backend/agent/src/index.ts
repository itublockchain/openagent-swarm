import * as dotenv from 'dotenv';
import { SwarmAgent, AgentDeps } from './SwarmAgent';
import { MockStorage } from './adapters/mock/MockStorage';
import { MockCompute } from './adapters/mock/MockCompute';
import { MockChain } from './adapters/mock/MockChain';
import { EventBus } from './core/EventBus';
import { EventType } from '../../../shared/types';

// Load environment variables
dotenv.config();

const agentId = process.env.AGENT_ID || 'swarm-agent-001';
const stakeAmount = process.env.STAKE_AMOUNT || '100';

async function bootstrap() {
  const bus = new EventBus(agentId);
  
  const deps: AgentDeps = {
    storage: new MockStorage(agentId),
    compute: new MockCompute(agentId),
    chain: new MockChain(agentId),
    network: bus,
    config: {
      agentId,
      stakeAmount
    }
  };

  const agent = new SwarmAgent(deps);
  agent.start();

  // Simulate a task submission after 3 seconds
  setTimeout(async () => {
    console.log('\n[System] Simulating TASK_SUBMITTED...');
    await bus.emit({
      type: EventType.TASK_SUBMITTED,
      payload: {
        taskId: 'task-' + Math.random().toString(36).substring(7),
        spec: 'Train a neural network on MNIST'
      },
      timestamp: Date.now(),
      agentId: 'user-001'
    });
  }, 3000);
}

bootstrap().catch(err => {
  console.error('Bootstrap error:', err);
});
