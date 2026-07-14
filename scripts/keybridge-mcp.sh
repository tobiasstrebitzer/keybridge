#!/bin/sh
# Plugin-context launcher for the keybridge MCP server. A plugin install is a
# bare git clone (no node_modules, no dist/), so install the runtime deps into
# the plugin directory once, then run the server on native TS (Node >= 22.18).
#
# IMPORTANT: never cd - the caller's working directory is the session's
# project root, which the server captures as PROJECT_ROOT (publishes target
# it). Deps are installed via a subshell instead.
# stdout is the MCP stdio channel - all install output goes to stderr.
PLUGIN_DIR="$(cd "$(dirname "$0")/.." && pwd)" || exit 1
[ -d "$PLUGIN_DIR/node_modules" ] || (cd "$PLUGIN_DIR" && npm install --omit=dev --no-audit --no-fund --loglevel=error) 1>&2
exec node "$PLUGIN_DIR/src/server.ts"
