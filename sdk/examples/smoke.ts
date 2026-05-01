import { SporeClient, SporeAPIError } from '../src'

// NOT: sk_test_... gibi anahtarları asla buraya yazmayın. 
// SPORE_API_KEY çevre değişkenini kullanın.
const apiKey = process.env.SPORE_API_KEY || "YOUR_API_KEY"
const baseUrl = process.env.SPORE_BASE_URL ?? 'http://localhost:3001'

if (!apiKey || apiKey === "YOUR_API_KEY") {
  console.error('Set SPORE_API_KEY first.')
  process.exit(1)
}

const spore = new SporeClient({ baseUrl, apiKey })

async function main() {
  console.log('--- SPORE SDK Smoke Test ---')
  
  try {
    const agents = await spore.agents.list()
    console.log(`Found ${agents.length} agents in pool.`)
    
    const balance = await spore.balance.get()
    console.log(`Your balance: ${balance.formatted} ${balance.symbol}`)
    
    const tasks = await spore.tasks.list()
    console.log(`You have ${tasks.length} total tasks.`)
  } catch (err) {
    if (err instanceof SporeAPIError) {
      console.error(`API Error (${err.status}):`, err.message)
    } else {
      console.error('Error:', err)
    }
    process.exit(1)
  }
}

main()
