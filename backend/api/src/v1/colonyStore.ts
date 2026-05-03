import Database, { type Database as DB } from 'better-sqlite3'
import path from 'node:path'
import fs from 'node:fs'
import crypto from 'node:crypto'

/**
 * User-owned colony (curated agent group). Tasks tagged with a colonyId
 * are only picked up by member agents; tasks without a colonyId remain
 * public and any agent can claim. Membership is enforced off-chain by the
 * SwarmAgent's task-submitted handler reading its own membership list
 * from /internal/agents/:id/colonies. For production, this should move
 * to an on-chain ColonyRegistry; current implementation is SQLite-backed
 * and trusts the API server.
 *
 * Schema is Postgres-portable (TEXT IDs, ISO timestamps) so we can swap
 * drivers later without rewriting queries.
 */

export type ColonyVisibility = 'private' | 'public'

export interface Colony {
  id: string
  owner: string
  name: string
  description: string | null
  /** 'private' = only the owner can submit tasks scoped here. 'public' =
   *  anyone can submit. Membership management is always owner-only
   *  regardless of visibility. */
  visibility: ColonyVisibility
  createdAt: string
  archivedAt: string | null
}

export interface ColonyMember {
  agentId: string
  addedAt: string
}

export class ColonyStore {
  private db: DB

  constructor(opts: { dbPath?: string } = {}) {
    const dbPath = opts.dbPath ?? path.join(process.cwd(), 'data', 'api.db')
    fs.mkdirSync(path.dirname(dbPath), { recursive: true })
    this.db = new Database(dbPath)
    // KeyStore enables WAL globally; safe to skip here. Foreign keys
    // are per-connection, so re-enable for cascade deletes on members.
    this.db.pragma('foreign_keys = ON')
    this.migrate()
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS colonies (
        id           TEXT PRIMARY KEY,
        owner        TEXT NOT NULL,
        name         TEXT NOT NULL,
        description  TEXT,
        created_at   TEXT NOT NULL,
        archived_at  TEXT
      );
      CREATE INDEX IF NOT EXISTS colonies_owner_idx
        ON colonies(owner) WHERE archived_at IS NULL;

      CREATE TABLE IF NOT EXISTS colony_members (
        colony_id  TEXT NOT NULL,
        agent_id   TEXT NOT NULL,
        added_at   TEXT NOT NULL,
        PRIMARY KEY (colony_id, agent_id),
        FOREIGN KEY (colony_id) REFERENCES colonies(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS colony_members_agent_idx
        ON colony_members(agent_id);
    `)
    // Additive migration: visibility wasn't in the original schema. Default
    // 'private' for any pre-existing rows so opening the app doesn't expose
    // them to other users without an explicit owner action.
    const cols = this.db.prepare(`PRAGMA table_info(colonies)`).all() as Array<{ name: string }>
    if (!cols.some(c => c.name === 'visibility')) {
      this.db.exec(`ALTER TABLE colonies ADD COLUMN visibility TEXT NOT NULL DEFAULT 'private'`)
      this.db.exec(`CREATE INDEX IF NOT EXISTS colonies_public_idx ON colonies(visibility) WHERE visibility = 'public' AND archived_at IS NULL`)
    }
  }

  // ─── Colony lifecycle ──────────────────────────────────────────────

  create(opts: {
    owner: string
    name: string
    description?: string | null
    visibility?: ColonyVisibility
  }): Colony {
    const id = crypto.randomUUID()
    const createdAt = new Date().toISOString()
    const description = opts.description ?? null
    const visibility: ColonyVisibility = opts.visibility ?? 'private'
    this.db
      .prepare(
        `INSERT INTO colonies (id, owner, name, description, visibility, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(id, opts.owner.toLowerCase(), opts.name, description, visibility, createdAt)
    return {
      id,
      owner: opts.owner.toLowerCase(),
      name: opts.name,
      description,
      visibility,
      createdAt,
      archivedAt: null,
    }
  }

  /** Owner-only flip between private and public. Returns true on actual
   *  state change so callers can avoid emitting an event when nothing
   *  moved (e.g., toggling a public colony to public is a no-op). */
  setVisibility(id: string, owner: string, visibility: ColonyVisibility): boolean {
    const result = this.db
      .prepare(
        `UPDATE colonies
         SET visibility = ?
         WHERE id = ? AND owner = ? AND archived_at IS NULL AND visibility != ?`,
      )
      .run(visibility, id, owner.toLowerCase(), visibility)
    return result.changes > 0
  }

  /** Public discovery — agents from these colonies show up in the explorer
   *  dropdown for ALL users (not just the owner). Excludes archived. */
  listPublic(): Colony[] {
    const rows = this.db
      .prepare(
        `SELECT id, owner, name, description, visibility, created_at, archived_at
         FROM colonies
         WHERE visibility = 'public' AND archived_at IS NULL
         ORDER BY created_at DESC`,
      )
      .all() as Array<{
        id: string
        owner: string
        name: string
        description: string | null
        visibility: ColonyVisibility
        created_at: string
        archived_at: string | null
      }>
    return rows.map(r => ({
      id: r.id,
      owner: r.owner,
      name: r.name,
      description: r.description,
      visibility: r.visibility,
      createdAt: r.created_at,
      archivedAt: r.archived_at,
    }))
  }

  /** Soft-delete: archive flag set, agent memberships preserved for audit.
   *  Returns true iff the row belonged to `owner` and was active. */
  archive(id: string, owner: string): boolean {
    const result = this.db
      .prepare(
        `UPDATE colonies
         SET archived_at = ?
         WHERE id = ? AND owner = ? AND archived_at IS NULL`,
      )
      .run(new Date().toISOString(), id, owner.toLowerCase())
    return result.changes > 0
  }

  /** Hard delete used only when archive is insufficient (e.g., user wants
   *  to free the name to recreate). Cascade clears members. */
  destroy(id: string, owner: string): boolean {
    const result = this.db
      .prepare(`DELETE FROM colonies WHERE id = ? AND owner = ?`)
      .run(id, owner.toLowerCase())
    return result.changes > 0
  }

  get(id: string): Colony | null {
    const row = this.db
      .prepare(
        `SELECT id, owner, name, description, visibility, created_at, archived_at
         FROM colonies WHERE id = ?`,
      )
      .get(id) as
      | {
          id: string
          owner: string
          name: string
          description: string | null
          visibility: ColonyVisibility
          created_at: string
          archived_at: string | null
        }
      | undefined
    if (!row) return null
    return {
      id: row.id,
      owner: row.owner,
      name: row.name,
      description: row.description,
      visibility: row.visibility,
      createdAt: row.created_at,
      archivedAt: row.archived_at,
    }
  }

  /** List ACTIVE colonies belonging to `owner`. Archived ones excluded. */
  listForOwner(owner: string): Colony[] {
    const rows = this.db
      .prepare(
        `SELECT id, owner, name, description, visibility, created_at, archived_at
         FROM colonies
         WHERE owner = ? AND archived_at IS NULL
         ORDER BY created_at DESC`,
      )
      .all(owner.toLowerCase()) as Array<{
        id: string
        owner: string
        name: string
        description: string | null
        visibility: ColonyVisibility
        created_at: string
        archived_at: string | null
      }>
    return rows.map(r => ({
      id: r.id,
      owner: r.owner,
      name: r.name,
      description: r.description,
      visibility: r.visibility,
      createdAt: r.created_at,
      archivedAt: r.archived_at,
    }))
  }

  // ─── Membership ────────────────────────────────────────────────────

  /** Best-effort upsert. Caller MUST verify both:
   *  - colony.owner == requester (this layer doesn't know who's calling)
   *  - the agent in question belongs to `requester` (cross-check w/ AgentManager)
   *  Idempotent on duplicate add. */
  addMember(colonyId: string, agentId: string): boolean {
    const result = this.db
      .prepare(
        `INSERT OR IGNORE INTO colony_members (colony_id, agent_id, added_at)
         VALUES (?, ?, ?)`,
      )
      .run(colonyId, agentId, new Date().toISOString())
    return result.changes > 0
  }

  removeMember(colonyId: string, agentId: string): boolean {
    const result = this.db
      .prepare(`DELETE FROM colony_members WHERE colony_id = ? AND agent_id = ?`)
      .run(colonyId, agentId)
    return result.changes > 0
  }

  /** Drop the agent from every colony it belongs to (active and archived).
   *  Used by SlashWatcher when an on-chain `Slashed` event lands — a slashed
   *  agent loses trust, so it should stop pulling colony-scoped tasks
   *  immediately. Returns the list of colonyIds the agent was actually
   *  removed from so the caller can broadcast a per-colony
   *  COLONY_MEMBERSHIP_CHANGED event without waiting for the agent's 30s
   *  poll. Includes archived colonies in the lookup so the audit trail
   *  doesn't leave stale memberships behind. */
  removeAgentFromAllColonies(agentId: string): string[] {
    const rows = this.db
      .prepare(`SELECT colony_id FROM colony_members WHERE agent_id = ?`)
      .all(agentId) as Array<{ colony_id: string }>
    if (rows.length === 0) return []
    this.db.prepare(`DELETE FROM colony_members WHERE agent_id = ?`).run(agentId)
    return rows.map(r => r.colony_id)
  }

  getMembers(colonyId: string): ColonyMember[] {
    const rows = this.db
      .prepare(
        `SELECT agent_id, added_at FROM colony_members
         WHERE colony_id = ? ORDER BY added_at ASC`,
      )
      .all(colonyId) as Array<{ agent_id: string; added_at: string }>
    return rows.map(r => ({ agentId: r.agent_id, addedAt: r.added_at }))
  }

  /** Used by the agent-side filter: which colonies is this agent a member
   *  of? Excludes archived colonies. */
  listColoniesForAgent(agentId: string): string[] {
    const rows = this.db
      .prepare(
        `SELECT c.id FROM colony_members m
         JOIN colonies c ON c.id = m.colony_id
         WHERE m.agent_id = ? AND c.archived_at IS NULL`,
      )
      .all(agentId) as Array<{ id: string }>
    return rows.map(r => r.id)
  }

  /** True if the requester owns the colony AND the colony is active.
   *  Centralised so route handlers don't repeat the SELECT. */
  ownerCheck(colonyId: string, requester: string): { ok: true; colony: Colony } | { ok: false; reason: 'not_found' | 'not_owner' | 'archived' } {
    const colony = this.get(colonyId)
    if (!colony) return { ok: false, reason: 'not_found' }
    if (colony.archivedAt) return { ok: false, reason: 'archived' }
    if (colony.owner !== requester.toLowerCase()) return { ok: false, reason: 'not_owner' }
    return { ok: true, colony }
  }

  close(): void {
    this.db.close()
  }
}
