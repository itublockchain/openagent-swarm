import { SporeClient } from '../src'

const apiKey = process.env.SPORE_API_KEY || "YOUR_API_KEY"
const baseUrl = process.env.SPORE_BASE_URL || 'http://localhost:3001'

const spore = new SporeClient({ baseUrl, apiKey })

async function main() {
  const spec = "Write a short poem about decentralized AI."
  const budget = "0.5"

  console.log(`Submitting task: "${spec}" with budget ${budget} USDC...`)
  
  const result = await spore.tasks.submit({ spec, budget })
  console.log('Success! Task ID:', result.taskId)
  console.log(`View progress at: ${baseUrl.replace('3001', '3000')}/explorer?taskId=${result.taskId}`)
}

main().catch(console.error)
