/**
 * Event taxonomy emitted by the local Spore orchestrator. Discriminated
 * union on `type` so consumers (UI dashboards, log sinks, on-chain
 * relay) can switch exhaustively.
 *
 * Lifecycle of one task — roles emerge from the homogeneous agent pool:
 *
 *   task_submitted
 *     └─► planner_elected                         (FCFS: one agent picked as planner)
 *           └─► dag_ready                         (planner produced subtasks)
 *                 └─► subtask_started ─► executor_done
 *                                          └─► validator_done   (one per OTHER agent)
 *                                                └─► subtask_validated      (passed)
 *                                                └─► subtask_rejected       (re-run on different worker)
 *                 ... (loop over each DAG node) ...
 *                 └─► task_completed
 *
 *   task_failed can fire from any phase when retries / quorum / a hard
 *   error gives up.
 */

import type { ValidationVerdict } from './agent'

export type SporeEvent =
  | TaskSubmittedEvent
  | PlannerElectedEvent
  | DagReadyEvent
  | SubtaskStartedEvent
  | ExecutorDoneEvent
  | ValidatorDoneEvent
  | SubtaskValidatedEvent
  | SubtaskRejectedEvent
  | TaskCompletedEvent
  | TaskFailedEvent

export type SporeEventType = SporeEvent['type']

export interface TaskSubmittedEvent {
  type: 'task_submitted'
  taskId: string
  spec: string
  /** All agents participating in this task (id snapshot at submit time).
   *  Lets observers identify the eligible voter pool. */
  participants: string[]
  timestamp: number
}

export interface PlannerElectedEvent {
  type: 'planner_elected'
  taskId: string
  plannerId: string
  timestamp: number
}

export interface DagReadyEvent {
  type: 'dag_ready'
  taskId: string
  plannerId: string
  subtasks: string[]
  timestamp: number
}

export interface SubtaskStartedEvent {
  type: 'subtask_started'
  taskId: string
  nodeId: string
  /** Which DAG position (0-indexed). */
  index: number
  subtask: string
  /** FCFS-elected worker for this attempt. */
  workerId: string
  /** Re-runs after a validator-majority rejection bump this counter.
   *  0 on first try. */
  attempt: number
  timestamp: number
}

export interface ExecutorDoneEvent {
  type: 'executor_done'
  taskId: string
  nodeId: string
  workerId: string
  /** Output the worker produced. */
  output: string
  timestamp: number
}

export interface ValidatorDoneEvent {
  type: 'validator_done'
  taskId: string
  nodeId: string
  /** Any agent in the swarm except the current node's worker. */
  validatorId: string
  verdict: ValidationVerdict
  timestamp: number
}

export interface SubtaskValidatedEvent {
  type: 'subtask_validated'
  taskId: string
  nodeId: string
  /** All judge verdicts collected — useful for downstream reputation. */
  verdicts: Array<{ validatorId: string; verdict: ValidationVerdict }>
  /** How the orchestrator tallied. */
  consensus: 'majority' | 'unanimous' | 'single'
  timestamp: number
}

export interface SubtaskRejectedEvent {
  type: 'subtask_rejected'
  taskId: string
  nodeId: string
  verdicts: Array<{ validatorId: string; verdict: ValidationVerdict }>
  /** True iff the orchestrator will retry on a different worker. */
  willRetry: boolean
  timestamp: number
}

export interface TaskCompletedEvent {
  type: 'task_completed'
  taskId: string
  result: string
  timestamp: number
}

export interface TaskFailedEvent {
  type: 'task_failed'
  taskId: string
  /** Phase the task gave up in: 'planning' | 'electing_planner' | 'electing_worker'
   *  | 'executing' | 'validating' | 'no_eligible_workers' | … */
  phase: string
  reason: string
  timestamp: number
}

// ─── Listener helper types ───────────────────────────────────────────────

export type SporeEventOf<T extends SporeEventType> = Extract<SporeEvent, { type: T }>

export type SporeEventHandler<T extends SporeEventType = SporeEventType> = (
  event: SporeEventOf<T>,
) => void | Promise<void>
