/**
 * Tiny JSON-file wallet store. Keyed by agentId so re-running the same
 * Spore swarm reuses each agent's auto-generated EOA — earnings from
 * prior runs stay reachable. Without persistence, every run mints fresh
 * wallets and any USDC paid out previously is stranded.
 *
 * Plain text on purpose: hackathon defaults. Production deployments
 * should encrypt with the operator's KMS or use a hardware wallet
 * mux instead.
 *
 * File shape (atomic write — temp + rename):
 *   {
 *     "lc-validator-1": { "address": "0x..", "privateKey": "0x.." },
 *     "lc-executor-1":  { "address": "0x..", "privateKey": "0x.." }
 *   }
 */

import * as fs from 'node:fs'
import * as path from 'node:path'

export interface WalletEntry {
  address: string
  privateKey: string
}

export class WalletStore {
  private readonly filePath: string
  private cache: Record<string, WalletEntry>

  constructor(filePath: string) {
    this.filePath = filePath
    this.cache = this.load()
  }

  private load(): Record<string, WalletEntry> {
    try {
      if (!fs.existsSync(this.filePath)) return {}
      return JSON.parse(fs.readFileSync(this.filePath, 'utf-8'))
    } catch (err) {
      // Corrupt file → loud, never silent. A confused dev with a wiped
      // cache loses funds; throwing forces them to look at the error.
      throw new Error(
        `[WalletStore] Failed to load ${this.filePath}: ${(err as Error).message}. ` +
          'Refusing to silently start fresh — you would lose access to ' +
          'agent wallets created in earlier runs.',
      )
    }
  }

  get(agentId: string): WalletEntry | undefined {
    return this.cache[agentId]
  }

  set(agentId: string, entry: WalletEntry): void {
    this.cache[agentId] = entry
    fs.mkdirSync(path.dirname(this.filePath) || '.', { recursive: true })
    // Atomic replace so a crash mid-write doesn't truncate the store.
    const tmp = this.filePath + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(this.cache, null, 2), 'utf-8')
    fs.renameSync(tmp, this.filePath)
  }

  /** Snapshot of every persisted entry. Useful for "show me the wallets". */
  all(): Record<string, WalletEntry> {
    return { ...this.cache }
  }
}
