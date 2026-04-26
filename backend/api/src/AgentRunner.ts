import Dockerode from 'dockerode'
import { createClient, RedisClientType } from 'redis'
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

export class AgentRunner {
  private redis: RedisClientType;
  private isConnected = false;

  constructor() {
    this.redis = createClient({ 
      url: process.env.REDIS_URL ?? 'redis://redis:6379' 
    });
    this.redis.on('error', (err) => console.error('[AgentRunner] Redis Error:', err));
  }

  private async ensureConnected() {
    if (!this.isConnected) {
      await this.redis.connect();
      this.isConnected = true;
    }
  }

  async deploy(config: AgentConfig & { model?: string; systemPrompt?: string }): Promise<string> {
    await this.ensureConnected();

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
      Env: env,
      HostConfig: {
        NetworkMode: 'swarm_default',
        AutoRemove: false,
      },
    })

    await container.start()
    console.log(`[AgentRunner] deployed container: ${container.id}`)

    // Redis'e kaydet
    const record: AgentRecord = {
      agentId: config.agentId,
      containerId: container.id,
      model: config.model ?? 'gpt-4o',
      stakeAmount: config.stakeAmount,
      systemPrompt: config.systemPrompt,
      status: 'running',
      deployedAt: Date.now(),
    }
    await this.redis.hSet('agent:pool', container.id, JSON.stringify(record))

    return container.id
  }

  async stop(containerId: string): Promise<void> {
    await this.ensureConnected();

    const c = docker.getContainer(containerId)
    try {
      await c.stop()
      await c.remove()
    } catch (err) {
      console.warn(`[AgentRunner] Container ${containerId} stop error (might be already gone):`, err)
    }

    // Redis'ten de sil
    await this.redis.hDel('agent:pool', containerId)
  }

  async list(): Promise<AgentRecord[]> {
    await this.ensureConnected();

    // Redis'ten al
    const stored = await this.redis.hGetAll('agent:pool')
    const records = Object.values(stored).map(v => JSON.parse(v) as AgentRecord)

    // Docker ile status'u güncelle
    const running = await docker.listContainers()
    const runningIds = new Set(running.map(c => c.Id))

    return records.map(r => ({
      ...r,
      status: runningIds.has(r.containerId) ? 'running' : 'stopped',
    }))
  }
}
