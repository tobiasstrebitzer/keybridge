// WKWebView user script (documentStart, page world): replace
// navigator.credentials.create/get so WebAuthn ceremonies are answered by the
// keybridge parent process instead of a real authenticator. This is the same
// interception technique password managers (Bitwarden, 1Password) use — the
// difference is where the signature comes from (the parent's Secure Enclave
// signer). Transport: webkit.messageHandlers.keybridge is a WithReply handler,
// so postMessage returns a Promise resolved with the parent's response (a
// JSON string).
(() => {
  'use strict'
  if (!navigator.credentials || !window.webkit || !window.webkit.messageHandlers) return
  // Capture the transport before the page can tamper with window.webkit.
  const kbHandler = window.webkit.messageHandlers.keybridge
  if (!kbHandler) return

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
  // JSON transport to the parent.
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

  const request = (op, options) =>
    kbHandler.postMessage({ op, options: serialize(options), origin: window.location.origin })
      .then((raw) => {
        const resp = typeof raw === 'string' ? JSON.parse(raw) : raw
        if (resp && resp.ok) return resp.credential
        const err = new Error((resp && resp.error) || 'keybridge shell error')
        err.code = resp && resp.code
        throw err
      })

  // Native constructors captured before we override navigator.credentials.
  // Synthetic results are re-parented onto these prototypes so RP libraries'
  // `instanceof PublicKeyCredential` checks pass (same as the extension).
  const NativePublicKeyCredential = window.PublicKeyCredential
  const NativeAttestationResponse = window.AuthenticatorAttestationResponse
  const NativeAssertionResponse = window.AuthenticatorAssertionResponse

  // Force the page to believe a user-verifying platform authenticator and
  // conditional mediation are available, so the passkey path is offered.
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

  // ENOCRED fallback kept for parity with the extension: if the parent has no
  // keybridge credential for this rpId, hand the ceremony to the real
  // navigator.credentials. (In a bare WKWebView the platform authenticator is
  // generally unavailable, so this usually surfaces as the page's own error —
  // but the shell's profile is keybridge-dedicated, so it shouldn't trigger.)
  navigator.credentials.create = function (options) {
    if (!options || !options.publicKey) return realCreate(options)
    return request('create', options.publicKey)
      .then(toCreateCredential)
      .catch((err) => {
        if (err && err.code === 'ENOCRED') return realCreate(options)
        throw new DOMException(String(err.message || err), 'NotAllowedError')
      })
  }

  navigator.credentials.get = function (options) {
    if (!options || !options.publicKey) return realGet(options)
    return request('get', options.publicKey)
      .then(toGetCredential)
      .catch((err) => {
        if (err && err.code === 'ENOCRED') return realGet(options)
        throw new DOMException(String(err.message || err), 'NotAllowedError')
      })
  }

  console.debug('[keybridge] WebAuthn bridge active on', window.location.origin)
})()
