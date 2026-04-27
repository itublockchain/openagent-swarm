import { IStoragePort } from '../../../../shared/ports'

export class FallbackStorage implements IStoragePort {
  private primaryDisabled = false

  constructor(
    private primary: IStoragePort,
    private fallback: IStoragePort,
    private label: string = 'FallbackStorage',
  ) {}

  async append(data: unknown): Promise<string> {
    if (!this.primaryDisabled) {
      try {
        return await this.primary.append(data)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        console.warn(`[${this.label}] primary append failed; switching to fallback for the rest of this session: ${msg}`)
        this.primaryDisabled = true
      }
    }
    return this.fallback.append(data)
  }

  async fetch(hash: string): Promise<unknown> {
    if (!this.primaryDisabled) {
      try {
        return await this.primary.fetch(hash)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        console.warn(`[${this.label}] primary fetch failed for ${hash}, trying fallback: ${msg}`)
      }
    }
    return this.fallback.fetch(hash)
  }
}
