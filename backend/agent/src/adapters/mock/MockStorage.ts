import { IStoragePort } from '../../../../../shared/ports';
import * as crypto from 'crypto';

export class MockStorage implements IStoragePort {
  private store = new Map<string, unknown>();

  constructor(private agentId: string) {}

  async append(data: unknown): Promise<string> {
    const hash = crypto.randomUUID();
    this.store.set(hash, data);
    return hash;
  }

  async fetch(hash: string): Promise<unknown> {
    const data = this.store.get(hash);
    if (data === undefined) {
      throw new Error('hash not found');
    }
    return data;
  }
}
