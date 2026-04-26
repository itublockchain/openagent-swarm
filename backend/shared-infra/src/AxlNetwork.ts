import { INetworkPort } from '@swarm/shared';
import { AXLEvent, EventType } from '@swarm/shared';

export class AxlNetwork implements INetworkPort {
  private handlers = new Map<string, Set<(event: AXLEvent<any>) => void | Promise<void>>>();
  private isPolling = false;
  private readonly baseUrl: string;
  private knownNodes = new Set<string>(); // Keep track of nodes that talked to us

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

  private seenEvents = new Set<string>(); // Prevent gossip loops

  private async pollMessages() {
    while (this.isPolling) {
      try {
        const res = await fetch(`${this.baseUrl}/recv`);
        if (res.status === 204) {
          await new Promise(resolve => setTimeout(resolve, 100));
          continue;
        }

        if (res.status === 200) {
          const body = await res.text();
          const fromPeer = res.headers.get('X-From-Peer-Id');
          
          try {
            const parsed = JSON.parse(body) as AXLEvent<any>;
            const now = Date.now();
            
            // Ignore stale messages (older than 60s)
            if (now - parsed.timestamp > 60000) {
              // console.log(`[AxlNetwork] Ignoring stale event: ${parsed.type}`);
              continue;
            }

            const eventId = `${parsed.type}:${parsed.agentId}:${parsed.timestamp}`;
            
            if (this.seenEvents.has(eventId)) continue;
            this.seenEvents.add(eventId);
            if (this.seenEvents.size > 1000) this.seenEvents.clear(); // Basic cache management

            console.log(`[AxlNetwork] Received NEW event: ${parsed.type} from ${parsed.agentId}`);
            
            // Remember the sender
            if (parsed.senderPubKey) this.knownNodes.add(parsed.senderPubKey);
            if (fromPeer) this.knownNodes.add(fromPeer);

            // GOSSIP RELAY: Re-broadcast to our known nodes to ensure everyone gets it
            this.emit(parsed).catch(() => {});

            const channel = `axl-events:${parsed.type}`;
            const globalChannel = 'axl-events';

            if (this.handlers.has(channel)) {
              for (const handler of this.handlers.get(channel)!) {
                await handler(parsed);
              }
            }

            if (this.handlers.has(globalChannel)) {
              for (const handler of this.handlers.get(globalChannel)!) {
                await handler(parsed);
              }
            }
          } catch (parseErr) {
            console.error(`[AxlNetwork] Failed to parse message body:`, parseErr);
          }
        }
      } catch (err) {
        console.error(`[AxlNetwork] Polling error:`, err);
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
    }
  }

  async emit<T>(event: AXLEvent<T>): Promise<void> {
    try {
      const res = await fetch(`${this.baseUrl}/topology`);
      if (!res.ok) return;

      const topology = await res.json();
      const nodes: any[] = topology.tree || []; 
      const ourKey = topology.our_public_key;

      // Attach our public key so others can reply to us directly
      event.senderPubKey = ourKey;
      const payload = JSON.stringify(event);

      // Fire-and-forget message to all nodes in the mesh + known nodes
      const allTargetNodes = new Set<string>();
      nodes.forEach(n => allTargetNodes.add(n.public_key));
      this.knownNodes.forEach(n => allTargetNodes.add(n));

      console.log(`[AxlNetwork] Broadcasting ${event.type} to ${allTargetNodes.size - 1} target nodes...`);
      
      await Promise.all(Array.from(allTargetNodes).map(async (peerId) => {
        if (!peerId || peerId === ourKey) return;
        try {
          console.log(`[AxlNetwork] Sending to ${peerId.slice(0, 8)}...`);
          await fetch(`${this.baseUrl}/send`, {
            method: 'POST',
            headers: {
              'X-Destination-Peer-Id': peerId,
              'Content-Type': 'application/json'
            },
            body: payload
          });
        } catch (sendErr) {
          console.error(`[AxlNetwork] Failed to send to node ${peerId}:`, sendErr);
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
