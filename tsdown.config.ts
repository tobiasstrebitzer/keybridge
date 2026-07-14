import { defineConfig } from 'tsdown'

// Build src/ -> dist/ as ESM, preserving the module tree (unbundle) so that
// runtime path math survives: presenters/webkit.ts and setup.ts resolve the
// Swift sources via `join(HERE, '..', ..., 'native')`, which lands on the
// package root only if dist mirrors src (dist/presenters/webkit.mjs -> ../../ = root).
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
