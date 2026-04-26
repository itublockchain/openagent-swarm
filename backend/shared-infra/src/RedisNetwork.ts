import Redis from 'ioredis';
import { INetworkPort } from '@swarm/shared';
import { AXLEvent, EventType } from '@swarm/shared';

export class RedisNetwork implements INetworkPort {
  private pub: Redis;
  private sub: Redis;
  private handlers = new Map<string, Set<(event: AXLEvent<any>) => void | Promise<void>>>();
  private isMessageListenerAttached = false;

  constructor(redisUrl: string = process.env.REDIS_URL || 'redis://redis:6379') {
    this.pub = new Redis(redisUrl);
    this.sub = new Redis(redisUrl);
  }

  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      let readyCount = 0;
      const check = () => {
        readyCount++;
        if (readyCount >= 2) {
          console.log(`[RedisNetwork] connected to ${this.pub.options.host}:${this.pub.options.port}`);
          this.attachMessageListener();
          resolve();
        }
      };

      if (this.pub.status === 'ready' && this.sub.status === 'ready') {
        this.attachMessageListener();
        return resolve();
      }

      this.pub.once('ready', check);
      this.sub.once('ready', check);
      this.pub.on('error', (err) => console.error('[RedisNetwork] Pub Error:', err));
      this.sub.on('error', (err) => console.error('[RedisNetwork] Sub Error:', err));
    });
  }

  private attachMessageListener() {
    if (this.isMessageListenerAttached) return;
    this.isMessageListenerAttached = true;

    this.sub.on('message', async (channel, message) => {
      const handlers = this.handlers.get(channel);
      if (!handlers) return;

      try {
        const event = JSON.parse(message);
        console.log(`[RedisNetwork] Incoming on ${channel}: ${event.type}`);
        for (const handler of handlers) {
          try {
            const result = handler(event);
            if (result instanceof Promise) await result;
          } catch (handlerErr) {
            console.error(`[RedisNetwork] Handler error on ${channel}:`, handlerErr);
          }
        }
      } catch (err) {
        console.error(`[RedisNetwork] Parse error on ${channel}:`, err);
      }
    });
  }

  async emit<T>(event: AXLEvent<T>): Promise<void> {
    const serialized = JSON.stringify(event);
    await this.pub.publish('axl-events', serialized);
    await this.pub.publish(`axl-events:${event.type}`, serialized);
  }

  on<T>(type: EventType | '*', handler: (event: AXLEvent<T>) => void | Promise<void>): void {
    const channel = type === '*' ? 'axl-events' : `axl-events:${type}`;
    
    if (!this.handlers.has(channel)) {
      this.handlers.set(channel, new Set());
      console.log(`[RedisNetwork] Subscribing to ${channel}`);
      this.sub.subscribe(channel).catch(err => {
        console.error(`[RedisNetwork] Subscribe error on ${channel}:`, err);
      });
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
      console.log(`[RedisNetwork] Unsubscribing from ${channel}`);
      this.sub.unsubscribe(channel).catch(err => {
        console.error(`[RedisNetwork] Unsubscribe error on ${channel}:`, err);
      });
      this.handlers.delete(channel);
    }
  }
}
