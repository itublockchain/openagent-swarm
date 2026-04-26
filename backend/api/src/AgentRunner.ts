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

export class AgentRunner {
  private agentPool = new Map<string, string>(); // containerId -> stringified AgentRecord
  private taskStates = new Map<string, string>(); // taskId -> stringified state

  constructor() {
    console.log('[AgentRunner] Initialized with in-memory storage');
  }

  async deploy(config: AgentConfig & { model?: string; systemPrompt?: string }): Promise<string> {
    const env = [
      `AGENT_ID=${config.agentId}`,
      `STAKE_AMOUNT=${config.stakeAmount}`,
      `AXL_URL=${process.env.AXL_URL ?? 'http://axl:9002'}`,
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
      console.warn(`[AgentRunner] Container ${containerId} stop error (might be already gone):`, err)
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

  // --- Task State Persistence ---

  async saveTaskState(taskId: string, state: { nodes: any[], status: string }) {
    this.taskStates.set(taskId, JSON.stringify(state));
  }

  async getTaskState(taskId: string) {
    const data = this.taskStates.get(taskId);
    return data ? JSON.parse(data) : null;
  }

  private updateQueue: Promise<void> = Promise.resolve();

  async updateSubtaskState(taskId: string, nodeId: string, update: { status: string, agentId?: string, outputHash?: string }) {
    this.updateQueue = this.updateQueue.then(async () => {
      const state = await this.getTaskState(taskId);
      if (!state) return;

      state.nodes = state.nodes.map((n: any) => {
        if (n.id === nodeId) {
          return { ...n, ...update };
        }
        return n;
      });

      await this.saveTaskState(taskId, state);
    }).catch(err => {
      console.error('[AgentRunner] Task state update failed:', err);
    });
    return this.updateQueue;
  }
}

