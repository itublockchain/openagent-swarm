import Database, { type Database as DB } from 'better-sqlite3'
import path from 'node:path'
import fs from 'node:fs'

/**
 * Persistent mirror of two maps that previously lived only in API memory:
 *
 *   - `dagCache`    — per-task DAG snapshot (nodes + their lifecycle status)
 *   - `taskResults` — per-node final answers
 *
 * On crash / redeploy these used to evaporate, leaving only the on-chain
 * outputHash to reconstruct from. With this store every SUBTASK_* event
 * lands on disk, so:
 *   - a deep-link reload (?taskId=...) replays the full DAG immediately
 *   - the profile page's "completed" status sticks across restarts
 *   - the DAG node detail panel keeps its transcript without a 0G round-trip
 *
 * Same SQLite file as KeyStore + TaskIndex, separate connection. WAL keeps
 * the three connections from blocking each other.
 */

export interface TaskNodeRow {
  taskId: string
  nodeId: string
  position: number
  subtask: string | null
  status: 'idle' | 'claimed' | 'pending' | 'done' | 'failed'
  agentId: string | null
  outputHash: string | null
  /** Plain-text final answer captured from SUBTASK_DONE. Null until the
   *  worker reports done. */
  result: string | null
  /** JSON-serialised TranscriptStep[]. Tool outputs already clipped at the
   *  agent (~2 KB each) so a row stays small. */
  transcriptJson: string | null
  iterations: number | null
  stopReason: string | null
  toolsUsedJson: string | null
  updatedAt: string
}

/** Persistent slash record. Lets `/task/:id` and the profile page surface
 *  "this agent was slashed because <reason>" forever — without it a
 *  refresh after the WS event flushed leaves the user staring at a dead
 *  agent with no explanation. Reason is best-effort: pulled from the
 *  matching CHALLENGE event when one exists, else 'on_chain_slash' as a
 *  generic fallback so the row is never empty. */
export interface AgentSlashRow {
  taskId: string
  /** Null when SlashWatcher couldn't correlate the on-chain slash to a
   *  specific subtask (e.g. legacy task-level slash on a non-DAG task). */
  nodeId: string | null
  /** Local agentId (matches AgentManager) when the slashed agent was ours,
   *  null when the operator doesn't manage it locally. */
  agentId: string | null
  /** EVM address from the on-chain Slashed event. Always present so the
   *  UI can fall back to a hex shortform when there's no local agent. */
  agentAddress: string
  /** Slashed amount in 6-decimal USDC base units, decimal string. */
  amount: string
  reason: string
  slashedAt: string
}

export class TaskStateStore {
  private db: DB

  constructor(opts: { dbPath?: string } = {}) {
    const dbPath = opts.dbPath ?? path.join(process.cwd(), 'data', 'api.db')
    fs.mkdirSync(path.dirname(dbPath), { recursive: true })
    this.db = new Database(dbPath)
    this.db.pragma('journal_mode = WAL')
    this.migrate()
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS task_dag_nodes (
        task_id        TEXT NOT NULL,
        node_id        TEXT NOT NULL,
        position       INTEGER NOT NULL,
        subtask        TEXT,
        status         TEXT NOT NULL DEFAULT 'idle',
        agent_id       TEXT,
        output_hash    TEXT,
        result         TEXT,
        transcript     TEXT,
        iterations     INTEGER,
        stop_reason    TEXT,
        tools_used     TEXT,
        updated_at     TEXT NOT NULL,
        PRIMARY KEY (task_id, node_id)
      );
      CREATE INDEX IF NOT EXISTS task_dag_nodes_task_idx ON task_dag_nodes(task_id);

      CREATE TABLE IF NOT EXISTS task_events (
        task_id        TEXT NOT NULL,
        event_type     TEXT NOT NULL,
        payload_json   TEXT NOT NULL,
        timestamp      INTEGER NOT NULL,
        PRIMARY KEY (task_id, event_type, timestamp)
      );
      CREATE INDEX IF NOT EXISTS task_events_task_idx ON task_events(task_id);

      CREATE TABLE IF NOT EXISTS agent_slashes (
        task_id        TEXT NOT NULL,
        node_id        TEXT,
        agent_id       TEXT,
        agent_address  TEXT NOT NULL,
        amount         TEXT NOT NULL,
        reason         TEXT NOT NULL,
        slashed_at     TEXT NOT NULL,
        tx_key         TEXT NOT NULL,
        PRIMARY KEY (tx_key)
      );
      CREATE INDEX IF NOT EXISTS agent_slashes_task_idx ON agent_slashes(task_id);
      CREATE INDEX IF NOT EXISTS agent_slashes_agent_idx ON agent_slashes(agent_id) WHERE agent_id IS NOT NULL;
    `)
  }

  // ------------------------------------------------------------------
  // Writes — called from server.ts AXL event listeners
  // ------------------------------------------------------------------

  /** Seed the DAG when DAG_READY arrives. Each node lands as 'idle'. The
   *  position field comes from the array order — preserves DAG sequencing
   *  for reads. */
  seedDag(taskId: string, nodes: Array<{ id: string; subtask: string }>): void {
    const now = new Date().toISOString()
    const stmt = this.db.prepare(
      `INSERT OR REPLACE INTO task_dag_nodes
       (task_id, node_id, position, subtask, status, updated_at)
       VALUES (?, ?, ?, ?, 'idle', ?)`,
    )
    const txn = this.db.transaction((rows: typeof nodes) => {
      rows.forEach((n, i) => stmt.run(taskId, n.id, i, n.subtask, now))
    })
    txn(nodes)
  }

  setStatus(
    taskId: string,
    nodeId: string,
    patch: { status?: TaskNodeRow['status']; agentId?: string; outputHash?: string },
  ): void {
    // Construct dynamic UPDATE so we don't clobber unrelated columns.
    // Falsy values mean "no change", not "set to null" — null is reserved
    // for explicit reset which we don't currently need.
    const sets: string[] = ['updated_at = ?']
    const params: any[] = [new Date().toISOString()]
    if (patch.status !== undefined) {
      sets.push('status = ?')
      params.push(patch.status)
    }
    if (patch.agentId !== undefined) {
      sets.push('agent_id = ?')
      params.push(patch.agentId)
    }
    if (patch.outputHash !== undefined) {
      sets.push('output_hash = ?')
      params.push(patch.outputHash)
    }
    params.push(taskId, nodeId)
    this.db
      .prepare(`UPDATE task_dag_nodes SET ${sets.join(', ')} WHERE task_id = ? AND node_id = ?`)
      .run(...params)
  }

  /** Stamp the full SUBTASK_DONE payload on a node — result + reasoning
   *  trace + counters. Status is bumped to 'pending' (awaiting validation).
   *  If the node row doesn't exist yet (DAG_READY raced), upsert it with
   *  position=-1 as a placeholder; seedDag will fix the position when it
   *  arrives. */
  recordResult(args: {
    taskId: string
    nodeId: string
    result: string
    outputHash?: string
    agentId?: string
    transcript?: unknown
    iterations?: number
    stopReason?: string
    toolsUsed?: string[]
  }): void {
    const now = new Date().toISOString()
    const tJson = args.transcript == null ? null : JSON.stringify(args.transcript)
    const tools = args.toolsUsed == null ? null : JSON.stringify(args.toolsUsed)

    // INSERT OR REPLACE wipes other columns on collision — use UPSERT
    // (ON CONFLICT) instead so seedDag's earlier subtask/position survive
    // a result write that arrives second.
    this.db
      .prepare(
        `INSERT INTO task_dag_nodes
           (task_id, node_id, position, subtask, status, agent_id, output_hash,
            result, transcript, iterations, stop_reason, tools_used, updated_at)
         VALUES (?, ?, -1, NULL, 'pending', ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(task_id, node_id) DO UPDATE SET
           status      = 'pending',
           agent_id    = COALESCE(excluded.agent_id, task_dag_nodes.agent_id),
           output_hash = COALESCE(excluded.output_hash, task_dag_nodes.output_hash),
           result      = excluded.result,
           transcript  = excluded.transcript,
           iterations  = excluded.iterations,
           stop_reason = excluded.stop_reason,
           tools_used  = excluded.tools_used,
           updated_at  = excluded.updated_at`,
      )
      .run(
        args.taskId,
        args.nodeId,
        args.agentId ?? null,
        args.outputHash ?? null,
        args.result,
        tJson,
        args.iterations ?? null,
        args.stopReason ?? null,
        tools,
        now,
      )
  }

  // ------------------------------------------------------------------
  // Event Log — persists the timeline for refresh-safe terminal output
  // ------------------------------------------------------------------

  // ------------------------------------------------------------------
  // Slash records — written by SlashWatcher when SwarmEscrow.Slashed lands
  // ------------------------------------------------------------------

  /** Idempotent on the watcher's tx-level key (`${txHash}:${logIndex}`)
   *  so a re-scan doesn't insert duplicates. The watcher already dedupes
   *  via its in-memory set, but the DB-level guard keeps things sane
   *  across watcher restarts where the in-memory set is briefly empty. */
  recordSlash(args: {
    taskId: string
    nodeId: string | null
    agentId: string | null
    agentAddress: string
    amount: string
    reason: string
    txKey: string
    slashedAt?: string
  }): void {
    const ts = args.slashedAt ?? new Date().toISOString()
    this.db
      .prepare(
        `INSERT OR IGNORE INTO agent_slashes
           (task_id, node_id, agent_id, agent_address, amount, reason, slashed_at, tx_key)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        args.taskId,
        args.nodeId,
        args.agentId,
        args.agentAddress.toLowerCase(),
        args.amount,
        args.reason,
        ts,
        args.txKey,
      )
  }

  /** All slashes recorded for a task, oldest-first. Used by /task/:id
   *  hydration so the explorer can render a "slashed" overlay on the
   *  affected nodes after a deep-link reload. */
  getSlashesForTask(taskId: string): AgentSlashRow[] {
    const rows = this.db
      .prepare(
        `SELECT task_id, node_id, agent_id, agent_address, amount, reason, slashed_at
         FROM agent_slashes WHERE task_id = ?
         ORDER BY slashed_at ASC`,
      )
      .all(taskId) as Array<{
        task_id: string
        node_id: string | null
        agent_id: string | null
        agent_address: string
        amount: string
        reason: string
        slashed_at: string
      }>
    return rows.map(r => ({
      taskId: r.task_id,
      nodeId: r.node_id,
      agentId: r.agent_id,
      agentAddress: r.agent_address,
      amount: r.amount,
      reason: r.reason,
      slashedAt: r.slashed_at,
    }))
  }

  /** Reverse lookup: which subtask was this agent claiming when it got
   *  slashed? The Slashed event itself only carries (taskId, agent),
   *  not nodeId, so we infer it from the per-task DAG snapshot. Returns
   *  the nodeId if a unique match exists; null when the agent claimed
   *  multiple nodes (rare but possible — falls back to task-level slash
   *  semantics). */
  findNodeByAgent(taskId: string, agentId: string): string | null {
    const rows = this.db
      .prepare(
        `SELECT node_id FROM task_dag_nodes WHERE task_id = ? AND agent_id = ?`,
      )
      .all(taskId, agentId) as Array<{ node_id: string }>
    return rows.length === 1 ? rows[0].node_id : null
  }

  /** Last CHALLENGE event reason for a (taskId, nodeId) pair. SlashWatcher
   *  uses this to attribute a slash to its triggering challenge so the UI
   *  can show "Slashed: validation_failed" instead of just "Slashed". */
  getLastChallengeReason(taskId: string, nodeId: string): string | null {
    const rows = this.db
      .prepare(
        `SELECT payload_json FROM task_events
         WHERE task_id = ? AND event_type = 'CHALLENGE'
         ORDER BY timestamp DESC LIMIT 8`,
      )
      .all(taskId) as Array<{ payload_json: string }>
    for (const r of rows) {
      try {
        const p = JSON.parse(r.payload_json)
        if (p?.nodeId === nodeId && typeof p?.reason === 'string') return p.reason
      } catch {
        // Ignore — corrupt rows fall through to null
      }
    }
    return null
  }

  recordEvent(taskId: string, type: string, payload: any): void {
    const ts = Date.now()
    const pJson = JSON.stringify(payload)
    try {
      this.db
        .prepare(`INSERT INTO task_events (task_id, event_type, payload_json, timestamp) VALUES (?, ?, ?, ?)`)
        .run(taskId, type, pJson, ts)
    } catch (err) {
      // Ignore unique constraint collisions for identical events arriving via
      // both RPC and AXL shims.
    }
  }

  getEvents(taskId: string): Array<{ type: string; payload: any; timestamp: number }> {
    const rows = this.db
      .prepare(`SELECT event_type, payload_json, timestamp FROM task_events WHERE task_id = ? ORDER BY timestamp ASC`)
      .all(taskId) as Array<{ event_type: string; payload_json: string; timestamp: number }>
    
    return rows.map(r => ({
      type: r.event_type,
      payload: JSON.parse(r.payload_json),
      timestamp: r.timestamp
    }))
  }

  // ------------------------------------------------------------------
  // Reads — called from /task/:taskId, /v1/me/tasks, /v1/tasks/:id/result
  // ------------------------------------------------------------------

  getDag(taskId: string): TaskNodeRow[] {
    const rows = this.db
      .prepare(
        `SELECT task_id, node_id, position, subtask, status, agent_id, output_hash,
                result, transcript, iterations, stop_reason, tools_used, updated_at
         FROM task_dag_nodes WHERE task_id = ?
         ORDER BY position ASC, node_id ASC`,
      )
      .all(taskId) as any[]
    return rows.map(rowToNode)
  }

  /** Subset of getDag — only nodes with a non-null result. Used by the
   *  /result endpoints which return aggregated final answers. */
  listResults(taskId: string): Array<{ nodeId: string; result: string }> {
    const rows = this.db
      .prepare(
        `SELECT node_id, result FROM task_dag_nodes
         WHERE task_id = ? AND result IS NOT NULL
         ORDER BY position ASC, node_id ASC`,
      )
      .all(taskId) as Array<{ node_id: string; result: string }>
    return rows.map(r => ({ nodeId: r.node_id, result: r.result }))
  }

  /** Cheap "did anything land?" probe used to mark a task completed in
   *  /v1/me/tasks status without rehydrating the full result. */
  hasAnyResult(taskId: string): boolean {
    const row = this.db
      .prepare(`SELECT 1 FROM task_dag_nodes WHERE task_id = ? AND result IS NOT NULL LIMIT 1`)
      .get(taskId)
    return !!row
  }

  countResults(taskId: string): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) AS c FROM task_dag_nodes WHERE task_id = ? AND result IS NOT NULL`)
      .get(taskId) as { c: number }
    return row.c
  }

  /** Wipe all state for a single task — DAG nodes + event timeline. Used
   *  by the profile DELETE routes after the owner-scoped TaskIndex.delete
   *  succeeds. Wrapped in a transaction so a partial failure can't leave
   *  events orphaned from their parent DAG (or vice versa). Idempotent:
   *  no-op if the task isn't in the store. */
  deleteTask(taskId: string): void {
    const txn = this.db.transaction((tid: string) => {
      this.db.prepare(`DELETE FROM task_dag_nodes WHERE task_id = ?`).run(tid)
      this.db.prepare(`DELETE FROM task_events WHERE task_id = ?`).run(tid)
      this.db.prepare(`DELETE FROM agent_slashes WHERE task_id = ?`).run(tid)
    })
    txn(taskId)
  }

  close(): void {
    this.db.close()
  }
}

function rowToNode(r: any): TaskNodeRow {
  return {
    taskId: r.task_id,
    nodeId: r.node_id,
    position: r.position,
    subtask: r.subtask,
    status: r.status,
    agentId: r.agent_id,
    outputHash: r.output_hash,
    result: r.result,
    transcriptJson: r.transcript,
    iterations: r.iterations,
    stopReason: r.stop_reason,
    toolsUsedJson: r.tools_used,
    updatedAt: r.updated_at,
  }
}
