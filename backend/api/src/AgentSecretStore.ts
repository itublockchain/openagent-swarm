import * as fs from 'node:fs'
import * as path from 'node:path'
import * as crypto from 'node:crypto'

/**
 * AES-256-GCM encrypted file-based store for the per-agent private keys and
 * the bookkeeping needed to respawn a container after a `docker compose down`
 * (or any other event that removes the container without deleting the volume).
 *
 * On-chain `AgentRegistry` is the public source of truth for who exists and
 * what their status is. This store holds the secrets the API needs to bring
 * those agents back to life.
 *
 * File format: a single JSON object `{ [agentId]: SerializedSecret }` written
 * to `${AGENT_SECRETS_PATH}` (default `/data/agent-secrets.json`). Each value
 * is encrypted independently so leaking one record's IV doesn't compromise
 * the rest.
 */

const KEY_LENGTH = 32
const IV_LENGTH = 12
const TAG_LENGTH = 16

export interface AgentSecret {
  agentId: string
  privateKey: string
  containerId?: string
  name: string
  model: string
  stakeAmount: string
  systemPrompt?: string
  ownerAddress?: string
  agentAddress: string
  preparedAt: number
}

interface SerializedSecret {
  iv: string
  ct: string
}

export class AgentSecretStore {
  private filePath: string
  private key: Buffer
  private cache = new Map<string, AgentSecret>()
  private loaded = false

  constructor(opts?: { filePath?: string; masterKey?: string }) {
    this.filePath = opts?.filePath ?? process.env.AGENT_SECRETS_PATH ?? '/data/agent-secrets.json'
    const raw = opts?.masterKey ?? process.env.MASTER_KEY
    if (!raw) {
      throw new Error('[AgentSecretStore] MASTER_KEY env var is required')
    }
    // Accept either a 32-byte hex string (preferred) or any UTF-8 passphrase.
    // Passphrases are hashed to a 32-byte key via SHA-256 so callers don't
    // have to worry about exact length.
    if (/^[0-9a-fA-F]{64}$/.test(raw)) {
      this.key = Buffer.from(raw, 'hex')
    } else {
      this.key = crypto.createHash('sha256').update(raw, 'utf-8').digest()
    }
    if (this.key.length !== KEY_LENGTH) {
      throw new Error(`[AgentSecretStore] derived key has wrong length: ${this.key.length}`)
    }
  }

  private encrypt(plaintext: string): SerializedSecret {
    const iv = crypto.randomBytes(IV_LENGTH)
    const cipher = crypto.createCipheriv('aes-256-gcm', this.key, iv)
    const enc = Buffer.concat([cipher.update(plaintext, 'utf-8'), cipher.final()])
    const tag = cipher.getAuthTag()
    return {
      iv: iv.toString('base64'),
      ct: Buffer.concat([enc, tag]).toString('base64'),
    }
  }

  private decrypt(record: SerializedSecret): string {
    const iv = Buffer.from(record.iv, 'base64')
    const blob = Buffer.from(record.ct, 'base64')
    const ct = blob.subarray(0, blob.length - TAG_LENGTH)
    const tag = blob.subarray(blob.length - TAG_LENGTH)
    const decipher = crypto.createDecipheriv('aes-256-gcm', this.key, iv)
    decipher.setAuthTag(tag)
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf-8')
  }

  private ensureLoaded(): void {
    if (this.loaded) return
    if (!fs.existsSync(this.filePath)) {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true })
      this.loaded = true
      return
    }
    const raw = JSON.parse(fs.readFileSync(this.filePath, 'utf-8')) as Record<string, SerializedSecret>
    for (const [id, record] of Object.entries(raw)) {
      try {
        const secret = JSON.parse(this.decrypt(record)) as AgentSecret
        this.cache.set(id, secret)
      } catch (err) {
        // Bad records are loud — silent skip would mean a wrong MASTER_KEY
        // produces an empty pool with no warning, which is the worst failure
        // mode here.
        console.error(`[AgentSecretStore] Failed to decrypt ${id} — wrong MASTER_KEY?`, err)
        throw new Error(`AgentSecretStore decryption failed for ${id}`)
      }
    }
    this.loaded = true
  }

  private persist(): void {
    const out: Record<string, SerializedSecret> = {}
    for (const [id, secret] of this.cache.entries()) {
      out[id] = this.encrypt(JSON.stringify(secret))
    }
    const dir = path.dirname(this.filePath)
    try {
      fs.mkdirSync(dir, { recursive: true })
    } catch (err) {
      throw new Error(
        `[AgentSecretStore] cannot create ${dir} (${(err as Error).message}). ` +
        `On Dokploy/Coolify/Railway add a persistent volume mounted at ${dir}.`
      )
    }
    // Atomic replace: write to a sibling file then rename, so a crash mid-write
    // doesn't truncate the store.
    const tmp = this.filePath + '.tmp'
    try {
      fs.writeFileSync(tmp, JSON.stringify(out, null, 2), 'utf-8')
    } catch (err) {
      throw new Error(
        `[AgentSecretStore] cannot write ${tmp} (${(err as Error).message}). ` +
        `Check that ${dir} is a writable persistent volume — without it agent ` +
        `secrets will be lost on container restart.`
      )
    }
    fs.renameSync(tmp, this.filePath)
  }

  save(secret: AgentSecret): void {
    this.ensureLoaded()
    this.cache.set(secret.agentId, secret)
    this.persist()
  }

  update(agentId: string, patch: Partial<AgentSecret>): void {
    this.ensureLoaded()
    const cur = this.cache.get(agentId)
    if (!cur) throw new Error(`[AgentSecretStore] no such agent: ${agentId}`)
    this.cache.set(agentId, { ...cur, ...patch })
    this.persist()
  }

  get(agentId: string): AgentSecret | undefined {
    this.ensureLoaded()
    return this.cache.get(agentId)
  }

  delete(agentId: string): void {
    this.ensureLoaded()
    if (this.cache.delete(agentId)) {
      this.persist()
    }
  }

  list(): AgentSecret[] {
    this.ensureLoaded()
    return Array.from(this.cache.values())
  }
}
