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
