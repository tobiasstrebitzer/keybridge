# Next session — plan

Two workstreams: **(1) build Tier A** (invisible off-screen-Chrome presenter),
and **(2) do it in a TypeScript 7 / oxlint project using silkweave**
(`@silkweave/core`, `@silkweave/mcp`), mirroring the tooling in
`/Users/atomic/projects/ai/claude-plugins`.

Where we are: enroll + login + publish are proven end-to-end through the
keybridge extension in an MCP-driven Chrome (see `NPM_WEBAUTHN_FLOW.md`). The
publish flow currently opens the *default* browser via `src/presenters.js`. Tier
A replaces that with an off-screen Chrome that drives the extension so only Touch
ID is visible.

---

## Task 1 — Tier A: off-screen Chrome presenter

**Goal UX**
- User: `keybridge publish` → Touch ID → done.
- Agent: MCP `npm_publish` → Touch ID → done (token-efficient; keybridge drives
  the browser, the model never sees a DOM).

**Why a browser at all:** `www.npmjs.com` is behind Cloudflare (`cf-mitigated:
challenge`) — a pure HTTP client is blocked. A real (but invisible) browser
passes Cloudflare naturally and its persistent profile holds `cf_clearance` +
`wub` + the extension. See `HEADLESS_UX_RESEARCH.md`.

**Design** — a new presenter `({ authUrl, signal }) => Promise` that:

1. **Launch/reuse** a headed Chrome (real Google Chrome, `--channel`=stable
   binary) with:
   - `--user-data-dir=<repo>/.chrome-dev-profile` (persists CF/npm cookies + ext)
   - `--window-position=-32000,-32000` (off-screen; effectively invisible)
   - `--remote-debugging-port=0` (or a pipe) for CDP control
   - `--no-first-run --no-default-browser-check`
   Prefer keeping one warm instance across publishes to avoid ~1–2 s cold start.
2. **Ensure the extension is loaded.** `--load-extension` is dead on Chrome 150;
   load via CDP **`Extensions.loadUnpacked({ path: v2/extension })`** (needs the
   browser launched with `--enable-unsafe-extension-debugging` when driving over
   a raw ws port). Loading from the same absolute path yields the stable id
   `hanmdmgojaeciaajdbjiaaafebcgkhkc` the native-messaging manifest authorizes.
   Also confirm the manifest exists at
   `<user-data-dir>/NativeMessagingHosts/` (install.mjs writes it there).
3. **Navigate** to `authUrl` → npm redirects to `/escalate/webauthn`.
4. **Click "Use security key"** via CDP `Runtime.evaluate` (find the button by
   text and `.click()`), which fires `navigator.credentials.get()` → the
   extension's `inject.js` intercepts → native host → **Secure Enclave → Touch
   ID** (the only visible thing).
5. On the engine's `signal` abort (doneUrl returned the token), **tear down**
   (close the tab / hide the window; keep Chrome warm if pooling).

**CDP client:** don't pull in puppeteer — a minimal CDP-over-WebSocket client is
enough (Node 22+ has global `WebSocket`). Working reference patterns are in the
scratchpad scripts from this session (`validate-load-unpacked.mjs` shows launch →
`Extensions.loadUnpacked` → `Page.navigate` → `Runtime.evaluate`), reproduced in
`NPM_WEBAUTHN_FLOW.md`.

**Wiring:** `src/engine.js` already calls `presenter({ authUrl, signal })`, so
this is a drop-in presenter. `bin/keybridge.js` and `src/mcp-server.js` select
it (make it the default on macOS; keep `browserPresenter` as a fallback).

**Edge cases to handle**
- Expired `cf_clearance`/`wub` → escalate page bounces to login. Engine already
  does E401→login; the login ceremony runs through the same off-screen presenter.
- Chrome already running with that profile (single-instance lock) — pool/reuse.
- First-run: profile empty, extension not yet loaded → loadUnpacked on launch.

## Task 2 — `inject.js` fallback (prerequisite for a shared profile)

`v2/extension/inject.js` currently intercepts *all* WebAuthn on `www.npmjs.com` /
`webauthn.io` and throws when it has no matching credential — so it breaks any
login that uses a different authenticator (we had to uninstall it for the
password login during testing). Add Bitwarden-style **`fallbackRequested`**: when
the daemon reports "no keybridge credential for rpId", call the real
`navigator.credentials.{get,create}` instead of throwing. This lets keybridge
stay installed in a profile the user also logs into normally.

---

## Task 3 — tooling: TypeScript 7 + oxlint + silkweave

Target: (re)build the keybridge MCP server / new code as a **TS 7** project using
**`@silkweave/core`** and **`@silkweave/mcp`**, linted with **oxlint**, mirroring
the stack in `/Users/atomic/projects/ai/claude-plugins`.

> ⚠️ **silkweave is NOT in claude-plugins.** Grepped the whole repo — zero
> `silkweave` matches; it's a plugin *marketplace*, not a silkweave/MCP project.
> So claude-plugins gives us the **TS7 + oxlint + pnpm** stack to mirror, but the
> `@silkweave/*` API must be sourced separately (npm `@silkweave/core` /
> `@silkweave/mcp` — resolve its README / `npm view` / context7 at the start of
> next session). Don't assume its shape from claude-plugins.

### The stack to mirror (verified from claude-plugins)

**Package manager: pnpm** (`"packageManager": "pnpm@11.8.0"`, `pnpm-lock.yaml`
lockfileVersion 9). Single package, `"type": "module"`, `"private": true`.

**TypeScript 7 — the native (Go) `tsgo` compiler, run as type-stripping only:**
- devDep `"typescript": "^7.0.2"`; the native binary ships via
  `@typescript/typescript-<platform>@7.0.2` (e.g. `-darwin-arm64`). `typescript`
  itself has no JS compiler API anymore — just a launcher.
- `tsconfig.json` compilerOptions:
  ```json
  { "target": "ES2022", "module": "NodeNext", "moduleResolution": "NodeNext",
    "lib": ["ES2022"], "types": ["node"], "strict": true, "noEmit": true,
    "erasableSyntaxOnly": true, "esModuleInterop": true, "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true, "allowSyntheticDefaultImports": true,
    "resolveJsonModule": true }
  ```
- **`erasableSyntaxOnly: true`** ⇒ code runs as native TS directly under Node
  (`node file.ts` type-stripping, needs Node ≥ 22.18). **No enums, namespaces, or
  parameter properties.** Never add a TS 5/6 dependency — it breaks the native
  toolchain. `noEmit` — nothing is compiled/bundled; TS is executed directly.
- VSCode pin (`.vscode/settings.json`): `"typescript.experimental.useTsgo": true`,
  `"typescript.native-preview.tsdk": "./node_modules/typescript"`, extension
  `TypeScriptTeam.native-preview`.

**Lint: oxlint** (`"oxlint": "^1.73.0"`) — **not eslint** (typescript-eslint needs
the TS JS compiler API that TS7 doesn't ship). `.oxlintrc.json`:
```json
{ "$schema": "./node_modules/oxlint/configuration_schema.json",
  "categories": { "correctness": "error", "suspicious": "error" },
  "rules": {
    "no-unused-vars": ["error", { "args": "all", "argsIgnorePattern": "^_",
      "caughtErrors": "all", "caughtErrorsIgnorePattern": "^_",
      "destructuredArrayIgnorePattern": "^_", "varsIgnorePattern": "^_",
      "ignoreRestSiblings": true }],
    "typescript/no-shadow": "error", "typescript/prefer-for-of": "error",
    "typescript/adjacent-overload-signatures": "error",
    "typescript/unified-signatures": "error",
    "no-empty": ["error", { "allowEmptyCatch": true }] },
  "ignorePatterns": ["node_modules"] }
```

**Scripts / test:**
```json
"check": "pnpm typecheck && pnpm lint && pnpm test",
"typecheck": "tsc --noEmit",
"lint": "oxlint",
"lint:fix": "oxlint --fix",
"test": "node --test \"tests/**/*.test.ts\""
```
Test runner is **node:test** over native `.ts` files. devDeps: `@types/node ^26`,
`oxlint ^1.73.0`, `typescript ^7.0.2`. No bundler, no turbo/biome/prettier.
Style (unenforced): no semicolons, single quotes, 2-space indent.

### Migration notes for keybridge

- keybridge is currently plain ESM JS (`.mjs`/`.js`). Porting to this stack means:
  `.ts` sources run via node type-stripping, `tsconfig` as above, oxlint, tests as
  `tests/**/*.test.ts` under `node --test`. Keep the `@modelcontextprotocol/sdk`
  MCP server *unless* `@silkweave/mcp` is meant to replace it — decide once its
  API is known.
- Update this project's Wrapup Config `check` from "skip" to `pnpm check` once the
  toolchain lands.
- Likely first move: scaffold a fresh TS7/oxlint/pnpm package (mirror the files
  above), resolve `@silkweave/core` + `@silkweave/mcp`, then build the Tier A
  presenter + rewritten MCP server there.
