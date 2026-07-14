#!/usr/bin/env node
import { main } from '../src/mcp-server.js'

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
