import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/index.ts', 'src/types.ts', 'src/memory.ts'],
  format: ['esm'],
  dts: true,
  clean: true,
  sourcemap: true,
  external: ['@cloudflare/workers-types', '@dotdo/types'],
})
