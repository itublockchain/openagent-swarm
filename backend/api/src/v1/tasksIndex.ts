import Database, { type Database as DB } from 'better-sqlite3'
import path from 'node:path'
import fs from 'node:fs'

/**
 * Per-owner task index. Lets the webapp's profile page enumerate tasks a
 * given wallet has submitted without scanning chain logs.
 *
 * Insertion is best-effort from BOTH submission paths:
 *   - /task          (legacy web flow — user signs createTask directly)
 *   - /v1/tasks      (SDK flow — operator signs Treasury.spendOnBehalfOf)
 *
 * Status is NOT stored here — it's derived at read time from the
 * `taskResults` in-memory map (completed) and storage existence (pending),
 * so the index never goes stale relative to the source of truth.
 *
 * Same SQLite file as KeyStore, separate connection. WAL mode (set by
 * KeyStore) lets the two connections coexist without locking.
 */

export interface UserTaskRow {
  taskId: string
  owner: string
  spec: string
  budget: string
  source: 'web' | 'sdk'
  submittedAt: string
  model: string | null
  /** ISO timestamp set by markCompleted() when DAG_COMPLETED(settled=true)
   *  fires for this task. Persists across API restarts so profile/page
   *  doesn't slip back to "pending" once the in-memory taskResults map
   *  resets. */
  completedAt: string | null
  /** Optional colony scope this task was routed to. Stored so per-colony
   *  stats (total / completed / pending) survive process restart. */
  colonyId: string | null
  /** Agent who won the claimPlanner bid and produced the DAG. Set when
   *  DAG_READY arrives. */
  plannerId: string | null
  /** Captured final aggregated result when DAG_COMPLETED(settled=true)
   *  fires. Shown in task list snippets. */
  finalResult: string | null
}

export interface ColonyTaskStats {
  total: number
  completed: number
  pending: number
}

export class TaskIndex {
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
      CREATE TABLE IF NOT EXISTS user_tasks (
        task_id       TEXT PRIMARY KEY,
        owner         TEXT NOT NULL,
        spec          TEXT NOT NULL,
        budget        TEXT NOT NULL,
        source        TEXT NOT NULL CHECK (source IN ('web', 'sdk')),
        submitted_at  TEXT NOT NULL,
        model         TEXT
      );
      CREATE INDEX IF NOT EXISTS user_tasks_owner_idx ON user_tasks(owner);
    `)
    // Additive migration — older deployments may have the table without
    // completed_at / colony_id. PRAGMA table_info enumerates current columns;
    // we only ALTER if the column is missing so re-runs are idempotent.
    const cols = this.db.prepare(`PRAGMA table_info(user_tasks)`).all() as Array<{ name: string }>
    if (!cols.some(c => c.name === 'completed_at')) {
      this.db.exec(`ALTER TABLE user_tasks ADD COLUMN completed_at TEXT`)
    }
    if (!cols.some(c => c.name === 'colony_id')) {
      this.db.exec(`ALTER TABLE user_tasks ADD COLUMN colony_id TEXT`)
      // Index lets per-colony stats stay O(rows-in-colony) rather than full
      // table scan as the index grows.
      this.db.exec(`CREATE INDEX IF NOT EXISTS user_tasks_colony_idx ON user_tasks(colony_id) WHERE colony_id IS NOT NULL`)
    }
    if (!cols.some(c => c.name === 'final_result')) {
      this.db.exec(`ALTER TABLE user_tasks ADD COLUMN final_result TEXT`)
    }
    if (!cols.some(c => c.name === 'planner_id')) {
      this.db.exec(`ALTER TABLE user_tasks ADD COLUMN planner_id TEXT`)
    }
  }

  /** Marks a task as completed. Called from server.ts on DAG_COMPLETED with
   *  settled=true. Idempotent — first non-null write wins, later calls are
   *  ignored so a re-broadcast doesn't reset the timestamp. */
  markCompleted(taskId: string, when?: string, finalResult?: string): void {
    const ts = when ?? new Date().toISOString()
    this.db
      .prepare(`UPDATE user_tasks SET completed_at = ?, final_result = COALESCE(?, final_result) WHERE task_id = ? AND completed_at IS NULL`)
      .run(ts, finalResult ?? null, taskId)
  }

  /** Idempotent on conflict — re-broadcast of the same content-addressed
   *  task spec yields the same taskId and we just keep the original row.
   *  Callers don't supply completedAt — it's filled in later by markCompleted
   *  when DAG_COMPLETED(settled=true) lands. colonyId is optional; null means
   *  "public task, no colony scope". */
  record(row: Omit<UserTaskRow, 'submittedAt' | 'completedAt' | 'colonyId' | 'plannerId' | 'finalResult'> & {
    submittedAt?: string
    colonyId?: string | null
  }): void {
    const submittedAt = row.submittedAt ?? new Date().toISOString()
    this.db
      .prepare(
        `INSERT OR IGNORE INTO user_tasks
         (task_id, owner, spec, budget, source, submitted_at, model, colony_id, planner_id, final_result)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)`,
      )
      .run(row.taskId, row.owner.toLowerCase(), row.spec, row.budget, row.source, submittedAt, row.model ?? null, row.colonyId ?? null)
  }

  /** Per-colony aggregate. Total = rows tagged with colonyId. Completed =
   *  rows with completed_at set. Pending = total − completed. Single
   *  COUNT(*) + COUNT(completed_at) query so it stays cheap as history grows. */
  getColonyStats(colonyId: string): ColonyTaskStats {
    const r = this.db
      .prepare(
        `SELECT
           COUNT(*) AS total,
           COUNT(completed_at) AS completed
         FROM user_tasks WHERE colony_id = ?`,
      )
      .get(colonyId) as { total: number; completed: number }
    return { total: r.total, completed: r.completed, pending: r.total - r.completed }
  }

  /** Reverse lookup: which address submitted this task. Returns lowercase
   *  to match the stored form. Used by the WS bridge to scope events
   *  to their submitter so other connected users don't see them. */
  getOwner(taskId: string): string | null {
    const row = this.db
      .prepare(`SELECT owner FROM user_tasks WHERE task_id = ?`)
      .get(taskId) as { owner: string } | undefined
    return row ? row.owner : null
  }

  /** Owner-scoped single-row delete. Returns true iff a row was actually
   *  removed — the owner WHERE clause is what makes this safe to expose
   *  without a separate ownership check. Caller is responsible for
   *  cascading the cleanup into TaskStateStore (dag nodes + events). */
  delete(taskId: string, owner: string): boolean {
    const result = this.db
      .prepare(`DELETE FROM user_tasks WHERE task_id = ? AND owner = ?`)
      .run(taskId, owner.toLowerCase())
    return result.changes > 0
  }

  /** Owner-scoped bulk delete used by the profile-page "Clear all" button.
   *  Returns the list of deleted task ids so the caller can cascade the
   *  cleanup into TaskStateStore (which is keyed only on taskId, no
   *  owner column). */
  deleteAllForOwner(owner: string): string[] {
    const rows = this.db
      .prepare(`SELECT task_id FROM user_tasks WHERE owner = ?`)
      .all(owner.toLowerCase()) as Array<{ task_id: string }>
    if (rows.length === 0) return []
    this.db.prepare(`DELETE FROM user_tasks WHERE owner = ?`).run(owner.toLowerCase())
    return rows.map(r => r.task_id)
  }

  listForOwner(owner: string, limit = 100): UserTaskRow[] {
    const rows = this.db
      .prepare(
        `SELECT task_id, owner, spec, budget, source, submitted_at, model, completed_at, colony_id, final_result, planner_id
         FROM user_tasks WHERE owner = ?
         ORDER BY submitted_at DESC LIMIT ?`,
      )
      .all(owner.toLowerCase(), limit) as Array<{
        task_id: string
        owner: string
        spec: string
        budget: string
        source: 'web' | 'sdk'
        submitted_at: string
        model: string | null
        completed_at: string | null
        colony_id: string | null
        final_result: string | null
        planner_id: string | null
      }>

    return rows.map(r => ({
      taskId: r.task_id,
      owner: r.owner,
      spec: r.spec,
      budget: r.budget,
      source: r.source,
      submittedAt: r.submitted_at,
      model: r.model,
      completedAt: r.completed_at,
      colonyId: r.colony_id,
      finalResult: r.final_result,
      plannerId: r.planner_id,
    }))
  }

  close(): void {
    this.db.close()
  }
}
