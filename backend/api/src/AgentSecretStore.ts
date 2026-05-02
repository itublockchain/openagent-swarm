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
    // Probe with the SAME naming pattern as the real persist target
    // (a non-dotfile sibling of the real file), not a `.write-probe`
    // dotfile. Some quirky overlay/FUSE filesystems handle dotfiles
    // and regular files differently; matching the real pattern
    // ensures a passing probe means the real write will pass too.
    const probe = `${this.filePath}.probe-${process.pid}-${Date.now()}`
    try {
      this.writeWithRetry(probe, 'ok', dir)
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

  /**
   * Write `payload` to `target`, retrying briefly on transient ENOENT.
   *
   * Docker Desktop on macOS (and some other FUSE/virtio-fs setups) flap
   * bind-mount state between syscalls — `stat()` reports the directory
   * exists, the very next `open(O_CREAT)` returns ENOENT, then a
   * millisecond later it works fine. The boot-time probe + diagnostic
   * message confirmed the dir is real and writable as root, so retry is
   * the right tool here. We re-issue mkdir between attempts in case the
   * mount snapshot truly lost the dir entry.
   */
  private writeWithRetry(target: string, payload: string, dir: string): void {
    const maxAttempts = 5
    let lastErr: NodeJS.ErrnoException | null = null
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        fs.mkdirSync(dir, { recursive: true })
        // openSync+writeSync+fsyncSync+closeSync gives us a tighter
        // syscall sequence than writeFileSync (which closes before
        // we can fsync), and an explicit fd makes the failure mode
        // unambiguous when something deeper is wrong.
        const fd = fs.openSync(target, 'w')
        try {
          fs.writeSync(fd, payload, 0, 'utf-8')
          fs.fsyncSync(fd)
        } finally {
          fs.closeSync(fd)
        }
        return
      } catch (err) {
        lastErr = err as NodeJS.ErrnoException
        if (lastErr.code !== 'ENOENT' || attempt === maxAttempts) {
          throw lastErr
        }
        // Sync sleep with exp backoff (1, 2, 4, 8 ms). Persist() is sync
        // because every caller (save/update/delete) is sync — switching
        // to async here would propagate to AgentRunner and the route
        // handlers. The total worst-case wait is 15ms, which is cheaper
        // than even a single network round-trip the caller is about to
        // make anyway.
        const ms = 1 << (attempt - 1)
        const until = Date.now() + ms
        while (Date.now() < until) { /* spin */ }
      }
    }
    // Unreachable — loop either returns or throws.
    throw lastErr ?? new Error('writeWithRetry exhausted')
  }

  private persist(): void {
    const out: Record<string, SerializedSecret> = {}
    for (const [id, secret] of this.cache.entries()) {
      out[id] = this.encrypt(JSON.stringify(secret))
    }
    const dir = path.dirname(this.filePath)
    const payload = JSON.stringify(out, null, 2)

    // Atomic replace: write to a sibling file then rename, so a crash
    // mid-write doesn't truncate the store.
    const tmp = this.filePath + '.tmp'
    try {
      this.writeWithRetry(tmp, payload, dir)
      fs.renameSync(tmp, this.filePath)
      return
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      // If the .tmp+rename path keeps tripping ENOENT (Docker Desktop
      // bind-mount issue that won't clear in <15ms), fall back to a
      // direct write to the destination. We lose strict atomicity —
      // a crash mid-write here truncates the file — but the
      // alternative is the user's deploy hard-failing and the new
      // agent's private key being lost forever. Logged loud so an
      // operator sees the degradation.
      if (code !== 'ENOENT') {
        throw new Error(this.diagnosticMessage(dir, `cannot write ${tmp} (${(err as Error).message})`))
      }
      console.warn(
        `[AgentSecretStore] tmp-write to ${tmp} kept hitting ENOENT after retries; ` +
        `falling back to direct write of ${this.filePath} (atomicity degraded). ` +
        `This usually indicates a Docker Desktop / FUSE bind-mount flap on the host volume.`,
      )
      try {
        this.writeWithRetry(this.filePath, payload, dir)
      } catch (err2) {
        throw new Error(this.diagnosticMessage(dir, `direct write to ${this.filePath} also failed (${(err2 as Error).message})`))
      }
    }
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
