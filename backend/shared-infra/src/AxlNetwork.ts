import { INetworkPort } from '@swarm/shared';
import { AXLEvent, EventType } from '@swarm/shared';

export class AxlNetwork implements INetworkPort {
  private handlers = new Map<string, Set<(event: AXLEvent<any>) => void | Promise<void>>>();
  private isPolling = false;
  private readonly baseUrl: string;

  constructor(axlUrl: string = process.env.AXL_URL || 'http://127.0.0.1:9002') {
    this.baseUrl = axlUrl;
  }

  async connect(): Promise<void> {
    try {
      // Check if AXL node is responsive
      const res = await fetch(`${this.baseUrl}/topology`);
      if (!res.ok) {
        throw new Error(`Failed to connect to AXL node. Status: ${res.status}`);
      }
      console.log(`[AxlNetwork] connected to AXL node at ${this.baseUrl}`);
      
      this.isPolling = true;
      this.pollMessages();
    } catch (err) {
      console.error('[AxlNetwork] connection failed:', err);
      throw err;
    }
  }

  private async pollMessages() {
    while (this.isPolling) {
      try {
        const res = await fetch(`${this.baseUrl}/recv`);
        if (res.status === 204) {
          // Queue is empty, wait a bit before next poll
          await new Promise(resolve => setTimeout(resolve, 100));
          continue;
        }

        if (res.status === 200) {
          const body = await res.text();
          try {
            const parsed = JSON.parse(body);
            const channel = `axl-events:${parsed.type}`;
            const globalChannel = 'axl-events';

            // Trigger specific handlers
            if (this.handlers.has(channel)) {
              for (const handler of this.handlers.get(channel)!) {
                await handler(parsed);
              }
            }

            // Trigger global handlers
            if (this.handlers.has(globalChannel)) {
              for (const handler of this.handlers.get(globalChannel)!) {
                await handler(parsed);
              }
            }
          } catch (parseErr) {
            console.error(`[AxlNetwork] Failed to parse message:`, parseErr);
          }
        }
      } catch (err) {
        console.error(`[AxlNetwork] Polling error:`, err);
        await new Promise(resolve => setTimeout(resolve, 2000)); // wait longer on error
      }
    }
  }

  async emit<T>(event: AXLEvent<T>): Promise<void> {
    try {
      // Get topology to broadcast
      const res = await fetch(`${this.baseUrl}/topology`);
      if (!res.ok) return;

      const topology = await res.json();
      const peers: any[] = topology.peers || [];
      const payload = JSON.stringify(event);

      // Fire-and-forget message to all peers
      await Promise.all(peers.map(async (peer) => {
        const peerId = peer.public_key;
        if (!peerId) return;
        try {
          await fetch(`${this.baseUrl}/send`, {
            method: 'POST',
            headers: {
              'X-Destination-Peer-Id': peerId,
              'Content-Type': 'application/json'
            },
            body: payload
          });
        } catch (sendErr) {
          console.error(`[AxlNetwork] Failed to send to peer ${peerId}:`, sendErr);
        }
      }));
    } catch (err) {
      console.error(`[AxlNetwork] Broadcast error:`, err);
    }
  }

  on<T>(type: EventType | '*', handler: (event: AXLEvent<T>) => void | Promise<void>): void {
    const channel = type === '*' ? 'axl-events' : `axl-events:${type}`;
    if (!this.handlers.has(channel)) {
      this.handlers.set(channel, new Set());
    }
    this.handlers.get(channel)!.add(handler as any);
  }

  off<T>(type: EventType | '*', handler?: (event: AXLEvent<T>) => void | Promise<void>): void {
    const channel = type === '*' ? 'axl-events' : `axl-events:${type}`;
    const handlers = this.handlers.get(channel);
    if (!handlers) return;

    if (handler) {
      handlers.delete(handler as any);
    } else {
      handlers.clear();
    }

    if (handlers.size === 0) {
      this.handlers.delete(channel);
    }
  }

  async disconnect(): Promise<void> {
    this.isPolling = false;
  }
}
