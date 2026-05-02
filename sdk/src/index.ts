/**
 * `@spore/sdk` — official TypeScript SDK for the SPORE protocol.
 *
 *   import { Spore, LangChainAgent } from '@spore/sdk'
 *
 *   const spore = new Spore({ apiKey: process.env.SPORE_API_KEY! })
 *   spore.sporeise(a1, a2, a3, a4)              // homogeneous agents
 *   const { result } = await spore.run('build something')
 *
 * Agents have NO fixed roles. Per task:
 *   - One is FCFS-elected as PLANNER (decomposes the spec into a DAG)
 *   - Workers FCFS-claim subtasks (parallel where deps allow)
 *   - Every OTHER agent acts as VALIDATOR on each output (majority vote)
 *
 * Also re-exports the existing `SporeClient` HTTP client for the
 * task-marketplace surface (submit task to the wider SPORE swarm,
 * read results, balance, agents, colonies).
 */

// ─── Multi-agent managed Spore (LangChain pathway) ──────────────────
export { Spore, type SporeManagedOptions } from './spore'
export {
  LangChainAgent,
  type LangChainAgentOptions,
  type DAGSubtask,
  type ExecuteResult,
  type PlanResult,
} from './swarm'

// ─── Existing HTTP client (task marketplace) ────────────────────────
export { SporeClient, type SporeClientOptions } from './client'
export { SporeAPIError, SporeTimeoutError } from './errors'
export type { FetchLike } from './transport'

export type {
  SubmitTaskInput,
  SubmitTaskResponse,
  Task,
  TaskStatus,
  TaskNodeResult,
  TaskResult,
  Balance,
  Agent,
  Colony,
  ColonyDetail,
  ColonyMember,
  ColonyVisibility,
  ColonyTaskStats,
  CreateColonyInput,
  PublicColony,
} from './types'

export type { WaitForResultOptions } from './resources/tasks'
