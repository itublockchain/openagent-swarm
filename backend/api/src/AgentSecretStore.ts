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
    // Boot-time probe: fail loud here if the persistence dir isn't
    // actually writable, instead of waiting for the first agent deploy
    // to crash mid-flow with a confused user. start.sh runs a similar
    // shell-level check, but some PaaS deployments (Dokploy, Coolify)
    // override the entrypoint and skip it — so we re-validate inside
    // the Node process where it can't be bypassed.
    this.probeWritable()
  }

  /**
   * Touch a file inside the persistence directory and delete it.
   * Throws with rich diagnostics (dir state, perms, process uid) when
   * the volume isn't attached or isn't writable, so the operator sees
   * exactly what to fix in their PaaS volume config.
   */
  private probeWritable(): void {
    const dir = path.dirname(this.filePath)
    try {
      fs.mkdirSync(dir, { recursive: true })
    } catch (err) {
      throw new Error(this.diagnosticMessage(dir, `mkdir ${dir} failed: ${(err as Error).message}`))
    }
    const probe = path.join(dir, `.write-probe-${process.pid}-${Date.now()}`)
    try {
      fs.writeFileSync(probe, 'ok', 'utf-8')
      fs.unlinkSync(probe)
    } catch (err) {
      throw new Error(
        this.diagnosticMessage(dir, `probe write to ${probe} failed: ${(err as Error).message}`),
      )
    }
  }

  /**
   * Build a hint with the directory's actual state so the operator can
   * tell at a glance whether the bind mount attached, who owns the dir,
   * and which user the API is running as.
   */
  private diagnosticMessage(dir: string, cause: string): string {
    let stateLine = ''
    try {
      const st = fs.statSync(dir)
      stateLine = `dir exists=${true}, mode=${(st.mode & 0o777).toString(8)}, uid=${st.uid}, gid=${st.gid}`
    } catch {
      stateLine = `dir exists=false`
    }
    const procUid =
      typeof process.getuid === 'function' ? String(process.getuid()) : 'n/a'
    const procGid =
      typeof process.getgid === 'function' ? String(process.getgid()) : 'n/a'
    return (
      `[AgentSecretStore] ${cause}. ` +
      `${stateLine}; process uid=${procUid}, gid=${procGid}. ` +
      `Mount a writable persistent volume at ${dir} — without it agent secrets ` +
      `are lost on container restart. ` +
      `Dokploy: Service → Advanced → Volumes/Mounts → Bind Mount, ` +
      `Host '../files/data', Container '${dir}'. ` +
      `Compose: ensure './data:${dir}' bind mount and that ./data exists on the host.`
    )
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
      throw new Error(this.diagnosticMessage(dir, `cannot create ${dir} (${(err as Error).message})`))
    }
    // Atomic replace: write to a sibling file then rename, so a crash mid-write
    // doesn't truncate the store.
    const tmp = this.filePath + '.tmp'
    try {
      fs.writeFileSync(tmp, JSON.stringify(out, null, 2), 'utf-8')
    } catch (err) {
      throw new Error(this.diagnosticMessage(dir, `cannot write ${tmp} (${(err as Error).message})`))
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
