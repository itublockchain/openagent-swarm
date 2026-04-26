import Dockerode from 'dockerode'
import { AgentConfig } from '@swarm/shared/types'

const docker = process.env.DOCKER_HOST
  ? new Dockerode({
    host: process.env.DOCKER_HOST.replace('tcp://', '').split(':')[0],
    port: Number(process.env.DOCKER_HOST.split(':').pop()) || 2375,
  })
  : new Dockerode({ socketPath: process.env.DOCKER_SOCKET || '/var/run/docker.sock' });

export class AgentRunner {
  async deploy(config: AgentConfig & { model?: string; systemPrompt?: string }): Promise<string> {
    const env = [
      `AGENT_ID=${config.agentId}`,
      `STAKE_AMOUNT=${config.stakeAmount}`,
      `REDIS_URL=${process.env.REDIS_URL ?? 'redis://redis:6379'}`,
      `USE_MOCK=false`,
      `OPENAI_API_KEY=${process.env.OPENAI_API_KEY ?? ''}`,
      `OPENAI_MODEL=${config.model ?? process.env.OPENAI_MODEL ?? 'gpt-4o'}`,
    ]

    if (config.systemPrompt) {
      env.push(`AGENT_SYSTEM_PROMPT=${config.systemPrompt}`)
    }

    const container = await docker.createContainer({
      Image: 'swarm-agent:latest',
      name: `swarm-${config.agentId}-${Date.now()}`,
      Env: [
        `AGENT_ID=${config.agentId}`,
        `STAKE_AMOUNT=${config.stakeAmount}`,
        `ZG_STORAGE_URL=${process.env.ZG_STORAGE_URL}`,
        `ZG_COMPUTE_URL=${process.env.ZG_COMPUTE_URL}`,
        `ZG_COMPUTE_API_KEY=${process.env.ZG_COMPUTE_API_KEY}`,
        `AXL_WS_URL=${process.env.AXL_WS_URL}`,
        `L2_RPC_URL=${process.env.L2_RPC_URL}`,
        `L2_PRIVATE_KEY=${process.env.L2_PRIVATE_KEY}`,
        `L2_ESCROW_ADDRESS=${process.env.L2_ESCROW_ADDRESS}`,
        `L2_DAG_REGISTRY_ADDRESS=${process.env.L2_DAG_REGISTRY_ADDRESS}`,
        `L2_SLASHING_VAULT_ADDRESS=${process.env.L2_SLASHING_VAULT_ADDRESS}`,
        `USE_MOCK=false`,
      ],
      HostConfig: { AutoRemove: false },
    });

    await container.start();
    return container.id;
  }

  async stop(containerId: string): Promise<void> {
    const container = this.docker.getContainer(containerId);
    await container.stop();
  }

  async list(): Promise<Dockerode.ContainerInfo[]> {
    const containers = await this.docker.listContainers({ all: true });
    return containers.filter(c => c.Names.some(name => name.startsWith('/swarm-')));
  }
}
