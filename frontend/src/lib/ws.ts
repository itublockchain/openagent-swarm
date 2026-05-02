export type WSEvent = {
  type: string
  payload: Record<string, unknown>
  timestamp: number
  agentId: string
}

type Handler = (event: WSEvent) => void

class SporeWSClient {
  private ws: WebSocket | null = null
  private handlers = new Map<string, Set<Handler>>()
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private url: string | null = null
  private token: string | null = null
  // Tracked here (not in the hook) so reconnects re-issue the same
  // subscriptions without the caller having to remember them.
  private subscriptions = new Set<string>()
  // Outbound messages queued while the socket is mid-handshake. Drained
  // on `onopen`. Without this, a fast caller (`subscribe()` immediately
  // after `connect()`) loses the message because `readyState` is still
  // CONNECTING and `socket.send()` throws.
  private pendingOutbound: string[] = []

  /**
   * Connect (or reconnect with new auth) to the backend WS bridge. The
   * token is appended as `?token=` because the browser WebSocket API
   * doesn't accept custom headers. If an existing socket is open with
   * the same auth, this is a no-op; if the token changed, the old
   * socket is closed first so the next session adopts the new identity.
   */
  connect(url: string, opts?: { token?: string | null }) {
    const nextToken = opts?.token ?? null
    if (
      this.ws &&
      this.ws.readyState === WebSocket.OPEN &&
      this.url === url &&
      this.token === nextToken
    ) {
      return
    }
    if (this.ws && this.token !== nextToken) {
      // Force a reconnect under the new identity. onclose's reconnect
      // loop is suppressed by clearing `url` first; we then set it back.
      const prevUrl = this.url
      this.url = null
      try { this.ws.close() } catch { /* ignore */ }
      this.url = prevUrl
    }
    this.url = url
    this.token = nextToken

    const fullUrl = nextToken
      ? `${url}${url.includes('?') ? '&' : '?'}token=${encodeURIComponent(nextToken)}`
      : url

    this.ws = new WebSocket(fullUrl)

    this.ws.onopen = () => {
      console.log('[SporeWS] connected to', url, this.token ? '(authenticated)' : '(anonymous)')
      // Re-issue every subscription the caller asked for so a reconnect
      // is transparent to the consumer.
      for (const taskId of this.subscriptions) {
        this.rawSend(JSON.stringify({ type: 'subscribe', taskId }))
      }
      // Drain anything queued while we were CONNECTING.
      while (this.pendingOutbound.length > 0) {
        this.rawSend(this.pendingOutbound.shift()!)
      }
    }

    this.ws.onmessage = (msg) => {
      try {
        const event = JSON.parse(msg.data) as WSEvent
        this.handlers.get(event.type)?.forEach(h => h(event))
        this.handlers.get('*')?.forEach(h => h(event))
      } catch (e) {
        console.error('[SporeWS] parse error', e)
      }
    }

    this.ws.onclose = () => {
      // `url` cleared = caller asked us to disconnect or reconnect under
      // new auth — don't loop here.
      if (!this.url) return
      console.log('[SporeWS] closed, retrying in 3s...')
      this.reconnectTimer = setTimeout(() => {
        if (this.url) this.connect(this.url, { token: this.token })
      }, 3000)
    }

    this.ws.onerror = (e) => {
      console.error('[SporeWS] error', e)
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

  /** Watch a taskId we don't own (deep link, anonymous browse). The
   *  backend sends events for owned tasks automatically; subscribe is
   *  only needed for tasks belonging to other addresses. Tracked locally
   *  so reconnects replay it. */
  subscribe(taskId: string) {
    if (!taskId) return
    this.subscriptions.add(taskId)
    this.send({ type: 'subscribe', taskId })
  }

  unsubscribe(taskId: string) {
    if (!taskId) return
    this.subscriptions.delete(taskId)
    this.send({ type: 'unsubscribe', taskId })
  }

  /** Generic outbound — used by subscribe/unsubscribe today, exposed for
   *  any future client-to-server frames the WS bridge accepts. */
  private send(message: unknown) {
    const payload = JSON.stringify(message)
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.rawSend(payload)
    } else {
      this.pendingOutbound.push(payload)
    }
  }

  private rawSend(payload: string) {
    try {
      this.ws?.send(payload)
    } catch (err) {
      console.error('[SporeWS] send error', err)
    }
  }

  disconnect() {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.url = null
    this.token = null
    this.subscriptions.clear()
    this.pendingOutbound = []
    this.ws?.close()
    this.ws = null
  }
}

export const wsClient = new SporeWSClient()
