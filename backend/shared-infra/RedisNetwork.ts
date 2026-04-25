import { createClient, RedisClientType } from 'redis'
import { INetworkPort } from '../../shared/ports'
import { EventType, AXLEvent } from '../../shared/types'

const CHANNEL_PREFIX = 'swarm:'

export class RedisNetwork implements INetworkPort {
  private pub: RedisClientType
  private sub: RedisClientType
  private handlers = new Map<EventType, (event: AXLEvent<any>) => void>()

  constructor(private redisUrl = process.env.REDIS_URL ?? 'redis://localhost:6379') {
    this.pub = createClient({ url: this.redisUrl }) as RedisClientType
    this.sub = this.pub.duplicate() as RedisClientType
  }

  async connect(): Promise<void> {
    await this.pub.connect()
    await this.sub.connect()
    console.log('[RedisNetwork] connected:', this.redisUrl)
  }

  async emit<T>(event: AXLEvent<T>): Promise<void> {
    const channel = `${CHANNEL_PREFIX}${event.type}`
    await this.pub.publish(channel, JSON.stringify(event))
    console.log(`[RedisNetwork] → ${event.type}`, event.payload)
  }

  on<T>(type: EventType | '*', handler: (event: AXLEvent<T>) => void): void {
    if (type === '*') {
      this.sub.pSubscribe(`${CHANNEL_PREFIX}*`, (message, channel) => {
        try {
          const event = JSON.parse(message) as AXLEvent<T>
          handler(event)
        } catch (err) {
          console.error(`[RedisNetwork] parse error on wildcard:`, err)
        }
      })
    } else {
      const channel = `${CHANNEL_PREFIX}${type}`
      this.sub.subscribe(channel, (message) => {
        try {
          const event = JSON.parse(message) as AXLEvent<T>
          handler(event)
        } catch (err) {
          console.error(`[RedisNetwork] parse error on ${type}:`, err)
        }
      })
      this.handlers.set(type as EventType, handler as (event: AXLEvent<any>) => void)
    }
  }

  off(type: EventType): void {
    const channel = `${CHANNEL_PREFIX}${type}`
    this.sub.unsubscribe(channel)
    this.handlers.delete(type)
  }

  async disconnect(): Promise<void> {
    await this.pub.disconnect()
    await this.sub.disconnect()
  }

  async ping(): Promise<boolean> {
    try {
      await this.pub.ping()
      return true
    } catch {
      return false
    }
  }
}
