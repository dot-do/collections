import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/index.ts', 'src/client.ts', 'src/types.ts', 'src/cli.ts'],
  format: ['esm'],
  dts: true,
  clean: true,
  sourcemap: true,
  treeshake: true,
  minify: true,
  external: [
    '@cloudflare/workers-types',
    '@dotdo/collections',
    '@dotdo/types',
    'hono',
    'hono/cors',
    'hono/cookie',
    'cloudflare:workers',
    'oauth.do',
    'oauth.do/hono',
    'jose',
  ],
  target: 'es2022',
})
