/**
 * `@spore/sdk/swarm` — internals + advanced direct-use entry point.
 *
 * Most devs do NOT import from here. The canonical entry is the
 * top-level managed class:
 *
 *   import { Spore, LangChainAgent } from '@spore/sdk'
 *
 *   const spore = new Spore({ apiKey })
 *   spore.sporeise(a1, a2, a3, a4, a5)        // homogeneous agents
 *   const result = await spore.run('do thing') // FCFS planner + workers + chained validate
 */

// Single agent interface
export type {
  AgentInput,
  JudgeInput,
  SporeAgent,
  ValidationVerdict,
  ValidationSignPayload,
} from './agent'

// LangChain wrapper + DAG / execute / plan shapes
export {
  LangChainAgent,
  type LangChainAgentOptions,
  type DAGSubtask,
  type ExecuteResult,
  type PlanResult,
} from './langchain'

// Event taxonomy
export type {
  DagReadyEvent,
  ExecutorDoneEvent,
  PlannerElectedEvent,
  SporeEvent,
  SporeEventHandler,
  SporeEventOf,
  SporeEventType,
  SubtaskRejectedEvent,
  SubtaskStartedEvent,
  SubtaskValidatedEvent,
  TaskCompletedEvent,
  TaskFailedEvent,
  TaskSubmittedEvent,
  ValidatorDoneEvent,
} from './events'

// Local in-memory orchestrator
export {
  Orchestrator,
  type ExecuteOptions,
  type NodeResult,
  type SporeOptions,
  type TaskResult,
} from './orchestrator'
