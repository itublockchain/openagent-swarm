import { IStoragePort } from '../../../../../shared/ports'

export class MockStorage implements IStoragePort {
  private static storage = new Map<string, string>();

  constructor(private agentId: string) {
    console.log(`[MockStorage] Initialized for ${agentId}`)
  }

  async append(data: unknown): Promise<string> {
    const hash = `hash-${Math.random().toString(36).slice(2, 8)}`
    MockStorage.storage.set(hash, JSON.stringify(data))
    console.log(`[MockStorage] ${this.agentId} stored: ${hash}`)
    return hash
  }

  async fetch(hash: string): Promise<unknown> {
    const raw = MockStorage.storage.get(hash)
    if (!raw) throw new Error(`hash not found: ${hash}`)
    return JSON.parse(raw)
  }
}

