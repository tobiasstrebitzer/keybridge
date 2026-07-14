// MAIN-world content script: replace navigator.credentials.create/get so that
// WebAuthn ceremonies on this page are answered by the local keybridge daemon
// instead of a real authenticator. Runs at document_start so the override is
// in place before the page's own scripts call WebAuthn.
//
// This is the same interception technique password managers (Bitwarden,
// 1Password) use — the difference is where the signature comes from.
(() => {
  const b64urlFromBuf = (buf) => {
    const bytes = new Uint8Array(buf)
    let s = ''
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i])
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  }
  const bufFromB64url = (str) => {
    const b64 = str.replace(/-/g, '+').replace(/_/g, '/')
    const bin = atob(b64)
    const bytes = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
    return bytes.buffer
  }

  // Deep-convert ArrayBuffers/TypedArrays to {$b64:...} so options survive
  // JSON transport to the daemon.
  const serialize = (v) => {
    if (v instanceof ArrayBuffer) return { $b64: b64urlFromBuf(v) }
    if (ArrayBuffer.isView(v)) {
      return { $b64: b64urlFromBuf(v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength)) }
    }
    if (Array.isArray(v)) return v.map(serialize)
    if (v && typeof v === 'object') {
      const o = {}
      for (const k of Object.keys(v)) o[k] = serialize(v[k])
      return o
    }
    return v
  }

  const pending = new Map()
  let seq = 0

  window.addEventListener('message', (e) => {
    if (e.source !== window) return
    const d = e.data
    if (!d || d.source !== 'keybridge-content') return
    const p = pending.get(d.id)
    if (!p) return
    pending.delete(d.id)
    if (d.resp && d.resp.ok) p.resolve(d.resp.credential)
    else p.reject(new Error((d.resp && d.resp.error) || 'keybridge daemon error'))
  })

  const request = (op, options) => new Promise((resolve, reject) => {
    const id = `kb-${Date.now()}-${seq++}`
    pending.set(id, { resolve, reject })
    window.postMessage({ source: 'keybridge-inject', id, op, options, origin: window.location.origin }, window.location.origin)
  })

  // Native constructors captured before we override navigator.credentials.
  // We re-parent our synthetic results onto these prototypes so RP libraries'
  // `instanceof PublicKeyCredential` / `instanceof AuthenticatorAttestationResponse`
  // checks pass — the single most important thing that makes the credential
  // "indistinguishable from native" (the technique Bitwarden's extension uses).
  const NativePublicKeyCredential = window.PublicKeyCredential
  const NativeAttestationResponse = window.AuthenticatorAttestationResponse
  const NativeAssertionResponse = window.AuthenticatorAssertionResponse

  // Force the page to believe a user-verifying platform authenticator and
  // conditional mediation are available, so the passkey path is offered and not
  // silently disabled. (Bitwarden polyfills UVPAA the same way.)
  if (NativePublicKeyCredential) {
    try {
      NativePublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable = () => Promise.resolve(true)
      NativePublicKeyCredential.isConditionalMediationAvailable = () => Promise.resolve(true)
    } catch { /* read-only in some engines; ignore */ }
  }

  const toCreateCredential = (c) => {
    const response = {
      clientDataJSON: bufFromB64url(c.response.clientDataJSON),
      attestationObject: bufFromB64url(c.response.attestationObject),
      getAuthenticatorData: () => bufFromB64url(c.response.authenticatorData),
      getPublicKey: () => (c.response.publicKey ? bufFromB64url(c.response.publicKey) : null),
      getPublicKeyAlgorithm: () => c.response.publicKeyAlgorithm ?? -7,
      getTransports: () => c.response.transports || ['internal'],
    }
    if (NativeAttestationResponse) Object.setPrototypeOf(response, NativeAttestationResponse.prototype)

    const credential = {
      id: c.id,
      rawId: bufFromB64url(c.rawId),
      type: 'public-key',
      authenticatorAttachment: c.authenticatorAttachment || 'platform',
      response,
      getClientExtensionResults: () => ({}),
      // Own toJSON is REQUIRED once the prototype is patched: modern
      // @simplewebauthn/browser prefers PublicKeyCredential.prototype.toJSON,
      // and the native method throws "Illegal invocation" on a synthetic object.
      toJSON: () => ({
        id: c.id,
        rawId: c.rawId,
        type: 'public-key',
        authenticatorAttachment: c.authenticatorAttachment || 'platform',
        clientExtensionResults: {},
        response: {
          clientDataJSON: c.response.clientDataJSON,
          attestationObject: c.response.attestationObject,
          authenticatorData: c.response.authenticatorData,
          transports: c.response.transports || ['internal'],
          publicKeyAlgorithm: c.response.publicKeyAlgorithm ?? -7,
          ...(c.response.publicKey ? { publicKey: c.response.publicKey } : {}),
        },
      }),
    }
    if (NativePublicKeyCredential) Object.setPrototypeOf(credential, NativePublicKeyCredential.prototype)
    return credential
  }

  const toGetCredential = (c) => {
    const response = {
      clientDataJSON: bufFromB64url(c.response.clientDataJSON),
      authenticatorData: bufFromB64url(c.response.authenticatorData),
      signature: bufFromB64url(c.response.signature),
      userHandle: c.response.userHandle ? bufFromB64url(c.response.userHandle) : null,
    }
    if (NativeAssertionResponse) Object.setPrototypeOf(response, NativeAssertionResponse.prototype)

    const credential = {
      id: c.id,
      rawId: bufFromB64url(c.rawId),
      type: 'public-key',
      authenticatorAttachment: c.authenticatorAttachment || 'platform',
      response,
      getClientExtensionResults: () => ({}),
      toJSON: () => ({
        id: c.id,
        rawId: c.rawId,
        type: 'public-key',
        authenticatorAttachment: c.authenticatorAttachment || 'platform',
        clientExtensionResults: {},
        response: {
          clientDataJSON: c.response.clientDataJSON,
          authenticatorData: c.response.authenticatorData,
          signature: c.response.signature,
          ...(c.response.userHandle ? { userHandle: c.response.userHandle } : {}),
        },
      }),
    }
    if (NativePublicKeyCredential) Object.setPrototypeOf(credential, NativePublicKeyCredential.prototype)
    return credential
  }

  const credentials = navigator.credentials
  const realCreate = credentials.create.bind(credentials)
  const realGet = credentials.get.bind(credentials)

  navigator.credentials.create = function (options) {
    if (!options || !options.publicKey) return realCreate(options)
    return request('create', serialize(options.publicKey))
      .then(toCreateCredential)
      .catch((err) => { throw new DOMException(String(err.message || err), 'NotAllowedError') })
  }

  navigator.credentials.get = function (options) {
    if (!options || !options.publicKey) return realGet(options)
    return request('get', serialize(options.publicKey))
      .then(toGetCredential)
      .catch((err) => { throw new DOMException(String(err.message || err), 'NotAllowedError') })
  }

  console.debug('[keybridge] WebAuthn bridge active on', window.location.origin)
})()
