/**
 * Spore × LangChain — frictionless N-agent demo.
 *
 *   - Get an API key from https://sporeprotocol.xyz
 *   - Create as many LangChain agents as you want, all the same kind
 *   - sporeise them, run a task
 *
 * Roles emerge per run: one is FCFS-elected as planner, others race
 * to be workers, every OTHER agent validates each output.
 *
 * Prereqs:
 *   pnpm add @spore/sdk \
 *            @langchain/core @langchain/openai @langchain/langgraph \
 *            ethers
 *
 * Env:
 *   OPENAI_API_KEY   OpenAI key for the LLMs
 *   SPORE_API_KEY    sk_live_... or sk_test_... from sporeprotocol.xyz
 *
 * Run:
 *   tsx sdk/examples/langchain.ts
 */

import { ChatOpenAI } from '@langchain/openai'
import { createReactAgent } from '@langchain/langgraph/prebuilt'

import { LangChainAgent, Spore } from '../src'

async function main() {
  if (!process.env.OPENAI_API_KEY) {
    console.error('Set OPENAI_API_KEY first.')
    process.exit(1)
  }
  if (!process.env.SPORE_API_KEY) {
    console.error('Set SPORE_API_KEY first (get one from https://sporeprotocol.xyz).')
    process.exit(1)
  }

  const llm = new ChatOpenAI({ model: 'gpt-4o-mini', temperature: 0.3 })

  // ─── 1. Define however many agents you want ───────────────────────
  // No role labels at creation. Each agent is identical to the
  // orchestrator. Roles emerge dynamically per task: FCFS planner +
  // workers + every-other-agent-as-validator.
  const makeAgent = (id: string) =>
    new LangChainAgent({
      id,
      agent: createReactAgent({ llm, tools: [] }),
      llm,                       // enables plan + validate defaults
    })

  // ─── 2. Spore — only the API key, nothing else ────────────────────
  const spore = new Spore({
    apiKey: process.env.SPORE_API_KEY!,
    // walletStorePath: '.spore-wallets.json',  // opt-in persistence
    maxRetries: 1,
    logger: console,
  })

  spore.sporeise(
    makeAgent('a1'),
    makeAgent('a2'),
    makeAgent('a3'),
    makeAgent('a4'),
    makeAgent('a5'),
  )

  // ─── 3. Watch the lifecycle ───────────────────────────────────────
  spore.on('*', (e) => {
    const summary: Record<string, string> = {
      task_submitted:    `📥 task ${e.taskId.slice(0, 12)}… (${'participants' in e ? e.participants.length : 0} agents)`,
      planner_elected:   `👑 planner: ${'plannerId' in e ? e.plannerId : ''}`,
      dag_ready:         `🗺  ${'subtasks' in e ? e.subtasks.length : 0} subtask(s)`,
      subtask_started:   `🚀 ${'nodeId' in e ? e.nodeId : ''} → ${'workerId' in e ? e.workerId : ''}` +
                          ('attempt' in e && e.attempt > 0 ? ` (retry ${e.attempt})` : ''),
      executor_done:     `✍️  output produced + hash submitted`,
      validator_done:    `🧐 ${'validatorId' in e ? e.validatorId : ''} → ${'verdict' in e ? (e.verdict.valid ? 'VALID' : 'INVALID') : ''}`,
      subtask_validated: `✅ node accepted (${'consensus' in e ? e.consensus : ''})`,
      subtask_rejected:  `❌ node rejected — ${'willRetry' in e && e.willRetry ? 'retrying' : 'stopping'}`,
      task_completed:    `🎉 task complete`,
      task_failed:       `💥 task failed — ${'phase' in e ? e.phase : ''}: ${'reason' in e ? e.reason : ''}`,
    }
    console.log(summary[e.type] ?? `· ${e.type}`)
  })

  // ─── 4. Run a task ────────────────────────────────────────────────
  const result = await spore.run('Write a 4-line haiku about decentralized AI agents.')

  console.log('\n──── final result ────')
  console.log(result.result)
  console.log(`\nOn-chain task id: ${result.taskIdBytes32}`)
  console.log(`Planner: ${result.plannerId}`)

  console.log('\n──── auto-generated agent wallets ────')
  for (const [agentId, address] of Object.entries(spore.walletAddresses())) {
    console.log(`  ${agentId.padEnd(8)} ${address}`)
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
