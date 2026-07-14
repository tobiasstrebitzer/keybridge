import { defineConfig } from 'tsdown'

// Build src/ -> dist/ as ESM, preserving the module tree (unbundle) so that
// runtime path math survives: presenters/chrome.ts resolves the v2 extension
// via `join(HERE, '..', '..', 'v2', 'extension')`, which lands on the package
// root only if dist mirrors src (dist/presenters/chrome.mjs -> ../../ = root).
// Dependencies (@silkweave/*, zod) stay external — this is a package, not a bundle.
export default defineConfig({
  entry: ['src/**/*.ts'],
  format: 'esm',
  outDir: 'dist',
  unbundle: true,
  dts: false,
  clean: true,
  outExtensions: () => ({ js: '.mjs' }),
})
