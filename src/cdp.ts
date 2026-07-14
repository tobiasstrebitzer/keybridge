// Minimal CDP-over-WebSocket client — just enough to drive the off-screen
// ceremony Chrome (no puppeteer; Node >= 22 ships a global WebSocket).
//
// Protocol: JSON messages over one browser-endpoint socket. Requests carry an
// incrementing `id` (+ optional `sessionId` for page-session commands added by
// Target.attachToTarget flatten mode); responses echo the id with `result` or
// `error`; everything else is an event.

export interface CdpEvent {
  method: string
  params: Record<string, unknown>
  sessionId?: string
}

export class CdpError extends Error {
  method: string
  code: number | undefined

  constructor (method: string, message: string, code?: number) {
    super(`${method}: ${message}`)
    this.name = 'CdpError'
    this.method = method
    this.code = code
  }
}

interface Pending {
  resolve: (value: Record<string, unknown>) => void
  reject: (reason: Error) => void
  method: string
}

export class CdpClient {
  url: string
  ws: WebSocket
  nextId: number
  pending: Map<number, Pending>
  listeners: Set<(event: CdpEvent) => void>

  constructor (ws: WebSocket, url: string) {
    this.url = url
    this.ws = ws
    this.nextId = 1
    this.pending = new Map()
    this.listeners = new Set()

    ws.addEventListener('message', (e: MessageEvent) => {
      let msg: { id?: number, result?: Record<string, unknown>, error?: { message: string, code?: number }, method?: string, params?: Record<string, unknown>, sessionId?: string }
      try { msg = JSON.parse(String(e.data)) } catch { return }
      if (msg.id !== undefined) {
        const p = this.pending.get(msg.id)
        if (!p) return
        this.pending.delete(msg.id)
        if (msg.error) p.reject(new CdpError(p.method, msg.error.message, msg.error.code))
        else p.resolve(msg.result ?? {})
        return
      }
      if (msg.method) {
        const event: CdpEvent = { method: msg.method, params: msg.params ?? {}, sessionId: msg.sessionId }
        for (const listener of this.listeners) listener(event)
      }
    })
    ws.addEventListener('close', () => this.failAllPending(new Error('CDP connection closed')))
    ws.addEventListener('error', () => this.failAllPending(new Error('CDP connection error')))
  }

  static connect (url: string, { timeoutMs = 10_000 }: { timeoutMs?: number } = {}): Promise<CdpClient> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url)
      const timer = setTimeout(() => {
        ws.close()
        reject(new Error(`timed out connecting to CDP at ${url}`))
      }, timeoutMs)
      ws.addEventListener('open', () => {
        clearTimeout(timer)
        resolve(new CdpClient(ws, url))
      }, { once: true })
      ws.addEventListener('error', () => {
        clearTimeout(timer)
        reject(new Error(`could not connect to CDP at ${url}`))
      }, { once: true })
    })
  }

  get connected (): boolean {
    return this.ws.readyState === WebSocket.OPEN
  }

  send<T extends Record<string, unknown> = Record<string, unknown>> (
    method: string,
    params: Record<string, unknown> = {},
    sessionId?: string,
  ): Promise<T> {
    if (!this.connected) return Promise.reject(new Error(`CDP connection is closed (sending ${method})`))
    const id = this.nextId++
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as Pending['resolve'], reject, method })
      this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }))
    })
  }

  /** Subscribe to CDP events (all sessions). Returns an unsubscribe function. */
  on (listener: (event: CdpEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  close (): void {
    try { this.ws.close() } catch {}
    this.failAllPending(new Error('CDP connection closed'))
  }

  failAllPending (error: Error): void {
    for (const p of this.pending.values()) p.reject(error)
    this.pending.clear()
  }
}
