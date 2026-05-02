import Database, { type Database as DB } from 'better-sqlite3'
import path from 'node:path'
import fs from 'node:fs'

/**
 * Per-API-key registered LangChain agents. Each row carries the
 * ephemeral on-chain EOA the operator minted at register time, plus
 * the encrypted private key so the operator can sign txs with that
 * EOA (separating each agent's on-chain identity).
 *
 * Schema is Postgres-portable — TEXT ids, ISO timestamps, BLOB for
 * the encrypted PK. Same SQLite file as KeyStore / TaskIndex /
 * ColonyStore so connections share WAL.
 */

export interface SporeiseAgentRow {
  id: string
  /** Lowercased EOA. */
  user_address: string
  /** Stable label the SDK user passed in `sporeise([{id: 'researcher', ...}])`. */
  agent_label: string
  /** On-chain EOA minted at register time. */
  agent_address: string
  /** AES-GCM-encrypted private key, base64-encoded. */
  pk_encrypted: string
  description: string | null
  model: string | null
  /** ISO 8601. */
  created_at: string
}

export interface SporeiseAgentInfo {
  id: string
  agentLabel: string
  agentAddress: string
  description: string | null
  model: string | null
  createdAt: string
}

interface AgentInsert {
  id: string
  userAddress: string
  agentLabel: string
  agentAddress: string
  pkEncrypted: string
  description: string | null
  model: string | null
}

export class SporeiseStore {
  private db: DB

  constructor(opts: { dbPath?: string } = {}) {
    const dbPath = opts.dbPath ?? path.join(process.cwd(), 'data', 'api.db')
    fs.mkdirSync(path.dirname(dbPath), { recursive: true })
    this.db = new Database(dbPath)
    this.migrate()
  }

  private migrate(): void {
    // Defensive bring-up: the table may not exist (fresh DB), may exist
    // with the current schema, or may exist with an older schema from
    // an earlier dev iteration. We CREATE IF NOT EXISTS for the happy
    // path, then explicitly check for the columns we need and `ALTER`
    // them in if missing — this matches what colonyStore.ts does and
    // avoids API startup crashes when the user's `data/api.db` is from
    // a stale build.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sporeise_agents (
        id              TEXT PRIMARY KEY,
        user_address    TEXT NOT NULL,
        agent_label     TEXT NOT NULL,
        agent_address   TEXT NOT NULL,
        pk_encrypted    TEXT NOT NULL,
        description     TEXT,
        model           TEXT,
        created_at      TEXT NOT NULL
      );
    `)
    // Inspect actual columns. If an older incarnation of the table
    // exists without `agent_label`, add it as nullable so existing rows
    // don't violate NOT NULL on insert. Cleanup below then drops them.
    const cols = this.db
      .prepare(`PRAGMA table_info(sporeise_agents)`)
      .all() as Array<{ name: string }>
    const has = (c: string) => cols.some(x => x.name === c)
    if (!has('agent_label')) {
      this.db.exec(`ALTER TABLE sporeise_agents ADD COLUMN agent_label TEXT`)
      console.warn('[SporeiseStore] migrated: added missing agent_label column')
    }
    if (!has('user_address'))    this.db.exec(`ALTER TABLE sporeise_agents ADD COLUMN user_address TEXT`)
    if (!has('agent_address'))   this.db.exec(`ALTER TABLE sporeise_agents ADD COLUMN agent_address TEXT`)
    if (!has('pk_encrypted'))    this.db.exec(`ALTER TABLE sporeise_agents ADD COLUMN pk_encrypted TEXT`)
    if (!has('description'))     this.db.exec(`ALTER TABLE sporeise_agents ADD COLUMN description TEXT`)
    if (!has('model'))           this.db.exec(`ALTER TABLE sporeise_agents ADD COLUMN model TEXT`)
    if (!has('created_at'))      this.db.exec(`ALTER TABLE sporeise_agents ADD COLUMN created_at TEXT`)

    // Per-user uniqueness on the SDK-supplied label so a user can call
    // sporeise([{id:'researcher'}]) twice and get the SAME on-chain EOA
    // back instead of churning a new one each time.
    this.db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS sporeise_agents_user_label
        ON sporeise_agents(user_address, agent_label);
    `)

    // One-time cleanup: rows where agent_label was accidentally written
    // as the row UUID (early dev loop bug — runner sent internal id over
    // WS which then leaked back into label storage), or rows from an
    // older schema where agent_label was NULL. Both are unusable; the
    // SDK can never route invokes to them. Their on-chain EOA is
    // orphaned but the operator already paid for that gas — sunk cost.
    try {
      const cleanup = this.db
        .prepare(`DELETE FROM sporeise_agents WHERE agent_label IS NULL OR agent_label = id`)
        .run()
      if (cleanup.changes > 0) {
        console.warn(
          `[SporeiseStore] cleaned up ${cleanup.changes} stale row(s). Re-register the affected agents via sporeise([...]).`,
        )
      }
    } catch (err) {
      // Don't crash the API on a malformed legacy table — just log and
      // let listForUser return whatever's there.
      console.warn('[SporeiseStore] cleanup migration failed (non-fatal):', err)
    }
  }

  insert(input: AgentInsert): SporeiseAgentInfo {
    const createdAt = new Date().toISOString()
    this.db
      .prepare(
        `INSERT INTO sporeise_agents (id, user_address, agent_label, agent_address, pk_encrypted, description, model, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.id,
        input.userAddress.toLowerCase(),
        input.agentLabel,
        input.agentAddress.toLowerCase(),
        input.pkEncrypted,
        input.description,
        input.model,
        createdAt,
      )
    return {
      id: input.id,
      agentLabel: input.agentLabel,
      agentAddress: input.agentAddress.toLowerCase(),
      description: input.description,
      model: input.model,
      createdAt,
    }
  }

  /** Lookup by (user, label). Used by /v1/sporeise/register to short-
   *  circuit duplicate registration — same label re-uses the existing
   *  on-chain EOA so the user doesn't burn gas on re-registers. */
  getByLabel(userAddress: string, agentLabel: string): SporeiseAgentRow | null {
    const row = this.db
      .prepare(
        `SELECT id, user_address, agent_label, agent_address, pk_encrypted, description, model, created_at
         FROM sporeise_agents
         WHERE user_address = ? AND agent_label = ?`,
      )
      .get(userAddress.toLowerCase(), agentLabel) as SporeiseAgentRow | undefined
    return row ?? null
  }

  listForUser(userAddress: string): SporeiseAgentInfo[] {
    const rows = this.db
      .prepare(
        `SELECT id, agent_label, agent_address, description, model, created_at
         FROM sporeise_agents
         WHERE user_address = ?
         ORDER BY created_at ASC`,
      )
      .all(userAddress.toLowerCase()) as Array<{
        id: string
        agent_label: string
        agent_address: string
        description: string | null
        model: string | null
        created_at: string
      }>
    return rows.map(r => ({
      id: r.id,
      agentLabel: r.agent_label,
      agentAddress: r.agent_address,
      description: r.description,
      model: r.model,
      createdAt: r.created_at,
    }))
  }

  /** Used by SporeiseRunner to load the encrypted PK so it can sign on
   *  behalf of an agent. Returns the full row so the caller has both
   *  EOA and ciphertext. */
  getRow(id: string): SporeiseAgentRow | null {
    const row = this.db
      .prepare(
        `SELECT id, user_address, agent_label, agent_address, pk_encrypted, description, model, created_at
         FROM sporeise_agents
         WHERE id = ?`,
      )
      .get(id) as SporeiseAgentRow | undefined
    return row ?? null
  }

  close(): void {
    this.db.close()
  }
}
