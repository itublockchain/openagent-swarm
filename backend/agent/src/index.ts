import 'dotenv/config'
import { createAdapters } from './adapters'
import { SwarmAgent } from './SwarmAgent'

async function main() {
  const agentId = process.env.AGENT_ID
  if (!agentId) throw new Error('AGENT_ID env required')

  const deps = await createAdapters(agentId)
  const agent = new SwarmAgent({
    ...deps,
    config: {
      agentId,
      stakeAmount: process.env.STAKE_AMOUNT ?? '100',
    },
  })

  await agent.start()
  console.log(`[Agent ${agentId}] ready`)

  // graceful shutdown
  process.on('SIGTERM', async () => {
    await deps.network.disconnect()
    process.exit(0)
  })
}

main().catch((err) => {
  console.error('[Agent] fatal:', err)
  process.exit(1)
})
