import Dockerode from 'dockerode'
import { AgentConfig } from '@swarm/shared/types'

const docker = new Dockerode({
  host: process.env.DOCKER_HOST?.replace('tcp://', '').split(':')[0],
  port: Number(process.env.DOCKER_HOST?.split(':').pop()) || 2375,
})

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
      Env: env,
      HostConfig: {
        NetworkMode: 'swarm_default',   // docker compose network
        AutoRemove: false,
      },
    })

    await container.start()
    console.log(`[AgentRunner] deployed container: ${container.id}`)
    return container.id
  }

  async stop(containerId: string): Promise<void> {
    const c = docker.getContainer(containerId)
    await c.stop()
    await c.remove()
  }

  async list(): Promise<Dockerode.ContainerInfo[]> {
    const containers = await docker.listContainers()
    return containers.filter((c: Dockerode.ContainerInfo) =>
      c.Names.some((name: string) => name.startsWith('/swarm-'))
    )
  }
}
