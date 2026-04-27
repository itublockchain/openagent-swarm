import { IStoragePort } from '../../../../../shared/ports'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import * as crypto from 'node:crypto'

const STORAGE_DIR = process.env.MOCK_STORAGE_DIR ?? path.join(os.tmpdir(), 'swarm-mock-storage')

export class MockStorage implements IStoragePort {
  constructor(private agentId: string) {
    fs.mkdirSync(STORAGE_DIR, { recursive: true })
    console.log(`[MockStorage] Initialized for ${agentId} at ${STORAGE_DIR}`)
  }

  private pathFor(hash: string): string {
    return path.join(STORAGE_DIR, `${hash}.json`)
  }

  async append(data: unknown): Promise<string> {
    const serialized = JSON.stringify(data)
    const hash = 'mock-' + crypto.createHash('sha256').update(serialized).digest('hex').slice(0, 16)
    fs.writeFileSync(this.pathFor(hash), serialized, 'utf-8')
    console.log(`[MockStorage] ${this.agentId} stored: ${hash}`)
    return hash
  }

  async fetch(hash: string): Promise<unknown> {
    const file = this.pathFor(hash)
    if (!fs.existsSync(file)) throw new Error(`hash not found: ${hash}`)
    return JSON.parse(fs.readFileSync(file, 'utf-8'))
  }
}
