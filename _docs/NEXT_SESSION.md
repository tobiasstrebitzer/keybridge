# Next session — live test runbook

**Goal:** prove the one unproven leg — a real `npm publish` completing through
the **Tier A** invisible-Chrome presenter with a real **Touch ID** tap — from
both the CLI and the MCP tool. Everything up to that point is built and verified
(engine, presenter mechanics, extension injection, teardown, warm reuse). This
session just needs a human at the keyboard to touch the sensor.

> State as of 2026-07-14 (session 2): keybridge is now a single TS package at
> the repo root (the old plain-JS package and the `v3/` staging dir are gone —
> `git log` has them). Tier A is the default presenter on macOS.

---

## 0. Preflight (2 min)

```sh
cd /Users/atomic/projects/ai/keybridge
node --version            # must be >= 22.18 (native TS + type-stripping)
pnpm install
pnpm check                # tsc + oxlint + 14 tests — all green
node v2/install.mjs       # (re)build SE helper, launcher, native-messaging manifests
```

Confirm the keybridge passkey is still enrolled on the npm account
(`tstrebitzer`): npm → Settings → Two-Factor Authentication should list the
security key added on 2026-07-14. If it was removed, re-enroll first (see
`NPM_WEBAUTHN_FLOW.md` §3a).

Chrome + native host sanity:
- Real Google Chrome installed at `/Applications/Google Chrome.app` (or set
  `KEYBRIDGE_CHROME`).
- `~/.keybridge/keybridge-launch.sh` and `~/.keybridge/config.json`
  (`backend: secure-enclave`) exist (install.mjs writes them).

## 1. Seed the ceremony profile past Cloudflare (first run only)

Tier A uses a persistent profile at `~/.keybridge/chrome-profile`. On a cold
profile, npm's escalate page needs `cf_clearance` + the npm website session
(`wub`) cookie. Easiest seed: run one publish/login with the window **surfaced**
so you can clear any Cloudflare challenge and log into npmjs.com once; the
profile keeps the cookies afterward.

```sh
# Temporarily make the ceremony window visible to seed cookies:
KEYBRIDGE_PRESENTER=chrome node src/cli.ts login
```

The presenter already surfaces the window automatically if npm bounces to a
password login (it watches for an `input[type=password]`). If Cloudflare shows
a challenge instead, add a one-off `surfaceWindow` call or just log in through
the surfaced window. Once `~/.keybridge/chrome-profile` holds the cookies,
subsequent publishes run fully invisible.

## 2. Live publish via the CLI

```sh
cd keybridge-test
npm version patch --no-git-tag-version    # bump to an unused version
cd ..
node src/cli.ts publish -- --registry https://registry.npmjs.org
# expect: minimized Chrome does the ceremony → Touch ID prompt → "published keybridge-test@x.y.z"
```

What to watch:
- The **only** visible UI should be the Touch ID dialog. If a Chrome window
  flashes on-screen, the minimize timing needs a nudge (it minimizes right after
  the tab opens).
- **The load-bearing unknown:** does the auto-click find npm's real
  "Use security key" button? `STATUS_SCRIPT` in `src/presenters/chrome.ts`
  matches `/use security key|security key/i` across
  `button, a, [role=button], input[type=submit]`. If the ceremony stalls
  (Touch ID never fires), open the surfaced window and inspect npm's actual
  markup, then tighten the selector.

## 3. Live publish via the MCP tool

With the `keybridge` MCP server configured (`.mcp.json` already points at
`src/server.ts`), call the `NpmPublish` tool from Claude Code:
- `dryRun: true` first (no ceremony, validates packaging).
- then a real call → Touch ID → structured result `{ published, package, … }`.

Verify the model only ever sees the small structured result, never a browser DOM.

## 4. If it works

- Update `NPM_WEBAUTHN_FLOW.md` to record Tier A as verified end-to-end.
- Consider flipping `package.json` `private:false` and doing a real publish of
  `keybridge` itself (bump version; `pnpm build` runs on prepack). Re-check the
  `files` whitelist first.

---

## Known edge cases (already handled in code — confirm live)

- **Expired 12 h session** → engine runs web-login first (one extra touch),
  persists the token, then publishes. Both ceremonies go through Tier A.
- **npm < 12 redacted URLs** → engine mints its own session
  (`mintWebAuthSession`) to get unredacted `authUrl`/`doneUrl`.
- **Cloudflare on a cold profile** → surface the window once to seed cookies
  (step 1); the persistent profile carries them afterward.
- **Warm Chrome** → the CLI leaves Chrome running (off-screen) and only drops
  the CDP socket, so the next publish skips the ~8 s cold start. `pkill "Google
  Chrome"` if you need a truly cold run.

## Deferred (not needed for the live test)

- Tighten the `files` whitelist further / decide whether to ship `v2/test`
  (currently excluded).
- Idle-timeout auto-close for the warm Chrome, or a `keybridge stop` command.
- `install.mjs` could also seed the ceremony profile's native-messaging manifest
  (the presenter already does this on launch via `ensureNativeManifest`).

## Reference

- `NPM_WEBAUTHN_FLOW.md` — the proven npm HTTP contract + every edge case.
- `HEADLESS_UX_RESEARCH.md` — why Tier A (Cloudflare blocks a pure-HTTP client).
- silkweave API + the TS7 stack are documented in `CLAUDE.md` and the memory
  files; inspect `@silkweave/*` via `npm pack` (READMEs are empty over
  `npm view`).
