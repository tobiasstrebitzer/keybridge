// A fake CDP endpoint for tests: a from-scratch WebSocket server (node:http
// upgrade + RFC 6455 framing — Node has no built-in WS *server*) that answers
// CDP commands from a scripted handler and records everything it saw. Doubles
// as a check that our CdpClient speaks wire-correct WebSocket.
import { createServer, type Server } from 'node:http'
import { createHash } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import type { Duplex } from 'node:stream'

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

function encodeTextFrame (payload: Buffer): Buffer {
  const len = payload.length
  let header: Buffer
  if (len < 126) {
    header = Buffer.from([0x81, len])
  } else if (len < 65_536) {
    header = Buffer.alloc(4)
    header[0] = 0x81
    header[1] = 126
    header.writeUInt16BE(len, 2)
  } else {
    header = Buffer.alloc(10)
    header[0] = 0x81
    header[1] = 127
    header.writeBigUInt64BE(BigInt(len), 2)
  }
  return Buffer.concat([header, payload])
}

interface ParsedFrame { opcode: number, payload: Buffer, consumed: number }

function decodeFrame (buf: Buffer): ParsedFrame | null {
  if (buf.length < 2) return null
  const opcode = buf[0]! & 0x0f
  const masked = (buf[1]! & 0x80) !== 0
  let len = buf[1]! & 0x7f
  let offset = 2
  if (len === 126) {
    if (buf.length < 4) return null
    len = buf.readUInt16BE(2)
    offset = 4
  } else if (len === 127) {
    if (buf.length < 10) return null
    len = Number(buf.readBigUInt64BE(2))
    offset = 10
  }
  const maskLen = masked ? 4 : 0
  if (buf.length < offset + maskLen + len) return null
  let payload = buf.subarray(offset + maskLen, offset + maskLen + len)
  if (masked) {
    const mask = buf.subarray(offset, offset + 4)
    const unmasked = Buffer.alloc(len)
    for (let i = 0; i < len; i++) unmasked[i] = payload[i]! ^ mask[i % 4]!
    payload = unmasked
  }
  return { opcode, payload, consumed: offset + maskLen + len }
}

export interface CdpCommand {
  id: number
  method: string
  params: Record<string, unknown>
  sessionId?: string
}

/** Return value for a scripted command handler (the `result` payload). */
export type CommandHandler = (cmd: CdpCommand) => Record<string, unknown> | { __error: string }

export class FakeCdp {
  server: Server
  socket: Duplex | null
  buffer: Buffer
  url: string
  commands: CdpCommand[]
  handler: CommandHandler
  waiters: Array<{ method: string, resolve: (cmd: CdpCommand) => void }>

  constructor (server: Server, port: number) {
    this.server = server
    this.socket = null
    this.buffer = Buffer.alloc(0)
    this.url = `ws://127.0.0.1:${port}/devtools/browser/fake`
    this.commands = []
    this.waiters = []
    this.handler = () => ({})
  }

  static async start (handler?: CommandHandler): Promise<FakeCdp> {
    const server = createServer()
    const fake = await new Promise<FakeCdp>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        resolve(new FakeCdp(server, (server.address() as AddressInfo).port))
      })
    })
    if (handler) fake.handler = handler
    server.on('upgrade', (req, socket) => {
      const key = req.headers['sec-websocket-key']
      const accept = createHash('sha1').update(key + WS_GUID).digest('base64')
      socket.write(
        'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
      )
      fake.socket = socket
      socket.on('data', (chunk: Buffer) => fake.onData(chunk))
      socket.on('error', () => {})
    })
    return fake
  }

  onData (chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk])
    while (true) {
      const frame = decodeFrame(this.buffer)
      if (!frame) return
      this.buffer = this.buffer.subarray(frame.consumed)
      if (frame.opcode === 8) { // close
        this.socket?.end(Buffer.from([0x88, 0x00]))
        return
      }
      if (frame.opcode === 9) { // ping -> pong
        this.socket?.write(Buffer.concat([Buffer.from([0x8a, frame.payload.length]), frame.payload]))
        continue
      }
      if (frame.opcode !== 1) continue
      const cmd = JSON.parse(frame.payload.toString('utf8')) as CdpCommand
      this.commands.push(cmd)
      const matched = this.waiters.filter((w) => w.method === cmd.method)
      this.waiters = this.waiters.filter((w) => w.method !== cmd.method)
      for (const waiter of matched) waiter.resolve(cmd)
      const outcome = this.handler(cmd)
      if ('__error' in outcome) {
        this.sendRaw({ id: cmd.id, error: { message: outcome.__error as string } })
      } else {
        this.sendRaw({ id: cmd.id, result: outcome })
      }
    }
  }

  sendRaw (obj: unknown): void {
    this.socket?.write(encodeTextFrame(Buffer.from(JSON.stringify(obj), 'utf8')))
  }

  emitEvent (method: string, params: Record<string, unknown>, sessionId?: string): void {
    this.sendRaw({ method, params, ...(sessionId ? { sessionId } : {}) })
  }

  /** Resolves when the next command with this method arrives (or already did). */
  waitForCommand (method: string): Promise<CdpCommand> {
    const seen = this.commands.find((c) => c.method === method)
    if (seen) return Promise.resolve(seen)
    return new Promise((resolve) => this.waiters.push({ method, resolve }))
  }

  async close (): Promise<void> {
    this.socket?.destroy()
    await new Promise((r) => this.server.close(r))
  }
}
