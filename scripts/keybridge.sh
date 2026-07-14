#!/bin/sh
# Plugin-context launcher for the keybridge CLI (setup/login/publish). Same
# bootstrap as keybridge-mcp.sh: a plugin install is a bare git clone, so
# install runtime deps once, then run the CLI on native TS (Node >= 22.18).
#
# IMPORTANT: never cd - `keybridge publish` publishes the package in the
# caller's working directory. Deps are installed via a subshell instead.
PLUGIN_DIR="$(cd "$(dirname "$0")/.." && pwd)" || exit 1
[ -d "$PLUGIN_DIR/node_modules" ] || (cd "$PLUGIN_DIR" && npm install --omit=dev --no-audit --no-fund --loglevel=error) 1>&2
exec node "$PLUGIN_DIR/src/cli.ts" "$@"
