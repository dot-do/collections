import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    name: 'e2e',
    include: ['e2e/**/*.test.ts'],
    exclude: ['e2e/workers/**'],
    testTimeout: 30000, // 30s timeout for network requests
    hookTimeout: 30000,
    // Run tests sequentially to avoid race conditions on shared namespace
    sequence: {
      concurrent: false,
    },
    // Retry failed tests once (network flakiness)
    retry: 1,
  },
})
