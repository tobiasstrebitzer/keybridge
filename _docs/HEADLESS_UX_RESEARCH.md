# keybridge — headless / invisible UX research

> **STATUS (2026-07-14): Tier A shipped.** The recommendation below — an invisible
> headed Chrome driving the extension over CDP — is implemented in
> `src/presenters/chrome.ts` (+ the CDP client `src/cdp.ts`) and verified live.
> One refinement from the build: macOS clamps off-screen window coordinates to the
> display, so the window is hidden by **minimizing** it, not by
> `--window-position=-32000,-32000` alone (page JS + network keep running while
> minimized). This doc is kept as the design rationale.

Goal: make the publish flow feel like **"run it → Touch ID → done"**, nothing else
visible. Two target use cases:

1. **User:** `keybridge publish` → Touch ID → done.
2. **Agent:** Claude runs an MCP tool ("publish v0.1.5") → Touch ID → done. Token-efficient
   (no dumping a browser DOM into the model's context).

The Touch ID prompt is desired — it's the security boundary, and it comes from keybridge's
own Secure Enclave signer (a macOS **LocalAuthentication** dialog), **not** from Chrome.
So "only Touch ID visible" is achievable in every option below; the question is what, if
anything, has to run around it.

---

## Q1 — Can we go fully browserless (build our own "full client")?

**Short answer: yes, technically — and we already own the hard part — but there's one real
catch (a website session cookie) and two caveats (npm's private API + ToS).**

### Why it's possible

A WebAuthn ceremony is HTTP + a signature. In our flow the browser does exactly three
non-cryptographic things:

1. Hosts npm's page JS.
2. Acts as the HTTP client to npmjs.com.
3. Dispatches `navigator.credentials.get()` to an authenticator.

We already replace #3 with keybridge's Secure Enclave signer, and its assertions verify
against the RP's stored public key (proven at both webauthn.io and npm). Crucially:

- **No Chrome-specific native API is involved.** Because the extension intercepts
  `navigator.credentials` *before* Chrome's own WebAuthn stack, Chrome's platform-
  authenticator plumbing (its Touch ID / `ASAuthorization` path) never runs. The only
  "native" call is keybridge's own `SecureEnclave.P256` signing via the Swift helper —
  which already runs fine with no browser. So there is nothing the browser provides that
  we can't provide ourselves.

- **npm's escalation step is a plain HTTP contract** (captured live — see
  `NPM_WEBAUTHN_FLOW.md` §4):
  - `GET /escalate/webauthn?next=<next>` with `x-spiferack: 1` → JSON containing the
    `get()` challenge + allowCredentials + csrftoken.
  - `POST /escalate/webauthn?next=<next>` with `{ webAuthnAssertion:{…}, csrftoken, … }`
    → `200 auth/authentication-successful`.
  - Then the CLI `doneUrl` (registry) flips 202 → 200 `{ token }`.

So a browserless client is: **mint session → GET challenge → keybridge SE sign (Touch ID)
→ POST assertion → poll doneUrl → `npm publish --otp`.** Pure HTTP + local signing.
Everything between the browser and npm can indeed be simulated.

### The blocker (probed 2026-07-14): Cloudflare fronts www.npmjs.com

Before the session-cookie question even matters, there is a harder wall.
`www.npmjs.com/escalate/webauthn` sits behind **Cloudflare bot-management**. A plain HTTP
client — tested with both the registry Bearer token and a **full realistic Chrome header
set** (UA, `sec-ch-ua`, `sec-fetch-*`, `x-spiferack`, referer) — gets:

```
HTTP 403   cf-mitigated: challenge   server: cloudflare
<!DOCTYPE html> … <title>Just a moment...</title>   (managed JS challenge)
```

Bearer vs. no-auth made no difference — Cloudflare blocks at the edge, before npm's auth
layer is reached. The managed challenge requires executing Cloudflare's JS to earn a
`cf_clearance` / `__cf_bm` cookie, which in practice **only a real browser can do**. (The
registry host `registry.npmjs.org` — where mint and `doneUrl` live — is *not* behind this,
which is why those work over plain `fetch`.)

This moots the Bearer/`wub`-cookie question: even with the perfect session cookie, a
scripted client can't get through Cloudflare to the escalate endpoint. The only ways past
are (a) a real browser, or (b) a Cloudflare-solver / harvested `cf_clearance` — fragile
(`__cf_bm` ≈ 30 min TTL, IP+UA-bound), a cat-and-mouse game, and squarely against ToS.

### Additional caveats (secondary now)

- The escalate endpoints also need the **website session cookie** (`wub`), not the
  registry Bearer token — a second reason a browser is involved.
- **Private, unversioned API** (`spiferack`, escalate form fields) can change without
  notice; and scripting npm's private web endpoints is closer to the ToS line than driving
  a browser.

**Verdict: NOT viable as a pure HTTP client.** Cloudflare's managed challenge effectively
requires a real browser to reach npm's escalate ceremony, so the "no browser at all" dream
collapses — you need a browser for Cloudflare regardless of the crypto. The realistic
architecture is therefore "a real (but invisible) browser does the ceremony," i.e. **Tier
A**. A degenerate hybrid (browser solves CF + holds cookies, keybridge POSTs the assertion
over HTTP with harvested `cf_clearance`+`wub`) is possible but buys almost nothing over
letting the browser complete the ceremony, while adding CF-cookie fragility — not
recommended.

---

## Q2 — If we keep a browser, can it be invisible?

### Headless (`--headless=new`) — no.
Confirmed: new-headless Chrome does **not** load unpacked `--load-extension` extensions,
and even via CDP `Extensions.loadUnpacked` the MV3 content-script/inject path did not run
headless in our tests. Extensions + headless is unreliable across versions. Treat headless
as unavailable for the extension approach.

### Invisible **headed** Chrome — yes. (Recommended near-term.)
Run a *real* headed Chrome (extensions work) but keep it off-screen and on-demand:

- **Off-screen:** launch with `--window-position=-32000,-32000` (and/or a tiny
  `--window-size`), or on a separate macOS Space. The window never appears on-screen.
- **On-demand + auto-driven:** keybridge spins Chrome up only for the ceremony, drives it
  over CDP — navigate to `authUrl`, auto-click "Use security key" (or have `inject.js`
  auto-invoke) — Touch ID fires, then close Chrome. Total visible surface = the Touch ID
  dialog.
- **Persistent profile pays off here:** `.chrome-dev-profile` keeps the npm **website
  session cookie** *and* the loaded extension across launches, so most publishes need no
  login — the profile's cookie authenticates the escalate, and only Touch ID is required.
  Re-login only when the cookie expires.

Trade-offs: ~1–2s Chrome cold-start per invocation; a background Chrome process for the
duration; depends on the persistent profile. But it uses npm's **real page JS**, so it's
robust to npm's private-API churn — the opposite fragility profile from Q1.

---

## Recommendation

The Cloudflare probe (above) removes Tier B from the table: a pure HTTP client can't reach
npm's escalate ceremony. **Tier A — an invisible headed Chrome — is the path.**

| | Tier A — invisible headed Chrome | ~~Tier B — browserless HTTP client~~ |
|---|---|---|
| Visible to user | Touch ID only | Touch ID only |
| Reaches npm escalate | ✅ browser passes Cloudflare | ❌ **blocked by Cloudflare (`cf-mitigated: challenge`)** |
| Robustness | High (drives real npm JS) | n/a |
| Session needs | Profile holds `cf_clearance` + `wub` + extension | — |
| Startup cost | ~1–2s Chrome launch | — |
| Token cost (agent) | low (keybridge drives CDP, not the model) | — |

**Plan:**

1. **Ship Tier A.** Change keybridge's `presenter` from "open default browser" to "launch
   an off-screen headed Chrome with the `.chrome-dev-profile` (extension + Cloudflare +
   website cookies), CDP-navigate to `authUrl`, auto-complete the ceremony, close." Both
   use cases become `keybridge publish` / MCP `NpmPublish` → Touch ID → done. The
   persistent profile passing Cloudflare naturally is exactly why the browser is required,
   not merely convenient.
2. **Add `inject.js` fallback** (Bitwarden-style `fallbackRequested`) so keybridge can stay
   installed without breaking other authenticators — required for a persistent profile the
   user also logs into.
3. **Do not pursue a pure browserless client.** Cloudflare's managed challenge makes it a
   fragile CF-solver arms race for no real gain over Tier A. If cold-start latency ever
   matters, keep a single off-screen Chrome warm across publishes rather than dropping the
   browser.

### For the MCP / agent use case specifically
The agent should never see a browser DOM. Whether Tier A or B, the MCP `NpmPublish` tool
does all the driving **inside keybridge** (CDP or HTTP) and returns only a small structured
result (published id/version, or an error). The model's only involvement is calling the
tool; the human's only involvement is the Touch ID tap. That satisfies "token-efficient,
Touch ID, done."

### The macOS "invisible" reality check
The one thing that always appears is the **Touch ID / LocalAuthentication** dialog from
keybridge's SE signer — by design. Everything else (Chrome window, page, network) can be
made invisible. There is no way to get an SE signature gated on biometrics *without* that
system prompt, which is exactly the property we want.
