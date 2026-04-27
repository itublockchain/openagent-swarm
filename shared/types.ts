export type AgentRole = 'planner' | 'worker' | 'keeper'

export type TaskStatus = 'idle' | 'waiting' | 'claimed' | 'done' | 'failed'

export enum EventType {
  TASK_SUBMITTED    = 'TASK_SUBMITTED',
  PLANNER_SELECTED  = 'PLANNER_SELECTED',
  DAG_READY         = 'DAG_READY',
  SUBTASK_CLAIMED   = 'SUBTASK_CLAIMED',
  SUBTASK_DONE      = 'SUBTASK_DONE',
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
}

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
}
