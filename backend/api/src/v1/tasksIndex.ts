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
    // completed_at. PRAGMA table_info enumerates current columns; we only
    // ALTER if the column is missing so re-runs are idempotent.
    const cols = this.db.prepare(`PRAGMA table_info(user_tasks)`).all() as Array<{ name: string }>
    if (!cols.some(c => c.name === 'completed_at')) {
      this.db.exec(`ALTER TABLE user_tasks ADD COLUMN completed_at TEXT`)
    }
  }

  /** Marks a task as completed. Called from server.ts on DAG_COMPLETED with
   *  settled=true. Idempotent — first non-null write wins, later calls are
   *  ignored so a re-broadcast doesn't reset the timestamp. */
  markCompleted(taskId: string, when?: string): void {
    const ts = when ?? new Date().toISOString()
    this.db
      .prepare(`UPDATE user_tasks SET completed_at = ? WHERE task_id = ? AND completed_at IS NULL`)
      .run(ts, taskId)
  }

  /** Idempotent on conflict — re-broadcast of the same content-addressed
   *  task spec yields the same taskId and we just keep the original row.
   *  Callers don't supply completedAt — it's filled in later by markCompleted
   *  when DAG_COMPLETED(settled=true) lands. */
  record(row: Omit<UserTaskRow, 'submittedAt' | 'completedAt'> & { submittedAt?: string }): void {
    const submittedAt = row.submittedAt ?? new Date().toISOString()
    this.db
      .prepare(
        `INSERT OR IGNORE INTO user_tasks
         (task_id, owner, spec, budget, source, submitted_at, model)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(row.taskId, row.owner.toLowerCase(), row.spec, row.budget, row.source, submittedAt, row.model ?? null)
  }

  listForOwner(owner: string, limit = 100): UserTaskRow[] {
    const rows = this.db
      .prepare(
        `SELECT task_id, owner, spec, budget, source, submitted_at, model, completed_at
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
    }))
  }

  close(): void {
    this.db.close()
  }
}
