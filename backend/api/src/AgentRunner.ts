import Dockerode from 'dockerode'
import { AgentConfig } from '@swarm/shared/types'

const docker = process.env.DOCKER_HOST
  ? new Dockerode({
    host: process.env.DOCKER_HOST.replace('tcp://', '').split(':')[0],
    port: Number(process.env.DOCKER_HOST.split(':').pop()) || 2375,
  })
  : new Dockerode({ socketPath: process.env.DOCKER_SOCKET || '/var/run/docker.sock' });

export interface AgentRecord {
  agentId: string
  containerId: string
  model: string
  stakeAmount: string
  systemPrompt?: string
  status: 'running' | 'stopped' | 'error'
  deployedAt: number
  ownerAddress?: string
}

/**
 * AgentManager handles the lifecycle of Agent containers.
 * In a P2P architecture, this is the only "centralized" part 
 * because it needs Docker socket access to spawn nodes.
 */
export class AgentManager {
  private agentPool = new Map<string, string>(); // containerId -> stringified AgentRecord

  constructor() {
    console.log('[AgentManager] Initialized');
  }

  async deploy(config: AgentConfig & { model?: string; systemPrompt?: string }): Promise<string> {
    const env = [
      `AGENT_ID=${config.agentId}`,
      `STAKE_AMOUNT=${config.stakeAmount}`,
      `AXL_PEER=${process.env.AXL_PEER ?? 'tcp://axl-seed:7000'}`,
      `AXL_URL=http://localhost:9002`,
      `USE_MOCK=false`,
      `COMPUTE_PROVIDER=0g`,
      `ZG_COMPUTE_RPC_URL=${process.env.ZG_COMPUTE_RPC_URL ?? 'https://evmrpc-testnet.0g.ai'}`,
      `ZG_COMPUTE_MODEL=${config.model ?? process.env.ZG_COMPUTE_MODEL ?? 'qwen/qwen-2.5-7b-instruct'}`,
      `AGENT_PRIVATE_KEY=${process.env.AGENT_PRIVATE_KEY ?? ''}`,
    ]

    if (config.systemPrompt) {
      env.push(`AGENT_SYSTEM_PROMPT=${config.systemPrompt}`)
    }

    const container = await docker.createContainer({
      Image: 'swarm-agent:latest',
      name: `swarm-${config.agentId}-${Date.now()}`,
      Env: env,
      HostConfig: {
        NetworkMode: 'swarm_default',
        AutoRemove: false,
      },
    })

    await container.start()
    console.log(`[AgentManager] deployed container: ${container.id}`)

    const record: AgentRecord = {
      agentId: config.agentId,
      containerId: container.id,
      model: config.model ?? 'gpt-4o',
      stakeAmount: config.stakeAmount,
      systemPrompt: config.systemPrompt,
      status: 'running',
      deployedAt: Date.now(),
    }
    this.agentPool.set(container.id, JSON.stringify(record))

    return container.id
  }

  async stop(containerId: string): Promise<void> {
    const c = docker.getContainer(containerId)
    try {
      await c.stop()
      await c.remove()
    } catch (err) {
      console.warn(`[AgentManager] Container ${containerId} stop error:`, err)
    }
    this.agentPool.delete(containerId)
  }

  async list(): Promise<AgentRecord[]> {
    const records = Array.from(this.agentPool.values()).map(v => JSON.parse(v) as AgentRecord)
    const running = await docker.listContainers()
    const runningIds = new Set(running.map(c => c.Id))

    return records.map(r => ({
      ...r,
      status: runningIds.has(r.containerId) ? 'running' : 'stopped',
    }))
  }
}


