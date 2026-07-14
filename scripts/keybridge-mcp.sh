#!/bin/sh
# Plugin-context launcher for the keybridge MCP server. A plugin install is a
# bare git clone (no node_modules, no dist/), so install the runtime deps into
# the plugin directory once, then run the server on native TS (Node >= 22.18).
# stdout is the MCP stdio channel - all install output goes to stderr.
cd "$(dirname "$0")/.." || exit 1
[ -d node_modules ] || npm install --omit=dev --no-audit --no-fund --loglevel=error 1>&2
exec node src/server.ts
