export type WSEvent = {
  type: string
  payload: Record<string, unknown>
  timestamp: number
  agentId: string
}

type Handler = (event: WSEvent) => void

class SwarmWSClient {
  private ws: WebSocket | null = null
  private handlers = new Map<string, Set<Handler>>()
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private url: string | null = null

  connect(url: string) {
    this.url = url
    if (this.ws?.readyState === WebSocket.OPEN) return

    this.ws = new WebSocket(url)

    this.ws.onopen = () => {
      console.log('[SwarmWS] connected to', url)
    }

    this.ws.onmessage = (msg) => {
      try {
        const event = JSON.parse(msg.data) as WSEvent
        console.log('[SwarmWS] received:', event.type)
        this.handlers.get(event.type)?.forEach(h => h(event))
        this.handlers.get('*')?.forEach(h => h(event))
      } catch (e) {
        console.error('[SwarmWS] parse error', e)
      }
    }

    this.ws.onclose = () => {
      console.log('[SwarmWS] closed, retrying in 3s...')
      this.reconnectTimer = setTimeout(() => {
        if (this.url) this.connect(this.url)
      }, 3000)
    }

    this.ws.onerror = (e) => {
      console.error('[SwarmWS] error', e)
      this.ws?.close()
    }
  }

  on(type: string, handler: Handler) {
    if (!this.handlers.has(type)) this.handlers.set(type, new Set())
    this.handlers.get(type)!.add(handler)
  }

  off(type: string, handler: Handler) {
    this.handlers.get(type)?.delete(handler)
  }

  disconnect() {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.ws?.close()
    this.ws = null
  }
}

export const wsClient = new SwarmWSClient()
