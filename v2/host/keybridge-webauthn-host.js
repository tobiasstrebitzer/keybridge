#!/usr/bin/env node
// keybridge WebAuthn native-messaging host.
//
// Chrome launches this per request (chrome.runtime.sendNativeMessage): it
// reads one length-prefixed JSON message from the extension, assembles the
// WebAuthn response (signing via the Secure Enclave / software backend),
// writes one length-prefixed JSON response, and exits.
//
// Message in:  { op: 'create'|'get', options: <serialized publicKey opts>, origin }
// Message out: { ok: true, credential: {...} } | { ok: false, error: '...' }
import { appendFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { handleCreate, handleGet } from './webauthn.js'
import { createSigner } from './signer.js'

const KB_DIR = join(homedir(), '.keybridge')
const AUDIT = join(KB_DIR, 'audit.log')

function audit (entry) {
  try {
    mkdirSync(KB_DIR, { recursive: true })
    appendFileSync(AUDIT, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n')
  } catch {}
}

function readMessage () {
  return new Promise((resolve, reject) => {
    const chunks = []
    let len = null
    process.stdin.on('data', (c) => {
      chunks.push(c)
      const buf = Buffer.concat(chunks)
      if (len === null) {
        if (buf.length < 4) return
        len = buf.readUInt32LE(0)
      }
      if (buf.length < 4 + len) return
      try { resolve(JSON.parse(buf.subarray(4, 4 + len).toString('utf8'))) } catch (e) { reject(e) }
    })
    process.stdin.on('end', () => { if (len === null) resolve(null) })
    process.stdin.on('error', reject)
  })
}

function writeMessage (obj) {
  const json = Buffer.from(JSON.stringify(obj), 'utf8')
  const header = Buffer.alloc(4)
  header.writeUInt32LE(json.length, 0)
  process.stdout.write(Buffer.concat([header, json]))
}

// Undo inject.js's ArrayBuffer serialization: {$b64:"..."} -> base64url string.
function unwrap (v) {
  if (v && typeof v === 'object' && typeof v.$b64 === 'string') return v.$b64
  if (Array.isArray(v)) return v.map(unwrap)
  if (v && typeof v === 'object') {
    const o = {}
    for (const k of Object.keys(v)) o[k] = unwrap(v[k])
    return o
  }
  return v
}

async function main () {
  const msg = await readMessage()
  if (!msg) { process.exit(0) }

  try {
    const signer = createSigner()
    const options = unwrap(msg.options)
    const origin = msg.origin
    let credential
    if (msg.op === 'create') credential = await handleCreate(options, origin, signer)
    else if (msg.op === 'get') credential = await handleGet(options, origin, signer)
    else throw new Error(`unknown op "${msg.op}"`)

    audit({ op: msg.op, origin, rpId: options.rp?.id ?? options.rpId ?? null, credId: credential.id, backend: signer.backend })
    writeMessage({ ok: true, credential })
  } catch (e) {
    audit({ op: msg?.op, origin: msg?.origin, error: String(e?.message ?? e) })
    writeMessage({ ok: false, error: String(e?.message ?? e) })
  }
  process.exit(0)
}

// Guard against import path issues when launched directly.
void dirname(fileURLToPath(import.meta.url))
main()
