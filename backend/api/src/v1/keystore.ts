import Database, { type Database as DB } from 'better-sqlite3'
import crypto from 'node:crypto'
import path from 'node:path'
import fs from 'node:fs'
import { keccak256, toUtf8Bytes } from 'ethers'

/**
 * SDK API key store. Backed by SQLite for the MVP — schema is intentionally
 * Postgres-portable so we can swap the driver later without changing SQL:
 *
 *  - All ids are TEXT (UUID strings, not autoinc)
 *  - All timestamps are TEXT in ISO 8601 (lex-sortable; both DBs equate)
 *  - Key hash is BLOB (SQLite) / BYTEA (Postgres) — single binary column
 *  - Scopes is TEXT (CSV) instead of array; cheaper than json/blob,
 *    Postgres can later add a generated array column if needed
 *
 * Plaintext keys NEVER touch storage. The hash used everywhere is
 * `keccak256(plaintext)` — Ethereum-native bytes32, so the SAME hash value
 * is what Treasury sees in bindKey/spendOnBehalfOf. No salt: random 32-byte
 * keys make rainbow-table salting cosmetic, and using a salt would break
 * the DB↔chain hash equivalence (or force the salt to leak out of the
 * server, defeating the purpose).
 */

export interface ApiKeyRow {
  id: string
  user_address: string
  key_hash: Buffer
  scopes: string  // comma-separated
  name: string | null
  created_at: string
  last_used_at: string | null
  frozen_at: string | null
  revoked_at: string | null
}

export interface ApiKeyPublic {
  id: string
  userAddress: string
  scopes: string[]
  name: string | null
  createdAt: string
  lastUsedAt: string | null
  frozenAt: string | null
  revokedAt: string | null
  /** First 12 chars of plaintext, e.g. `sk_live_a1b2c3d4` — for UI display
   *  so users can identify keys at a glance without exposing the rest. */
  prefix: string
}

export type Scope = 'tasks:submit' | 'tasks:read' | 'agents:read' | 'swarm:write'

/** Default scopes the webapp's "Generate Key" button grants. */
export const DEFAULT_SCOPES: Scope[] = ['tasks:submit', 'tasks:read', 'swarm:write']

/** Compute the canonical keyHash — keccak256(plaintext) as bytes32.
 *  Same value used by DB lookup AND Treasury contract. */
function hashKey(plaintext: string): Buffer {
  return Buffer.from(keccak256(toUtf8Bytes(plaintext)).slice(2), 'hex')
}

/** Same hash, returned as 0x-prefixed hex for chain calls. */
export function chainKeyHash(plaintext: string): `0x${string}` {
  return keccak256(toUtf8Bytes(plaintext)) as `0x${string}`
}

/** Stores the public prefix (first 12 chars of plaintext) so the UI can
 *  show "sk_live_a1b2c3d4…" without keeping the full key. */
function publicPrefix(plaintext: string): string {
  return plaintext.slice(0, 12) + '…'
}

export class KeyStore {
  private db: DB

  constructor(opts: { dbPath?: string }) {
    const dbPath = opts.dbPath ?? path.join(process.cwd(), 'data', 'api.db')
    fs.mkdirSync(path.dirname(dbPath), { recursive: true })
    this.db = new Database(dbPath)
    this.db.pragma('journal_mode = WAL')
    this.db.pragma('foreign_keys = ON')
    this.migrate()
  }

  private migrate(): void {
    // Idempotent — runs every startup. Schema is plain SQL; the only
    // SQLite-isms are BLOB (Postgres → BYTEA) and the CHECK constraint.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS api_keys (
        id            TEXT PRIMARY KEY,
        user_address  TEXT NOT NULL,
        key_hash      BLOB NOT NULL UNIQUE,
        scopes        TEXT NOT NULL,
        name          TEXT,
        prefix        TEXT NOT NULL,
        created_at    TEXT NOT NULL,
        last_used_at  TEXT,
        frozen_at     TEXT,
        revoked_at    TEXT,
        CHECK (length(key_hash) = 32)
      );
      CREATE INDEX IF NOT EXISTS api_keys_user_idx
        ON api_keys(user_address) WHERE revoked_at IS NULL;
    `)
  }

  /** Generate a new key for `userAddress` with the given scopes. Returns
   *  both the plaintext (shown ONCE in the UI) and the public row, plus
   *  the on-chain `keyHash` the webapp passes to `Treasury.bindKey`. */
  create(opts: {
    userAddress: string
    scopes: Scope[]
    name?: string | null
    env: 'live' | 'test'
  }): { plaintext: string; chainKeyHash: `0x${string}`; row: ApiKeyPublic } {
    const id = crypto.randomUUID()
    const random = crypto.randomBytes(32).toString('hex')
    const plaintext = `sk_${opts.env}_${random}`
    const key_hash = hashKey(plaintext)
    const prefix = publicPrefix(plaintext)
    const created_at = new Date().toISOString()
    const scopesCsv = opts.scopes.join(',')

    this.db
      .prepare(
        `INSERT INTO api_keys (id, user_address, key_hash, scopes, name, prefix, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, opts.userAddress.toLowerCase(), key_hash, scopesCsv, opts.name ?? null, prefix, created_at)

    return {
      plaintext,
      chainKeyHash: chainKeyHash(plaintext),
      row: {
        id,
        userAddress: opts.userAddress.toLowerCase(),
        scopes: opts.scopes,
        name: opts.name ?? null,
        createdAt: created_at,
        lastUsedAt: null,
        frozenAt: null,
        revokedAt: null,
        prefix,
      },
    }
  }

  /** Resolve an inbound `Authorization: Bearer sk_...` header. Returns the
   *  bound user + scopes + chain keyHash (for `spendOnBehalfOf` calls), or
   *  null if invalid / revoked / frozen. Bumps `last_used_at` on hit. */
  lookup(plaintext: string): { userAddress: string; scopes: Scope[]; chainKeyHash: `0x${string}` } | null {
    if (!plaintext.startsWith('sk_live_') && !plaintext.startsWith('sk_test_')) return null
    const key_hash = hashKey(plaintext)

    const row = this.db
      .prepare(
        `SELECT id, user_address, scopes, frozen_at, revoked_at
         FROM api_keys WHERE key_hash = ?`,
      )
      .get(key_hash) as
      | { id: string; user_address: string; scopes: string; frozen_at: string | null; revoked_at: string | null }
      | undefined
    if (!row) return null
    if (row.revoked_at) return null
    if (row.frozen_at) return null

    // Best-effort touch — failure here doesn't block auth.
    try {
      this.db
        .prepare(`UPDATE api_keys SET last_used_at = ? WHERE id = ?`)
        .run(new Date().toISOString(), row.id)
    } catch {
      /* ignore */
    }

    return {
      userAddress: row.user_address,
      scopes: row.scopes.split(',').filter(Boolean) as Scope[],
      chainKeyHash: chainKeyHash(plaintext),
    }
  }

  listForUser(userAddress: string): ApiKeyPublic[] {
    const rows = this.db
      .prepare(
        `SELECT id, user_address, scopes, name, prefix, created_at, last_used_at, frozen_at, revoked_at
         FROM api_keys WHERE user_address = ? ORDER BY created_at DESC`,
      )
      .all(userAddress.toLowerCase()) as Array<Omit<ApiKeyRow, 'key_hash'> & { prefix: string }>

    return rows.map(r => ({
      id: r.id,
      userAddress: r.user_address,
      scopes: r.scopes.split(',').filter(Boolean) as Scope[],
      name: r.name,
      prefix: r.prefix,
      createdAt: r.created_at,
      lastUsedAt: r.last_used_at,
      frozenAt: r.frozen_at,
      revokedAt: r.revoked_at,
    }))
  }

  /** Mark a key as revoked. Caller is responsible for verifying the key
   *  belongs to the requesting user. Returns true if the row was updated
   *  (i.e. the key existed and wasn't already revoked). */
  revoke(id: string, userAddress: string): boolean {
    const result = this.db
      .prepare(
        `UPDATE api_keys
         SET revoked_at = ?
         WHERE id = ? AND user_address = ? AND revoked_at IS NULL`,
      )
      .run(new Date().toISOString(), id, userAddress.toLowerCase())
    return result.changes > 0
  }

  close(): void {
    this.db.close()
  }
}
