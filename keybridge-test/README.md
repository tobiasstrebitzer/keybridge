# keybridge-test

Throwaway stub package used to exercise [keybridge](../README.md)'s WebAuthn
publish hand-off against the real npm registry. It exports one constant and
has no other purpose — don't install it.

## Test drive

From this directory:

```sh
# 1. dry run — packs, no auth, nothing published
node ../bin/keybridge.js publish -- --dry-run

# 2. the real thing — expect the browser to open npm's auth page,
#    touch your security key / Touch ID, publish completes
node ../bin/keybridge.js publish

# 3. macOS sheet variant (experimental)
node ../bin/keybridge.js publish --sheet
```

Bump `version` in package.json between publish attempts
(`npm version patch --no-git-tag-version`).
