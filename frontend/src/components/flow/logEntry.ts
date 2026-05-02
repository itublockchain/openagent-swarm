import { EventType } from '../../../../shared/types'

/**
 * Structured log entry. Replaces the previous `string[]` so the panel can
 * render rich, type-specific UI (icons, colors, hover details) without
 * regex-sniffing the message every render — and so the page can dedupe
 * AXL events that fan out per-agent (PLANNER_SELECTED, DAG_READY) into a
 * single timeline row instead of N near-identical lines.
 */
export type LogKind =
  | 'system'   // boot text, status banners
  | 'user'     // local user action (submit)
  | 'api'      // backend acknowledgement (e.g. Treasury debit)
  | 'event'    // forwarded AXL mesh event
  | 'error'

export interface LogEntry {
  /** Stable React key. Also used for dedup — entries with the same id
   *  collide and only the first one survives. */
  id: string
  kind: LogKind
  eventType?: EventType
  message: string
  timestamp: number
  taskId?: string
  nodeId?: string
  agentId?: string
}

/**
 * Per-event-type dedup strategy. Some events fan out across agents (every
 * peer racing for the planner role broadcasts PLANNER_SELECTED, every
 * disqualifying agent emits AGENT_PASSED for its own pass) — surfacing
 * each one floods the panel with near-identical rows. Others are
 * legitimately N-per-thing (jurors voting on a node, settlement events).
 *
 *  - 'task'  → one row per (taskId, type). Use for lifecycle events that
 *              should appear exactly once in a task's timeline.
 *  - 'node'  → one row per (taskId, nodeId, type). Subtask state changes.
 *  - 'actor' → one row per (taskId, nodeId, agentId, type). Multi-actor
 *              events where each actor's contribution matters (juror
 *              voted, agent passed).
 *  - 'none'  → no dedup, every event becomes a row.
 */
type DedupScope = 'task' | 'node' | 'actor' | 'none'

const DEDUP_BY_TYPE: Partial<Record<EventType, DedupScope>> = {
  [EventType.TASK_SUBMITTED]: 'task',
  [EventType.PLANNER_SELECTED]: 'task',
  [EventType.DAG_READY]: 'task',
  [EventType.DAG_VALIDATING]: 'task',
  [EventType.DAG_COMPLETED]: 'task',
  [EventType.TASK_FINALIZED]: 'task',
  [EventType.SUBTASK_CLAIMED]: 'node',
  [EventType.SUBTASK_DONE]: 'node',
  [EventType.SUBTASK_VALIDATED]: 'node',
  [EventType.SUBTASK_PEER_VALIDATED]: 'node',
  [EventType.CHALLENGE]: 'node',
  [EventType.SLASH_EXECUTED]: 'node',
  [EventType.TASK_REOPENED]: 'node',
  [EventType.AGENT_PASSED]: 'actor',
  [EventType.JUROR_COMMITTED]: 'actor',
  [EventType.JUROR_VOTED]: 'actor',
}

function dedupId(
  scope: DedupScope,
  type: string,
  payload: Record<string, unknown>,
  fallbackTimestamp: number,
): string {
  const taskId = (payload.taskId as string | undefined) ?? ''
  const nodeId = (payload.nodeId as string | undefined) ?? ''
  const agentId = (payload.agentId as string | undefined) ?? ''
  switch (scope) {
    case 'task':  return `event:${type}:${taskId}`
    case 'node':  return `event:${type}:${taskId}:${nodeId}`
    case 'actor': return `event:${type}:${taskId}:${nodeId}:${agentId}`
    case 'none':
    default:
      // Unique-by-timestamp ensures de-duplication never collides for
      // events the dedup table doesn't enumerate.
      return `event:${type}:${fallbackTimestamp}:${Math.random().toString(36).slice(2, 8)}`
  }
}

/** Truncate a hex / id string for display ("0xabcdef…"). */
function short(id: string | undefined, len = 6): string {
  if (!id) return ''
  return id.length > len + 2 ? `${id.slice(0, len)}…` : id
}

/**
 * Translate an AXL event into the human-readable line shown in the panel.
 * Unknown / unmapped events fall back to their raw enum name so a future
 * EventType added before this map gets updated still surfaces something.
 */
function formatEventMessage(type: string, payload: Record<string, unknown>): string {
  const taskId = short(payload.taskId as string | undefined)
  const nodeId = short(payload.nodeId as string | undefined, 4)
  const agentId = short(payload.agentId as string | undefined)
  switch (type) {
    case EventType.TASK_SUBMITTED:
      return `Task submitted (${taskId})`
    case EventType.PLANNER_SELECTED:
      return `Planner selected — agent ${short(payload.plannerAgentId as string | undefined) || agentId}`
    case EventType.DAG_READY: {
      const n = Array.isArray(payload.nodes) ? (payload.nodes as unknown[]).length : '?'
      return `DAG ready (${n} nodes)`
    }
    case EventType.SUBTASK_CLAIMED:
      return `Subtask ${nodeId} claimed by ${agentId}`
    case EventType.SUBTASK_DONE:
      return `Subtask ${nodeId} done — awaiting validation`
    case EventType.SUBTASK_VALIDATED:
      return `Subtask ${nodeId} validated on-chain`
    case EventType.SUBTASK_PEER_VALIDATED:
      return `Subtask ${nodeId} peer-validated`
    case EventType.AGENT_PASSED:
      return `Agent ${agentId} passed on ${nodeId}`
    case EventType.JUROR_COMMITTED:
      return `Juror ${agentId} committed (node ${nodeId})`
    case EventType.JUROR_VOTED: {
      const guilty = (payload as any).accusedGuilty
      return `Juror ${agentId} voted ${guilty ? 'GUILTY' : 'INNOCENT'} (node ${nodeId})`
    }
    case EventType.CHALLENGE:
      return `Challenge raised on subtask ${nodeId}`
    case EventType.SLASH_EXECUTED:
      return `Slash executed on subtask ${nodeId}`
    case EventType.TASK_REOPENED:
      return `Subtask ${nodeId} re-opened for re-claim`
    case EventType.DAG_VALIDATING:
      return `Keeper validating final outputs…`
    case EventType.DAG_COMPLETED:
      return `Task settled — payouts released`
    case EventType.TASK_FINALIZED:
      return `Task finalized`
    case EventType.COLONY_MEMBERSHIP_CHANGED:
      return `Colony membership updated`
    default:
      return type
  }
}

export interface ConvertResult {
  /** Newly-built entry, or null when an entry with the same dedup id is
   *  already present (caller should skip the append). */
  entry: LogEntry | null
}

/**
 * Build the next LogEntry for an incoming AXL event, skipping duplicates
 * the caller has already shown. The seen-set is mutated in place so the
 * caller can keep a single Set across renders without rebuilding.
 */
export function entryFromEvent(
  event: { type: string; payload: Record<string, unknown>; timestamp: number; agentId?: string },
  seenIds: Set<string>,
): ConvertResult {
  const scope = DEDUP_BY_TYPE[event.type as EventType] ?? 'none'
  const id = dedupId(scope, event.type, event.payload ?? {}, event.timestamp)
  if (seenIds.has(id)) return { entry: null }
  seenIds.add(id)
  return {
    entry: {
      id,
      kind: 'event',
      eventType: event.type as EventType,
      message: formatEventMessage(event.type, event.payload ?? {}),
      timestamp: event.timestamp,
      taskId: event.payload?.taskId as string | undefined,
      nodeId: event.payload?.nodeId as string | undefined,
      agentId: (event.payload?.agentId as string | undefined) ?? event.agentId,
    },
  }
}

/** Build a LogEntry for a non-event line (user action, API ack, error). */
export function makeEntry(
  kind: Exclude<LogKind, 'event'>,
  message: string,
  opts: { taskId?: string; nodeId?: string } = {},
): LogEntry {
  return {
    id: `${kind}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`,
    kind,
    message,
    timestamp: Date.now(),
    taskId: opts.taskId,
    nodeId: opts.nodeId,
  }
}
