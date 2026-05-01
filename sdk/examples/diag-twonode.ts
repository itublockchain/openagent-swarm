/**
 * Diagnostic — submit a spec that should decompose into 2-3 subtasks, then
 * read back the DAG via /v1/tasks/:id to see what subtask names the planner
 * actually produced.
 */

import { SporeClient } from '../src'

const apiKey = process.env.SPORE_API_KEY || "YOUR_API_KEY"
const baseUrl = process.env.SPORE_BASE_URL || 'http://localhost:3001'
const spec = "Compute 47 * 89 step by step, then output the final result on a new line as: ANSWER=<number>"
const budget = '1'

const spore = new SporeClient({ baseUrl, apiKey, timeoutMs: 300_000 })

async function main() {
  if (apiKey === "YOUR_API_KEY") {
    console.error("Please set SPORE_API_KEY environment variable.")
    process.exit(1)
  }

  const r = await spore.tasks.submit({ spec, budget })
  console.log('taskId:', r.taskId)

  const res = await fetch(`${baseUrl}/task/${r.taskId}`)
  const body = await res.json() as { dag?: { nodes?: Array<{ id: string; subtask: string; status: string }> } }
  
  console.log('\nDAG nodes from /task:')
  for (const n of body.dag?.nodes ?? []) {
    console.log(`  id=${n.id.padEnd(10)} status=${n.status.padEnd(10)} subtask=${JSON.stringify(n.subtask)}`)
  }
}

main().catch(err => {
  console.error('Fatal:', err.message ?? err)
  process.exit(1)
})
