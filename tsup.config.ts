import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/index.ts', 'src/types.ts', 'src/memory.ts'],
  format: ['esm'],
  dts: true,
  clean: true,
  sourcemap: true,
  treeshake: true,
  minify: true,
  external: ['@cloudflare/workers-types'],
  target: 'es2022',
})
