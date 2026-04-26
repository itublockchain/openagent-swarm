import { EventEmitter } from 'events'
import { INetworkPort } from '../../../../shared/ports'
import { AXLEvent, EventType } from '../../../../shared/types'
import WebSocket from 'ws'

export class EventBus implements INetworkPort {
  private emitter = new EventEmitter()
  private ws: WebSocket | null = null

  constructor(private agentId: string) {
    const isApi = agentId === 'api-core' || agentId === 'api-server'

    if (!isApi) {
      const wsUrl = process.env.API_WS_URL ?? 'ws://api:3001/ws'
      this.ws = new WebSocket(wsUrl)

      this.ws.on('open', () => {
        console.log(`[EventBus] Agent ${agentId} connected to API WS`)
      })

      this.ws.on('message', (data) => {
        try {
          // her zaman parse et — string veya buffer olabilir
          const event = JSON.parse(data.toString()) as AXLEvent<any>

          // kendi emit ettiğimiz event'leri tekrar işleme
          if (event.agentId === this.agentId) return

          console.log(`[EventBus] ← ${event.type} (from network)`)

          // her zaman serialize edilmiş string olarak emit et
          const serialized = JSON.stringify(event)
          this.emitter.emit(event.type, serialized)
          this.emitter.emit('*', serialized)
        } catch (err) {
          console.error('[EventBus] message parse error:', err)
        }
      })

      this.ws.on('error', (err) => {
        console.error('[EventBus] WS error:', err.message)
      })

      this.ws.on('close', () => {
        console.log('[EventBus] WS disconnected, reconnecting in 3s...')
        setTimeout(() => {
          // process'i canlı tut
        }, 3000)
      })
    }
  }

  async emit<T>(event: AXLEvent<T>): Promise<void> {
    // her zaman serialize et
    const serialized = JSON.stringify(event)
    console.log(`[AXL] → ${event.type}`, event.payload)

    // local listener'ları tetikle
    this.emitter.emit(event.type, serialized)
    this.emitter.emit('*', serialized)

    // WS üzerinden broadcast et
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(serialized)
    }
  }

  on<T>(type: EventType | '*', handler: (event: AXLEvent<T>) => void): void {
    this.emitter.on(type, (serialized: string) => {
      try {
        // her zaman string olarak geldiğini garanti ediyoruz
        const event = typeof serialized === 'string'
          ? JSON.parse(serialized) as AXLEvent<T>
          : serialized as AXLEvent<T>
        handler(event)
      } catch (err) {
        console.error(`[EventBus] handler error on ${type}:`, err)
      }
    })
  }

  async waitForConnection(): Promise<void> {
    if (!this.ws) return

    if (this.ws.readyState === WebSocket.OPEN) {
      console.log(`[EventBus] already connected`)
      return
    }

    if (this.ws.readyState === WebSocket.CONNECTING) {
      return new Promise((resolve, reject) => {
        this.ws!.once('open', () => {
          console.log(`[EventBus] connected`)
          resolve()
        })
        this.ws!.once('error', reject)
        setTimeout(() => reject(new Error('WS connection timeout')), 30_000)
      })
    }

    throw new Error('WS closed, retrying...')
  }

  off(type: EventType): void {
    this.emitter.removeAllListeners(type)
  }
}
