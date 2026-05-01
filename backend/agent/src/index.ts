import * as dotenv from 'dotenv';
import { ethers } from 'ethers';
import { SwarmAgent, AgentDeps } from './SwarmAgent';
import { createAdapters } from './adapters';

// Load environment variables from root
dotenv.config({ path: '../../.env' });

// Keep the agent alive through transient RPC failures (rate-limit, coalesce
// errors, broker socket hiccups). Without these handlers a single -32005
// from 0G testnet's shared 50 RPS cap kills the process and Docker enters a
// restart loop that never makes forward progress.
process.on('unhandledRejection', (reason: any) => {
  const msg = String(reason?.message ?? reason)
  console.error('[CRITICAL] Unhandled rejection (suppressed):', msg)
})
process.on('uncaughtException', (err: any) => {
  const msg = String(err?.message ?? err)
  console.error('[CRITICAL] Uncaught exception (suppressed):', msg)
})

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
      systemPrompt: process.env.AGENT_SYSTEM_PROMPT,
      // OWNER_ADDRESS is set by AgentRunner.buildContainerEnv from
      // secret.ownerAddress (the user who deployed the agent). When set,
      // SwarmAgent.startSurplusWatchdog forwards USDC above stakeAmount
      // back to this address every 60s.
      ownerAddress: process.env.OWNER_ADDRESS,
    }
  };

  const agent = new SwarmAgent(deps);
  await agent.start();
  console.log(`[Agent ${agentId}] started and waiting for tasks...`);
}

bootstrap().catch(err => {
  console.error('Bootstrap error:', err);
});
