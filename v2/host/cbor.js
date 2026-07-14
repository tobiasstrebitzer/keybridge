// Minimal CBOR (RFC 8949) encoder/decoder — just the subset WebAuthn needs:
// unsigned ints, negative ints, byte strings, text strings, arrays, maps.
// Maps encode/decode as JS Map so integer keys (COSE) survive.

function head (major, n, out) {
  if (n < 24) out.push(Buffer.from([(major << 5) | n]))
  else if (n < 0x100) out.push(Buffer.from([(major << 5) | 24, n]))
  else if (n < 0x10000) { const b = Buffer.alloc(3); b[0] = (major << 5) | 25; b.writeUInt16BE(n, 1); out.push(b) }
  else if (n < 0x100000000) { const b = Buffer.alloc(5); b[0] = (major << 5) | 26; b.writeUInt32BE(n, 1); out.push(b) }
  else throw new RangeError('cbor: integer too large for this encoder')
}

function encodeInto (value, out) {
  if (typeof value === 'number') {
    if (!Number.isInteger(value)) throw new TypeError('cbor: only integers supported')
    if (value >= 0) head(0, value, out)
    else head(1, -1 - value, out)
    return
  }
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    const buf = Buffer.from(value)
    head(2, buf.length, out); out.push(buf)
    return
  }
  if (typeof value === 'string') {
    const buf = Buffer.from(value, 'utf8')
    head(3, buf.length, out); out.push(buf)
    return
  }
  if (Array.isArray(value)) {
    head(4, value.length, out)
    for (const item of value) encodeInto(item, out)
    return
  }
  if (value instanceof Map) {
    head(5, value.size, out)
    for (const [k, v] of value) { encodeInto(k, out); encodeInto(v, out) }
    return
  }
  if (value && typeof value === 'object') {
    const keys = Object.keys(value)
    head(5, keys.length, out)
    for (const k of keys) { encodeInto(k, out); encodeInto(value[k], out) }
    return
  }
  throw new TypeError(`cbor: cannot encode ${typeof value}`)
}

export function encode (value) {
  const out = []
  encodeInto(value, out)
  return Buffer.concat(out)
}

function decodeAt (buf, pos) {
  const b = buf[pos]
  const major = b >> 5
  const info = b & 0x1f
  let n, next
  if (info < 24) { n = info; next = pos + 1 }
  else if (info === 24) { n = buf[pos + 1]; next = pos + 2 }
  else if (info === 25) { n = buf.readUInt16BE(pos + 1); next = pos + 3 }
  else if (info === 26) { n = buf.readUInt32BE(pos + 1); next = pos + 5 }
  else throw new Error('cbor: unsupported length encoding')

  switch (major) {
    case 0: return [n, next]
    case 1: return [-1 - n, next]
    case 2: return [buf.subarray(next, next + n), next + n]
    case 3: return [buf.subarray(next, next + n).toString('utf8'), next + n]
    case 4: {
      const arr = []
      let p = next
      for (let i = 0; i < n; i++) { const [v, np] = decodeAt(buf, p); arr.push(v); p = np }
      return [arr, p]
    }
    case 5: {
      const map = new Map()
      let p = next
      for (let i = 0; i < n; i++) {
        const [k, kp] = decodeAt(buf, p)
        const [v, vp] = decodeAt(buf, kp)
        map.set(k, v); p = vp
      }
      return [map, p]
    }
    default: throw new Error(`cbor: unsupported major type ${major}`)
  }
}

export function decode (buf) {
  const [value] = decodeAt(Buffer.from(buf), 0)
  return value
}

export default { encode, decode }
