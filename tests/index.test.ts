/**
 * Health Endpoint Tests
 *
 * Tests for the /health endpoint in the main Hono app.
 * The health endpoint should:
 * - Return 200 with { status: 'ok' }
 * - Not require authentication
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'

// Create a test app that mirrors the production app structure
const { Hono } = require('hono')

interface Env {
  AUTH: { fetch: (req: Request) => Promise<Response> }
  OAUTH: { fetch: (req: Request) => Promise<Response> }
}

/**
 * Import the actual app from the collections worker
 * We test against the real implementation to ensure the health endpoint works correctly
 */

describe('GET /health - Health endpoint', () => {
  // Mock service bindings
  let mockAuthService: { fetch: ReturnType<typeof vi.fn> }
  let mockOAuthService: { fetch: ReturnType<typeof vi.fn> }

  beforeEach(() => {
    mockAuthService = { fetch: vi.fn() }
    mockOAuthService = { fetch: vi.fn() }
  })

  /**
   * Create a test Hono app that mirrors the production middleware structure
   * This validates that /health is placed BEFORE auth middleware
   */
  function createTestApp() {
    const app = new Hono<{ Bindings: Env }>()

    // Health endpoint - should be BEFORE auth middleware
    app.get('/health', (c: any) => c.json({ status: 'ok' }))

    // Auth middleware (simplified - would normally reject unauthenticated requests)
    app.use('/*', async (c: any, next: () => Promise<void>) => {
      const path = c.req.path

      // Skip auth for public paths
      if (path === '/health') {
        return next()
      }

      // Simulate auth check - return 401 for unauthenticated
      const authHeader = c.req.header('Authorization')
      if (!authHeader) {
        return c.json({ error: 'Authentication required' }, 401)
      }

      return next()
    })

    // Protected route for testing
    app.get('/protected', (c: any) => c.json({ message: 'Access granted' }))

    return app
  }

  it('should return 200 with { status: "ok" }', async () => {
    const app = createTestApp()

    const request = new Request('https://collections.do/health', {
      method: 'GET',
    })

    const response = await app.fetch(request, {
      AUTH: mockAuthService,
      OAUTH: mockOAuthService,
    })

    expect(response.status).toBe(200)

    const body = await response.json()
    expect(body).toEqual({ status: 'ok' })
  })

  it('should not require authentication', async () => {
    const app = createTestApp()

    // Request WITHOUT any auth headers or cookies
    const request = new Request('https://collections.do/health', {
      method: 'GET',
      // No Authorization header, no cookies
    })

    const response = await app.fetch(request, {
      AUTH: mockAuthService,
      OAUTH: mockOAuthService,
    })

    // Should succeed without auth
    expect(response.status).toBe(200)

    const body = await response.json()
    expect(body).toEqual({ status: 'ok' })

    // Auth services should NOT be called for health endpoint
    expect(mockAuthService.fetch).not.toHaveBeenCalled()
    expect(mockOAuthService.fetch).not.toHaveBeenCalled()
  })

  it('should work while protected routes require auth', async () => {
    const app = createTestApp()

    // Health endpoint should work without auth
    const healthRequest = new Request('https://collections.do/health', {
      method: 'GET',
    })
    const healthResponse = await app.fetch(healthRequest, {
      AUTH: mockAuthService,
      OAUTH: mockOAuthService,
    })
    expect(healthResponse.status).toBe(200)

    // Protected route should require auth
    const protectedRequest = new Request('https://collections.do/protected', {
      method: 'GET',
    })
    const protectedResponse = await app.fetch(protectedRequest, {
      AUTH: mockAuthService,
      OAUTH: mockOAuthService,
    })
    expect(protectedResponse.status).toBe(401)
  })
})

/**
 * Integration test against the actual production app
 * This tests the real implementation in src/do.ts
 */
describe('GET /health - Integration with production app', () => {
  let mockAuthService: { fetch: ReturnType<typeof vi.fn> }
  let mockOAuthService: { fetch: ReturnType<typeof vi.fn> }
  let mockMcpService: { fetch: ReturnType<typeof vi.fn> }
  let mockCollectionsDO: any

  beforeEach(() => {
    mockAuthService = { fetch: vi.fn() }
    mockOAuthService = { fetch: vi.fn() }
    mockMcpService = { fetch: vi.fn() }
    mockCollectionsDO = {
      idFromName: vi.fn().mockReturnValue('mock-id'),
      idFromString: vi.fn().mockReturnValue('mock-id'),
      get: vi.fn().mockReturnValue({
        getInfo: vi.fn().mockResolvedValue({ doName: 'test', collections: [] }),
        listDocs: vi.fn().mockResolvedValue([]),
      }),
    }
  })

  it('should have /health endpoint that returns 200 with { status: "ok" }', async () => {
    // This test will fail until we add the /health route to src/do.ts
    // We're testing against the actual app to verify the implementation

    // Dynamic import to get the latest version
    const { default: CollectionsWorker } = await import('../src/do')

    // Create a minimal worker instance for testing
    const worker = new CollectionsWorker(
      { waitUntil: vi.fn() } as any,
      {
        COLLECTIONS: mockCollectionsDO,
        AUTH: mockAuthService,
        OAUTH: mockOAuthService,
        MCP: mockMcpService,
      }
    )

    const request = new Request('https://collections.do/health', {
      method: 'GET',
    })

    const response = await worker.fetch(request)

    expect(response.status).toBe(200)

    const body = await response.json()
    expect(body).toEqual({ status: 'ok' })
  })

  it('should not call auth services for /health', async () => {
    const { default: CollectionsWorker } = await import('../src/do')

    const worker = new CollectionsWorker(
      { waitUntil: vi.fn() } as any,
      {
        COLLECTIONS: mockCollectionsDO,
        AUTH: mockAuthService,
        OAUTH: mockOAuthService,
        MCP: mockMcpService,
      }
    )

    const request = new Request('https://collections.do/health', {
      method: 'GET',
    })

    await worker.fetch(request)

    // Auth services should NOT be called for health endpoint
    expect(mockAuthService.fetch).not.toHaveBeenCalled()
    expect(mockOAuthService.fetch).not.toHaveBeenCalled()
  })
})
