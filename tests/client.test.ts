/**
 * Client SDK Tests
 *
 * Tests for the Collections.do client SDK (RemoteCollection, Namespace, Collections)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Collections, CollectionsError, type CollectionsConfig } from '../src/client'

// ============================================================================
// Mock Fetch Setup
// ============================================================================

/**
 * Creates a mock fetch function that tracks requests and returns configured responses
 */
function createMockFetch(responses: Map<string, { status: number; body: unknown }>) {
  const calls: Array<{ url: string; options?: RequestInit }> = []

  const mockFetch = vi.fn(async (url: string | URL | Request, options?: RequestInit) => {
    const urlString = url.toString()
    calls.push({ url: urlString, options })

    // Find matching response (partial URL match)
    for (const [pattern, response] of responses.entries()) {
      if (urlString.includes(pattern)) {
        return {
          ok: response.status >= 200 && response.status < 300,
          status: response.status,
          statusText: response.status === 200 ? 'OK' : 'Error',
          json: async () => response.body,
        } as Response
      }
    }

    // Default 404 response
    return {
      ok: false,
      status: 404,
      statusText: 'Not Found',
      json: async () => ({ error: 'Not found' }),
    } as Response
  })

  return { mockFetch, calls }
}

// ============================================================================
// Test Types
// ============================================================================

interface User {
  name: string
  email: string
  age?: number
}

// ============================================================================
// URL Building Tests
// ============================================================================

describe('URL Building', () => {
  it('should build namespace subdomain URL correctly', () => {
    const responses = new Map([['myapp.collections.do/users', { status: 200, body: { count: 0 } }]])
    const { mockFetch, calls } = createMockFetch(responses)

    const collections = new Collections({
      baseUrl: 'https://collections.do',
      fetch: mockFetch,
    })

    const users = collections.namespace('myapp').collection<User>('users')
    users.count()

    expect(calls[0].url).toBe('https://myapp.collections.do/users')
  })

  it('should handle base URL with trailing slash', () => {
    const responses = new Map([['test.collections.do/items', { status: 200, body: { count: 5 } }]])
    const { mockFetch, calls } = createMockFetch(responses)

    const collections = new Collections({
      baseUrl: 'https://collections.do/',
      fetch: mockFetch,
    })

    collections.namespace('test').collection('items').count()

    expect(calls[0].url).toBe('https://test.collections.do/items')
  })

  it('should build document URL with ID correctly', async () => {
    const responses = new Map([
      ['myapp.collections.do/users/user123', { status: 200, body: { $id: 'url', id: 'user123', name: 'Alice' } }],
    ])
    const { mockFetch, calls } = createMockFetch(responses)

    const collections = new Collections({
      baseUrl: 'https://collections.do',
      fetch: mockFetch,
    })

    await collections.namespace('myapp').collection<User>('users').get('user123')

    expect(calls[0].url).toBe('https://myapp.collections.do/users/user123')
  })

  it('should build query URL correctly', async () => {
    const responses = new Map([['myapp.collections.do/users/query', { status: 200, body: { docs: [] } }]])
    const { mockFetch, calls } = createMockFetch(responses)

    const collections = new Collections({
      baseUrl: 'https://collections.do',
      fetch: mockFetch,
    })

    await collections.namespace('myapp').collection<User>('users').find({ name: 'Alice' })

    expect(calls[0].url).toBe('https://myapp.collections.do/users/query')
  })

  it('should use default base URL when not provided', async () => {
    const responses = new Map([['default.collections.do/test', { status: 200, body: { count: 0 } }]])
    const { mockFetch, calls } = createMockFetch(responses)

    const collections = new Collections({ fetch: mockFetch })
    await collections.namespace('default').collection('test').count()

    expect(calls[0].url).toBe('https://default.collections.do/test')
  })
})

// ============================================================================
// Response Parsing Tests
// ============================================================================

describe('Response Parsing', () => {
  describe('get()', () => {
    it('should strip $id from response', async () => {
      const responses = new Map([
        [
          'ns.collections.do/users/u1',
          { status: 200, body: { $id: 'https://ns.collections.do/users/u1', id: 'u1', name: 'Alice', email: 'alice@test.com' } },
        ],
      ])
      const { mockFetch } = createMockFetch(responses)

      const collections = new Collections({ baseUrl: 'https://collections.do', fetch: mockFetch })
      const user = await collections.namespace('ns').collection<User>('users').get('u1')

      expect(user).toEqual({ name: 'Alice', email: 'alice@test.com' })
      expect(user).not.toHaveProperty('$id')
      expect(user).not.toHaveProperty('id')
    })

    it('should return null when document not found', async () => {
      const responses = new Map([['ns.collections.do/users/missing', { status: 404, body: { error: 'Not found' } }]])
      const { mockFetch } = createMockFetch(responses)

      const collections = new Collections({ baseUrl: 'https://collections.do', fetch: mockFetch })
      const user = await collections.namespace('ns').collection<User>('users').get('missing')

      expect(user).toBeNull()
    })
  })

  describe('list()', () => {
    it('should strip $id from all documents in list', async () => {
      const responses = new Map([
        [
          'ns.collections.do/users',
          {
            status: 200,
            body: {
              docs: [
                { $id: 'https://ns.collections.do/users/u1', name: 'Alice', email: 'a@test.com' },
                { $id: 'https://ns.collections.do/users/u2', name: 'Bob', email: 'b@test.com' },
              ],
            },
          },
        ],
      ])
      const { mockFetch } = createMockFetch(responses)

      const collections = new Collections({ baseUrl: 'https://collections.do', fetch: mockFetch })
      const users = await collections.namespace('ns').collection<User>('users').list()

      expect(users).toHaveLength(2)
      expect(users[0]).toEqual({ name: 'Alice', email: 'a@test.com' })
      expect(users[1]).toEqual({ name: 'Bob', email: 'b@test.com' })
      users.forEach((u) => {
        expect(u).not.toHaveProperty('$id')
      })
    })

    it('should pass query params for pagination', async () => {
      const responses = new Map([['ns.collections.do/users', { status: 200, body: { docs: [] } }]])
      const { mockFetch, calls } = createMockFetch(responses)

      const collections = new Collections({ baseUrl: 'https://collections.do', fetch: mockFetch })
      await collections.namespace('ns').collection<User>('users').list({ limit: 10, offset: 20 })

      expect(calls[0].url).toContain('limit=10')
      expect(calls[0].url).toContain('offset=20')
    })

    it('should pass sort parameter correctly', async () => {
      const responses = new Map([['ns.collections.do/users', { status: 200, body: { docs: [] } }]])
      const { mockFetch, calls } = createMockFetch(responses)

      const collections = new Collections({ baseUrl: 'https://collections.do', fetch: mockFetch })
      await collections.namespace('ns').collection<User>('users').list({
        sort: [
          { field: 'name', order: 'asc' },
          { field: 'age', order: 'desc' },
        ],
      })

      expect(calls[0].url).toContain('sort=name%2C-age')
    })

    it('should handle string sort parameter', async () => {
      const responses = new Map([['ns.collections.do/users', { status: 200, body: { docs: [] } }]])
      const { mockFetch, calls } = createMockFetch(responses)

      const collections = new Collections({ baseUrl: 'https://collections.do', fetch: mockFetch })
      await collections.namespace('ns').collection<User>('users').list({ sort: '-createdAt' })

      expect(calls[0].url).toContain('sort=-createdAt')
    })
  })

  describe('find()', () => {
    it('should strip $id from find results', async () => {
      const responses = new Map([
        [
          'ns.collections.do/users/query',
          {
            status: 200,
            body: {
              docs: [{ $id: 'https://ns.collections.do/users/u1', name: 'Alice', email: 'a@test.com' }],
            },
          },
        ],
      ])
      const { mockFetch } = createMockFetch(responses)

      const collections = new Collections({ baseUrl: 'https://collections.do', fetch: mockFetch })
      const users = await collections.namespace('ns').collection<User>('users').find({ name: 'Alice' })

      expect(users).toHaveLength(1)
      expect(users[0]).toEqual({ name: 'Alice', email: 'a@test.com' })
      expect(users[0]).not.toHaveProperty('$id')
    })

    it('should send filter in POST body', async () => {
      const responses = new Map([['ns.collections.do/users/query', { status: 200, body: { docs: [] } }]])
      const { mockFetch, calls } = createMockFetch(responses)

      const collections = new Collections({ baseUrl: 'https://collections.do', fetch: mockFetch })
      await collections.namespace('ns').collection<User>('users').find({ age: { $gt: 21 } })

      expect(calls[0].options?.method).toBe('POST')
      expect(JSON.parse(calls[0].options?.body as string)).toEqual({ filter: { age: { $gt: 21 } } })
    })
  })

  describe('keys()', () => {
    it('should extract IDs from id field', async () => {
      const responses = new Map([
        [
          'ns.collections.do/users',
          {
            status: 200,
            body: {
              docs: [
                { $id: 'https://ns.collections.do/users/u1', id: 'u1' },
                { $id: 'https://ns.collections.do/users/u2', id: 'u2' },
              ],
            },
          },
        ],
      ])
      const { mockFetch } = createMockFetch(responses)

      const collections = new Collections({ baseUrl: 'https://collections.do', fetch: mockFetch })
      const keys = await collections.namespace('ns').collection<User>('users').keys()

      expect(keys).toEqual(['u1', 'u2'])
    })

    it('should extract IDs from $id URL when id field missing', async () => {
      const responses = new Map([
        [
          'ns.collections.do/users',
          {
            status: 200,
            body: {
              docs: [{ $id: 'https://ns.collections.do/users/user-one' }, { $id: 'https://ns.collections.do/users/user-two' }],
            },
          },
        ],
      ])
      const { mockFetch } = createMockFetch(responses)

      const collections = new Collections({ baseUrl: 'https://collections.do', fetch: mockFetch })
      const keys = await collections.namespace('ns').collection<User>('users').keys()

      expect(keys).toEqual(['user-one', 'user-two'])
    })

    it('should filter out undefined IDs from keys', async () => {
      const responses = new Map([
        [
          'ns.collections.do/users',
          {
            status: 200,
            body: {
              docs: [
                { $id: 'https://ns.collections.do/users/u1', id: 'u1' },
                { $id: 'https://ns.collections.do/users/undefined' }, // Server bug case
                { id: 'u3' },
              ],
            },
          },
        ],
      ])
      const { mockFetch } = createMockFetch(responses)

      const collections = new Collections({ baseUrl: 'https://collections.do', fetch: mockFetch })
      const keys = await collections.namespace('ns').collection<User>('users').keys()

      expect(keys).toEqual(['u1', 'u3'])
    })
  })

  describe('count()', () => {
    it('should return count from response', async () => {
      const responses = new Map([['ns.collections.do/users', { status: 200, body: { count: 42 } }]])
      const { mockFetch } = createMockFetch(responses)

      const collections = new Collections({ baseUrl: 'https://collections.do', fetch: mockFetch })
      const count = await collections.namespace('ns').collection<User>('users').count()

      expect(count).toBe(42)
    })

    it('should POST to /query with filter for filtered count', async () => {
      const responses = new Map([['ns.collections.do/users/query', { status: 200, body: { count: 5 } }]])
      const { mockFetch, calls } = createMockFetch(responses)

      const collections = new Collections({ baseUrl: 'https://collections.do', fetch: mockFetch })
      const count = await collections.namespace('ns').collection<User>('users').count({ age: { $gte: 21 } })

      expect(count).toBe(5)
      expect(calls[0].options?.method).toBe('POST')
      expect(JSON.parse(calls[0].options?.body as string)).toEqual({ filter: { age: { $gte: 21 } }, limit: 0 })
    })
  })
})

// ============================================================================
// Error Handling Tests
// ============================================================================

describe('Error Handling', () => {
  it('should throw on non-ok response for put()', async () => {
    const responses = new Map([['ns.collections.do/users/u1', { status: 500, body: { error: 'Internal server error' } }]])
    const { mockFetch } = createMockFetch(responses)

    const collections = new Collections({ baseUrl: 'https://collections.do', fetch: mockFetch })
    const users = collections.namespace('ns').collection<User>('users')

    await expect(users.put('u1', { name: 'Alice', email: 'a@test.com' })).rejects.toThrow('Internal server error')
  })

  it('should throw on non-ok response for find()', async () => {
    const responses = new Map([['ns.collections.do/users/query', { status: 400, body: { error: 'Invalid filter' } }]])
    const { mockFetch } = createMockFetch(responses)

    const collections = new Collections({ baseUrl: 'https://collections.do', fetch: mockFetch })
    const users = collections.namespace('ns').collection<User>('users')

    await expect(users.find({ invalid: 'filter' } as any)).rejects.toThrow('Invalid filter')
  })

  it('should throw on non-ok response for list()', async () => {
    const responses = new Map([['ns.collections.do/users', { status: 503, body: { error: 'Service unavailable' } }]])
    const { mockFetch } = createMockFetch(responses)

    const collections = new Collections({ baseUrl: 'https://collections.do', fetch: mockFetch })
    const users = collections.namespace('ns').collection<User>('users')

    await expect(users.list()).rejects.toThrow('Service unavailable')
  })

  it('should handle error response without error field', async () => {
    const responses = new Map([['ns.collections.do/users', { status: 500, body: {} }]])
    const { mockFetch } = createMockFetch(responses)

    const collections = new Collections({ baseUrl: 'https://collections.do', fetch: mockFetch })
    const users = collections.namespace('ns').collection<User>('users')

    await expect(users.list()).rejects.toThrow('Request failed')
  })

  it('should throw "Authentication required" for me() on non-ok response', async () => {
    const responses = new Map([['collections.do/me', { status: 401, body: { error: 'Unauthorized' } }]])
    const { mockFetch } = createMockFetch(responses)

    const collections = new Collections({ baseUrl: 'https://collections.do', fetch: mockFetch })

    await expect(collections.me()).rejects.toThrow('Authentication required')
  })

  it('should throw CollectionsError with status code preserved', async () => {
    const responses = new Map([['ns.collections.do/users', { status: 403, body: { error: 'Forbidden' } }]])
    const { mockFetch } = createMockFetch(responses)

    const collections = new Collections({ baseUrl: 'https://collections.do', fetch: mockFetch })
    const users = collections.namespace('ns').collection<User>('users')

    try {
      await users.list()
      expect.fail('Should have thrown')
    } catch (error) {
      expect(error).toBeInstanceOf(CollectionsError)
      expect((error as CollectionsError).status).toBe(403)
      expect((error as CollectionsError).message).toBe('Forbidden')
      expect((error as CollectionsError).name).toBe('CollectionsError')
    }
  })

  it('should include error details in CollectionsError', async () => {
    const responses = new Map([
      ['ns.collections.do/users', { status: 422, body: { error: 'Validation failed', details: { field: 'name' } } }],
    ])
    const { mockFetch } = createMockFetch(responses)

    const collections = new Collections({ baseUrl: 'https://collections.do', fetch: mockFetch })
    const users = collections.namespace('ns').collection<User>('users')

    try {
      await users.list()
      expect.fail('Should have thrown')
    } catch (error) {
      expect(error).toBeInstanceOf(CollectionsError)
      expect((error as CollectionsError).status).toBe(422)
      expect((error as CollectionsError).details).toEqual({ error: 'Validation failed', details: { field: 'name' } })
    }
  })
})

// ============================================================================
// Authentication Header Tests
// ============================================================================

describe('Authentication Headers', () => {
  it('should include Authorization header when token provided', async () => {
    const responses = new Map([['ns.collections.do/users', { status: 200, body: { count: 0 } }]])
    const { mockFetch, calls } = createMockFetch(responses)

    const collections = new Collections({
      baseUrl: 'https://collections.do',
      token: 'my-oauth-token',
      fetch: mockFetch,
    })

    await collections.namespace('ns').collection<User>('users').count()

    expect(calls[0].options?.headers).toHaveProperty('Authorization', 'Bearer my-oauth-token')
  })

  it('should not include Authorization header when no token', async () => {
    const responses = new Map([['ns.collections.do/users', { status: 200, body: { count: 0 } }]])
    const { mockFetch, calls } = createMockFetch(responses)

    const collections = new Collections({
      baseUrl: 'https://collections.do',
      fetch: mockFetch,
    })

    await collections.namespace('ns').collection<User>('users').count()

    expect(calls[0].options?.headers).not.toHaveProperty('Authorization')
  })

  it('should include Content-Type header for all requests', async () => {
    const responses = new Map([['ns.collections.do/users', { status: 200, body: { count: 0 } }]])
    const { mockFetch, calls } = createMockFetch(responses)

    const collections = new Collections({
      baseUrl: 'https://collections.do',
      fetch: mockFetch,
    })

    await collections.namespace('ns').collection<User>('users').count()

    expect(calls[0].options?.headers).toHaveProperty('Content-Type', 'application/json')
  })

  it('should include Authorization header for me() request', async () => {
    const responses = new Map([['collections.do/me', { status: 200, body: { user: { id: 'u1', email: 'test@test.com' } } }]])
    const { mockFetch, calls } = createMockFetch(responses)

    const collections = new Collections({
      baseUrl: 'https://collections.do',
      token: 'test-token',
      fetch: mockFetch,
    })

    await collections.me()

    expect(calls[0].options?.headers).toHaveProperty('Authorization', 'Bearer test-token')
  })
})

// ============================================================================
// RemoteCollection Method Tests
// ============================================================================

describe('RemoteCollection Methods', () => {
  describe('get()', () => {
    it('should make GET request to correct URL', async () => {
      const responses = new Map([
        ['ns.collections.do/users/user123', { status: 200, body: { $id: 'url', id: 'user123', name: 'Test' } }],
      ])
      const { mockFetch, calls } = createMockFetch(responses)

      const collections = new Collections({ baseUrl: 'https://collections.do', fetch: mockFetch })
      await collections.namespace('ns').collection<User>('users').get('user123')

      expect(calls[0].url).toBe('https://ns.collections.do/users/user123')
      expect(calls[0].options?.method).toBeUndefined() // GET is default
    })
  })

  describe('getMany()', () => {
    it('should fetch all documents in parallel', async () => {
      const responses = new Map([
        ['ns.collections.do/users/u1', { status: 200, body: { $id: 'url', id: 'u1', name: 'Alice', email: 'a@test.com' } }],
        ['ns.collections.do/users/u2', { status: 200, body: { $id: 'url', id: 'u2', name: 'Bob', email: 'b@test.com' } }],
        ['ns.collections.do/users/u3', { status: 404, body: { error: 'Not found' } }],
      ])
      const { mockFetch, calls } = createMockFetch(responses)

      const collections = new Collections({ baseUrl: 'https://collections.do', fetch: mockFetch })
      const results = await collections.namespace('ns').collection<User>('users').getMany(['u1', 'u2', 'u3'])

      expect(calls).toHaveLength(3)
      expect(results).toHaveLength(3)
      expect(results[0]).toEqual({ name: 'Alice', email: 'a@test.com' })
      expect(results[1]).toEqual({ name: 'Bob', email: 'b@test.com' })
      expect(results[2]).toBeNull()
    })
  })

  describe('has()', () => {
    it('should return true when document exists', async () => {
      const responses = new Map([['ns.collections.do/users/u1', { status: 200, body: { $id: 'url', id: 'u1', name: 'Alice' } }]])
      const { mockFetch } = createMockFetch(responses)

      const collections = new Collections({ baseUrl: 'https://collections.do', fetch: mockFetch })
      const exists = await collections.namespace('ns').collection<User>('users').has('u1')

      expect(exists).toBe(true)
    })

    it('should return false when document does not exist', async () => {
      const responses = new Map([['ns.collections.do/users/missing', { status: 404, body: { error: 'Not found' } }]])
      const { mockFetch } = createMockFetch(responses)

      const collections = new Collections({ baseUrl: 'https://collections.do', fetch: mockFetch })
      const exists = await collections.namespace('ns').collection<User>('users').has('missing')

      expect(exists).toBe(false)
    })
  })

  describe('put()', () => {
    it('should make PUT request with document body', async () => {
      const responses = new Map([['ns.collections.do/users/u1', { status: 200, body: { success: true } }]])
      const { mockFetch, calls } = createMockFetch(responses)

      const collections = new Collections({ baseUrl: 'https://collections.do', fetch: mockFetch })
      await collections.namespace('ns').collection<User>('users').put('u1', { name: 'Alice', email: 'a@test.com' })

      expect(calls[0].url).toBe('https://ns.collections.do/users/u1')
      expect(calls[0].options?.method).toBe('PUT')
      expect(JSON.parse(calls[0].options?.body as string)).toEqual({ name: 'Alice', email: 'a@test.com' })
    })
  })

  describe('putMany()', () => {
    it('should put all documents sequentially', async () => {
      const responses = new Map([
        ['ns.collections.do/users/u1', { status: 200, body: { success: true } }],
        ['ns.collections.do/users/u2', { status: 200, body: { success: true } }],
      ])
      const { mockFetch, calls } = createMockFetch(responses)

      const collections = new Collections({ baseUrl: 'https://collections.do', fetch: mockFetch })
      const result = await collections.namespace('ns').collection<User>('users').putMany([
        { id: 'u1', doc: { name: 'Alice', email: 'a@test.com' } },
        { id: 'u2', doc: { name: 'Bob', email: 'b@test.com' } },
      ])

      expect(calls).toHaveLength(2)
      expect(result).toEqual({ count: 2, success: true })
    })
  })

  describe('delete()', () => {
    it('should make DELETE request and return true on success', async () => {
      const responses = new Map([['ns.collections.do/users/u1', { status: 200, body: { success: true } }]])
      const { mockFetch, calls } = createMockFetch(responses)

      const collections = new Collections({ baseUrl: 'https://collections.do', fetch: mockFetch })
      const result = await collections.namespace('ns').collection<User>('users').delete('u1')

      expect(calls[0].url).toBe('https://ns.collections.do/users/u1')
      expect(calls[0].options?.method).toBe('DELETE')
      expect(result).toBe(true)
    })

    it('should return false when delete fails', async () => {
      const responses = new Map([['ns.collections.do/users/missing', { status: 404, body: { error: 'Not found' } }]])
      const { mockFetch } = createMockFetch(responses)

      const collections = new Collections({ baseUrl: 'https://collections.do', fetch: mockFetch })
      const result = await collections.namespace('ns').collection<User>('users').delete('missing')

      expect(result).toBe(false)
    })
  })

  describe('deleteMany()', () => {
    it('should delete all documents and return count', async () => {
      const responses = new Map([
        ['ns.collections.do/users/u1', { status: 200, body: { success: true } }],
        ['ns.collections.do/users/u2', { status: 200, body: { success: true } }],
        ['ns.collections.do/users/u3', { status: 404, body: { error: 'Not found' } }],
      ])
      const { mockFetch, calls } = createMockFetch(responses)

      const collections = new Collections({ baseUrl: 'https://collections.do', fetch: mockFetch })
      const result = await collections.namespace('ns').collection<User>('users').deleteMany(['u1', 'u2', 'u3'])

      expect(calls).toHaveLength(3)
      expect(result).toEqual({ count: 2, success: true })
    })
  })

  describe('clear()', () => {
    it('should make DELETE request to collection root', async () => {
      const responses = new Map([['ns.collections.do/users', { status: 200, body: { cleared: 10 } }]])
      const { mockFetch, calls } = createMockFetch(responses)

      const collections = new Collections({ baseUrl: 'https://collections.do', fetch: mockFetch })
      const result = await collections.namespace('ns').collection<User>('users').clear()

      expect(calls[0].url).toBe('https://ns.collections.do/users')
      expect(calls[0].options?.method).toBe('DELETE')
      expect(result).toEqual({ count: 10, success: true })
    })
  })

  describe('query()', () => {
    it('should call find() with the same arguments', async () => {
      const responses = new Map([
        [
          'ns.collections.do/users/query',
          {
            status: 200,
            body: { docs: [{ $id: 'url', name: 'Alice', email: 'a@test.com' }] },
          },
        ],
      ])
      const { mockFetch, calls } = createMockFetch(responses)

      const collections = new Collections({ baseUrl: 'https://collections.do', fetch: mockFetch })
      const users = collections.namespace('ns').collection<User>('users')

      const results = await users.query({ name: 'Alice' }, { limit: 10 })

      expect(calls[0].options?.method).toBe('POST')
      expect(JSON.parse(calls[0].options?.body as string)).toEqual({ filter: { name: 'Alice' }, limit: 10 })
      expect(results).toHaveLength(1)
    })
  })
})

// ============================================================================
// Namespace Tests
// ============================================================================

describe('Namespace', () => {
  it('should create collection with correct namespace', async () => {
    const responses = new Map([['myns.collections.do/tasks', { status: 200, body: { count: 0 } }]])
    const { mockFetch, calls } = createMockFetch(responses)

    const collections = new Collections({ baseUrl: 'https://collections.do', fetch: mockFetch })
    const ns = collections.namespace('myns')
    const tasks = ns.collection('tasks')

    await tasks.count()

    expect(calls[0].url).toBe('https://myns.collections.do/tasks')
  })

  it('should list collections in namespace', async () => {
    const responses = new Map([['myns.collections.do', { status: 200, body: { collections: ['users', 'tasks', 'projects'] } }]])
    const { mockFetch, calls } = createMockFetch(responses)

    const collections = new Collections({ baseUrl: 'https://collections.do', fetch: mockFetch })
    const ns = collections.namespace('myns')

    const collectionNames = await ns.listCollections()

    expect(calls[0].url).toBe('https://myns.collections.do')
    expect(collectionNames).toEqual(['users', 'tasks', 'projects'])
  })
})

// ============================================================================
// Collections Class Tests
// ============================================================================

describe('Collections Class', () => {
  it('should fetch user info via me()', async () => {
    const responses = new Map([
      ['collections.do/me', { status: 200, body: { user: { id: 'user123', email: 'test@test.com', name: 'Test User' } } }],
    ])
    const { mockFetch, calls } = createMockFetch(responses)

    const collections = new Collections({
      baseUrl: 'https://collections.do',
      token: 'test-token',
      fetch: mockFetch,
    })

    const result = await collections.me()

    expect(calls[0].url).toBe('https://collections.do/me')
    expect(result).toEqual({
      user: { id: 'user123', email: 'test@test.com', name: 'Test User' },
    })
  })

  it('should provide shortcut collection() method', async () => {
    const responses = new Map([['myns.collections.do/users', { status: 200, body: { count: 5 } }]])
    const { mockFetch, calls } = createMockFetch(responses)

    const collections = new Collections({ baseUrl: 'https://collections.do', fetch: mockFetch })

    // Using shortcut: collections.collection(namespace, collection)
    const count = await collections.collection<User>('myns', 'users').count()

    expect(calls[0].url).toBe('https://myns.collections.do/users')
    expect(count).toBe(5)
  })
})
