#!/bin/sh
# Plugin-context launcher for the keybridge CLI (setup/login/publish). Same
# bootstrap as keybridge-mcp.sh: a plugin install is a bare git clone, so
# install runtime deps once, then run the CLI on native TS (Node >= 22.18).
cd "$(dirname "$0")/.." || exit 1
[ -d node_modules ] || npm install --omit=dev --no-audit --no-fund --loglevel=error 1>&2
exec node src/cli.ts "$@"
