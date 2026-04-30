export type AgentRole = 'planner' | 'worker' | 'keeper'

export type TaskStatus = 'idle' | 'waiting' | 'claimed' | 'done' | 'failed'

export enum EventType {
  TASK_SUBMITTED    = 'TASK_SUBMITTED',
  PLANNER_SELECTED  = 'PLANNER_SELECTED',
  DAG_READY         = 'DAG_READY',
  SUBTASK_CLAIMED   = 'SUBTASK_CLAIMED',
  SUBTASK_DONE      = 'SUBTASK_DONE',
  /** Output passed validation on-chain (planner/keeper batch-validated this
   *  node). UI promotes the box from 'pending' (yellow) to 'done' (green). */
  SUBTASK_VALIDATED = 'SUBTASK_VALIDATED',
  /** The next worker's local LLM-Judge accepted this node's output and is
   *  using it as context. Optimistic UI signal — flips the box green ahead
   *  of the planner's on-chain markValidatedBatch (which still fires at
   *  DAG end and is the authoritative finality). */
  SUBTASK_PEER_VALIDATED = 'SUBTASK_PEER_VALIDATED',
  /** Self-selection: agent's assess() returned NO for this node. UI shows a
   *  small "passed" badge so viewers see the skill filter at work. */
  AGENT_PASSED      = 'AGENT_PASSED',
  /** Juror submitted a sealed commit (commit-reveal phase 1). UI shows a
   *  "committed" counter on the disputed node — vote content stays hidden
   *  until reveal. */
  JUROR_COMMITTED   = 'JUROR_COMMITTED',
  /** Juror revealed their vote (commit-reveal phase 2). Existing UI listener
   *  treats this the same as the old single-phase vote: bumps the
   *  guilty/innocent counter on the disputed node. */
  JUROR_VOTED       = 'JUROR_VOTED',
  CHALLENGE         = 'CHALLENGE',
  SLASH_EXECUTED    = 'SLASH_EXECUTED',
  TASK_REOPENED     = 'TASK_REOPENED',
  DAG_COMPLETED     = 'DAG_COMPLETED',
  TASK_FINALIZED    = 'TASK_FINALIZED',
}

export interface DAGNode {
  /** unique node id */
  id: string
  /** insan okunabilir subtask açıklaması */
  subtask: string
  /** bir önceki node'un output hash'i, null ise ilk node */
  prevHash: string | null
  status: TaskStatus
  /** claim eden agent'ın id'si */
  claimedBy: string | null
  /** subtask bittiğinde oluşan output hash */
  outputHash?: string
  /** Set when this node's output has been peer-validated by a downstream
   *  worker (its judge() returned true and it consumed the output as
   *  context). Lets the next worker skip a redundant judge() call —
   *  ~5-10s saving per node. The planner's batch markValidated at DAG
   *  end is still the authoritative finality. */
  peerValidated?: boolean
}

/**
 * One step in an agent's transcript — either a tool round-trip or the
 * final answer. Mirrors backend/agent/src/agentFormat.ts so the frontend
 * can render the trace from the SUBTASK_DONE broadcast without depending
 * on the agent package.
 */
export type TranscriptStep =
  | { kind: 'tool_call'; tool: string; args: Record<string, unknown>; output: string; ok: boolean }
  | { kind: 'final'; text: string }

export interface AXLEvent<T = unknown> {
  type: EventType
  payload: T
  /** unix ms */
  timestamp: number
  agentId: string
  /** P2P public key of the sender for direct replies */
  senderPubKey?: string
}

export interface AgentConfig {
  agentId: string
  stakeAmount: string
  /** Agent's on-chain wallet address. Required for explicit settlement
   *  (planner reward) and partial slashing logic. */
  agentAddress?: string
  /** User-supplied prompt that defines the agent's specialization. Read
   *  by SwarmAgent.assess() to skip subtasks outside the agent's skill
   *  before racing to claim. Empty / undefined → claim everything. */
  systemPrompt?: string
}
