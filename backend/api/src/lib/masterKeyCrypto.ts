import * as crypto from 'node:crypto'

/**
 * AES-256-GCM helpers keyed off the same `MASTER_KEY` env var that
 * `AgentSecretStore` uses. Lets the sporeise SQLite store keep
 * per-agent private keys encrypted at rest without a second key.
 *
 * Format (base64): `iv.ct||tag` where `iv` and `ct||tag` are stored
 * separately in the calling table. Encryption is per-record (fresh IV
 * each call) so leaking one row's IV doesn't degrade the rest.
 */

const KEY_LENGTH = 32
const IV_LENGTH = 12
const TAG_LENGTH = 16

let cachedKey: Buffer | null = null

function loadKey(): Buffer {
  if (cachedKey) return cachedKey
  const raw = process.env.MASTER_KEY
  if (!raw) throw new Error('[masterKeyCrypto] MASTER_KEY env var is required')
  let key: Buffer
  if (/^[0-9a-fA-F]{64}$/.test(raw)) {
    key = Buffer.from(raw, 'hex')
  } else {
    key = crypto.createHash('sha256').update(raw, 'utf-8').digest()
  }
  if (key.length !== KEY_LENGTH) {
    throw new Error(`[masterKeyCrypto] derived key has wrong length: ${key.length}`)
  }
  cachedKey = key
  return key
}

export interface SealedSecret {
  iv: string  // base64
  ct: string  // base64 — ciphertext || tag
}

export function seal(plaintext: string): SealedSecret {
  const key = loadKey()
  const iv = crypto.randomBytes(IV_LENGTH)
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
  const enc = Buffer.concat([cipher.update(plaintext, 'utf-8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return {
    iv: iv.toString('base64'),
    ct: Buffer.concat([enc, tag]).toString('base64'),
  }
}

export function open(sealed: SealedSecret): string {
  const key = loadKey()
  const iv = Buffer.from(sealed.iv, 'base64')
  const blob = Buffer.from(sealed.ct, 'base64')
  const ct = blob.subarray(0, blob.length - TAG_LENGTH)
  const tag = blob.subarray(blob.length - TAG_LENGTH)
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf-8')
}

/** Convenience: pack a SealedSecret into a single string for single-
 *  column storage. Format: `<iv>.<ct>` — both base64, dot separator
 *  is unambiguous because base64 alphabet excludes `.`. */
export function sealToString(plaintext: string): string {
  const s = seal(plaintext)
  return `${s.iv}.${s.ct}`
}

export function openFromString(packed: string): string {
  const [iv, ct] = packed.split('.')
  if (!iv || !ct) throw new Error('[masterKeyCrypto] bad sealed string format')
  return open({ iv, ct })
}
