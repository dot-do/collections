import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config'

export default defineWorkersConfig({
  test: {
    name: 'e2e-workers',
    include: ['e2e/workers/**/*.test.ts'],
    testTimeout: 30000,
    hookTimeout: 30000,
    poolOptions: {
      workers: {
        wrangler: {
          configPath: './e2e/workers/wrangler.toml',
        },
        miniflare: {
          bindings: {
            DO_API_KEY: process.env['DO_API_KEY'] || '',
            COLLECTIONS_URL: process.env['COLLECTIONS_URL'] || 'https://collections.do',
          },
        },
      },
    },
  },
})
