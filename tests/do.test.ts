/**
 * CollectionsDO HTTP Handler Tests
 *
 * Tests for the CollectionsDO class HTTP fetch handler.
 * Uses sql.js to simulate real SQLite - NO MOCKS for core collection logic.
 */

import { describe, it, expect, beforeEach, afterEach, beforeAll, vi } from 'vitest'
import initSqlJs, { type Database } from 'sql.js'

// ============================================================================
// sql.js Mock SqlStorage Implementation
// ============================================================================

// sql.js instance (loaded once)
let SQL: Awaited<ReturnType<typeof initSqlJs>>

// Schema for _collections table (from @dotdo/collections)
const COLLECTIONS_SCHEMA = `
  CREATE TABLE IF NOT EXISTS _collections (
    collection TEXT NOT NULL,
    id TEXT NOT NULL,
    data TEXT NOT NULL,
    created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    PRIMARY KEY (collection, id)
  );
  CREATE INDEX IF NOT EXISTS _collections_collection ON _collections(collection);
  CREATE INDEX IF NOT EXISTS _collections_updated ON _collections(collection, updated_at);
`

// DO metadata table schema
const METADATA_SCHEMA = `
  CREATE TABLE IF NOT EXISTS _do_metadata (key TEXT PRIMARY KEY, value TEXT)
`

/**
 * Mock SqlStorage that wraps sql.js to simulate Cloudflare Workers SQLite API
 */
class MockSqlStorage {
  private db: Database
  private regexpInstalled = false

  constructor(db: Database) {
    this.db = db
    // Initialize the schema immediately
    this.initSchema()
  }

  private initSchema(): void {
    // Execute each statement separately since sql.js doesn't handle multi-statement well
    const statements = COLLECTIONS_SCHEMA.split(';')
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
    for (const stmt of statements) {
      this.db.run(stmt)
    }
    // Also create metadata table
    this.db.run(METADATA_SCHEMA)
  }

  /**
   * Execute SQL and return a cursor-like object
   */
  exec<T = Record<string, unknown>>(query: string, ...params: unknown[]): SqlCursor<T> {
    // Install REGEXP function if needed and not already installed
    if (query.includes('REGEXP') && !this.regexpInstalled) {
      this.db.create_function('regexp', (pattern: string, value: string) => {
        if (value === null || value === undefined) return 0
        try {
          const regex = new RegExp(pattern as string)
          return regex.test(String(value)) ? 1 : 0
        } catch {
          return 0
        }
      })
      this.regexpInstalled = true
    }

    // Handle multi-statement queries (for schema creation) - skip since we init manually
    if (
      query.includes(';') &&
      query
        .trim()
        .split(';')
        .filter((s) => s.trim()).length > 1
    ) {
      // Schema already initialized, just return empty cursor
      return new SqlCursor<T>([], 0, 0)
    }

    const isWrite = /^\s*(INSERT|UPDATE|DELETE|CREATE|DROP|ALTER)/i.test(query)

    // Convert params to the format sql.js expects
    const bindParams = params.map((p) => {
      if (p === undefined) return null
      return p
    })

    if (isWrite) {
      this.db.run(query, bindParams)
      const changes = this.db.getRowsModified()
      return new SqlCursor<T>([], 0, changes)
    } else {
      const stmt = this.db.prepare(query)
      stmt.bind(bindParams)
      const rows: T[] = []
      while (stmt.step()) {
        const row = stmt.getAsObject() as T
        rows.push(row)
      }
      stmt.free()
      return new SqlCursor<T>(rows, rows.length, 0)
    }
  }

  close(): void {
    this.db.close()
  }
}

/**
 * Mock SQL cursor that mimics Cloudflare's SqlStorageCursor
 */
class SqlCursor<T> {
  private rows: T[]
  readonly rowsRead: number
  readonly rowsWritten: number

  constructor(rows: T[], rowsRead: number, rowsWritten: number) {
    this.rows = rows
    this.rowsRead = rowsRead
    this.rowsWritten = rowsWritten
  }

  one(): T | null {
    return this.rows[0] ?? null
  }

  toArray(): T[] {
    return this.rows
  }

  *[Symbol.iterator](): Iterator<T> {
    for (const row of this.rows) {
      yield row
    }
  }
}

// ============================================================================
// Mock CollectionsDO class for testing HTTP handler
// ============================================================================

/**
 * We need to import the actual collection functions but simulate the DO class.
 * Since the real CollectionsDO depends on Cloudflare Workers runtime, we create
 * a test version that uses the same HTTP handler logic.
 */
import { createCollection, initCollectionsSchema } from '@dotdo/collections'
import type { SyncCollection } from '@dotdo/collections/types'

// Maximum request body size (1MB) - must match src/do.ts
const MAX_BODY_SIZE = 1024 * 1024

/**
 * Test version of CollectionsDO that can be run outside Cloudflare Workers
 */
class TestCollectionsDO {
  private sql: SqlStorage
  private collections = new Map<string, SyncCollection<Record<string, unknown>>>()
  private _doName: string | null = null

  constructor(sql: SqlStorage) {
    this.sql = sql
    try {
      initCollectionsSchema(this.sql)
      // Create metadata table for DO identity
      this.sql.exec(`CREATE TABLE IF NOT EXISTS _do_metadata (key TEXT PRIMARY KEY, value TEXT)`)
      // Load stored DO name
      const row = this.sql.exec<{ value: string }>(`SELECT value FROM _do_metadata WHERE key = 'doName'`).toArray()[0]
      if (row) this._doName = row.value
    } catch (e) {
      console.error('Failed to initialize schema:', e)
    }
  }

  private getCollection<T extends Record<string, unknown>>(name: string): SyncCollection<T> {
    let col = this.collections.get(name)
    if (!col) {
      col = createCollection<T>(this.sql, name)
      this.collections.set(name, col as SyncCollection<Record<string, unknown>>)
    }
    return col as SyncCollection<T>
  }

  /** Get or set the DO's name for identification */
  setName(name: string): void {
    if (!this._doName) {
      this._doName = name
      this.sql.exec(`INSERT OR REPLACE INTO _do_metadata (key, value) VALUES ('doName', ?)`, name)
    }
  }

  getName(): string | null {
    return this._doName
  }

  /** Get DO info including all collections */
  getInfo(): { doName: string | null; collections: string[] } {
    const rows = this.sql
      .exec<{ collection: string }>('SELECT DISTINCT collection FROM _collections ORDER BY collection')
      .toArray()
    return {
      doName: this._doName,
      collections: rows.map(r => r.collection),
    }
  }

  /** Get a document */
  getDoc(collection: string, id: string): Record<string, unknown> | null {
    return this.getCollection(collection).get(id) || null
  }

  /** Put a document */
  putDoc(collection: string, id: string, doc: Record<string, unknown>): Record<string, unknown> {
    this.getCollection(collection).put(id, doc)
    return { id, ...doc }
  }

  /** Delete a document */
  deleteDoc(collection: string, id: string): boolean {
    return this.getCollection(collection).delete(id)
  }

  /** List documents in a collection */
  listDocs(collection: string, options?: { limit?: number; offset?: number }): Record<string, unknown>[] {
    return this.getCollection(collection).list(options || {})
  }

  /** Find documents with filter */
  findDocs(collection: string, filter?: Record<string, unknown>, options?: { limit?: number; offset?: number }): Record<string, unknown>[] {
    return this.getCollection(collection).find(filter, options)
  }

  /** Count documents */
  countDocs(collection: string, filter?: Record<string, unknown>): number {
    return this.getCollection(collection).count(filter)
  }

  /** Clear a collection */
  clearCollection(collection: string): number {
    return this.getCollection(collection).clear()
  }

  /**
   * Validate pagination query parameters from URL search params
   * Returns validated { limit, offset } or a 400 error Response
   */
  private validatePagination(url: URL): { limit: number; offset: number } | Response {
    const limitStr = url.searchParams.get('limit')
    const offsetStr = url.searchParams.get('offset')

    const limit = limitStr ? parseInt(limitStr, 10) : 100
    const offset = offsetStr ? parseInt(offsetStr, 10) : 0

    if (isNaN(limit) || limit < 1 || limit > 10000) {
      return Response.json({ error: 'limit must be a positive integer between 1 and 10000' }, { status: 400 })
    }

    if (isNaN(offset) || offset < 0) {
      return Response.json({ error: 'offset must be a non-negative integer' }, { status: 400 })
    }

    return { limit, offset }
  }

  /**
   * Parse JSON body from request with error handling
   * Returns parsed body, 413 for too large, or 400 for invalid JSON
   */
  private async parseJsonBody<T>(request: Request): Promise<T | Response> {
    const contentLength = parseInt(request.headers.get('content-length') || '0', 10)
    if (contentLength > MAX_BODY_SIZE) {
      return Response.json({ error: 'Request body too large' }, { status: 413 })
    }
    try {
      return await request.json() as T
    } catch {
      return Response.json({ error: 'Invalid JSON body' }, { status: 400 })
    }
  }

  /**
   * HTTP fetch handler - replicates the logic from src/do.ts
   */
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    const path = url.pathname
    const method = request.method
    const namespace = request.headers.get('X-Namespace') || 'unknown'
    const doName = request.headers.get('X-DO-Name')
    // Use explicit base URL if provided, otherwise build from namespace
    const baseUrl = request.headers.get('X-Base-Url') || `https://${namespace}.collections.do`

    // Save DO name if provided and not yet set
    if (doName && !this._doName) {
      this.setName(doName)
    }

    // Route: GET /
    if (path === '/' && method === 'GET') {
      const info = this.getInfo()
      return Response.json({
        $id: baseUrl,
        doName: info.doName,
        namespace,
        collections: info.collections.map(name => ({ $id: `${baseUrl}/${name}`, name })),
      })
    }

    // Route: GET /:collection
    const collectionMatch = path.match(/^\/([^/]+)$/)
    if (collectionMatch && method === 'GET') {
      const collection = collectionMatch[1]!

      // Validate pagination parameters
      const pagination = this.validatePagination(url)
      if (pagination instanceof Response) return pagination
      const { limit, offset } = pagination

      const docs = this.listDocs(collection, { limit, offset })
      return Response.json({
        $id: `${baseUrl}/${collection}`,
        collection,
        count: this.countDocs(collection),
        // Ensure each doc has 'id' field - extract from doc or use the id property
        docs: docs.map(doc => {
          const docId = (doc as { id?: string }).id
          return { $id: `${baseUrl}/${collection}/${docId}`, ...doc }
        }),
      })
    }

    // Route: GET /:collection/:id
    const docMatch = path.match(/^\/([^/]+)\/([^/]+)$/)
    if (docMatch && method === 'GET') {
      const [, collection, id] = docMatch
      const doc = this.getDoc(collection!, id!)
      if (!doc) return Response.json({ error: 'Not found' }, { status: 404 })
      return Response.json({ $id: `${baseUrl}/${collection}/${id}`, id, ...doc })
    }

    // Route: PUT /:collection/:id
    if (docMatch && method === 'PUT') {
      const [, collection, id] = docMatch
      const parsed = await this.parseJsonBody<Record<string, unknown>>(request)
      if (parsed instanceof Response) return parsed
      const doc = parsed
      if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
        return Response.json({ error: 'Body must be a JSON object' }, { status: 400 })
      }
      const result = this.putDoc(collection!, id!, doc)
      return Response.json(result, { status: 201 })
    }

    // Route: DELETE /:collection/:id
    if (docMatch && method === 'DELETE') {
      const [, collection, id] = docMatch
      const deleted = this.deleteDoc(collection!, id!)
      if (!deleted) return Response.json({ error: 'Not found' }, { status: 404 })
      return Response.json({ deleted: true })
    }

    // Route: POST /:collection/query
    const queryMatch = path.match(/^\/([^/]+)\/query$/)
    if (queryMatch && method === 'POST') {
      const collection = queryMatch[1]!
      const parsed = await this.parseJsonBody<{ filter?: Record<string, unknown>; limit?: number; offset?: number }>(request)
      if (parsed instanceof Response) return parsed
      const body = parsed
      const options: { limit?: number; offset?: number } = {}
      if (body.limit !== undefined) options.limit = body.limit
      if (body.offset !== undefined) options.offset = body.offset
      const docs = this.findDocs(collection, body.filter, options)
      return Response.json({ collection, count: docs.length, docs })
    }

    // Route: DELETE /:collection
    if (collectionMatch && method === 'DELETE') {
      const collection = collectionMatch[1]!
      const cleared = this.clearCollection(collection)
      return Response.json({ cleared })
    }

    return Response.json({ error: 'Not found' }, { status: 404 })
  }
}

// ============================================================================
// Test Types
// ============================================================================

interface User {
  id: string
  name: string
  email: string
  age: number
  active: boolean
}

interface Product {
  id: string
  name: string
  price: number
  category: string
  inStock: boolean
}

// ============================================================================
// Test Setup
// ============================================================================

let mockSql: MockSqlStorage
let db: Database
let doInstance: TestCollectionsDO

const BASE_URL = 'https://test.collections.do'

beforeAll(async () => {
  // Initialize sql.js once
  SQL = await initSqlJs()
})

beforeEach(async () => {
  // Reset module cache to reset the schemaInitialized flag
  vi.resetModules()

  // Create a fresh database for each test
  db = new SQL.Database()
  mockSql = new MockSqlStorage(db)
  doInstance = new TestCollectionsDO(mockSql as unknown as SqlStorage)
})

afterEach(() => {
  if (mockSql) {
    mockSql.close()
  }
})

/**
 * Helper to create a request with standard headers
 * Supports two call signatures:
 * - createRequest(method, path, rawBody) - raw string body for testing invalid JSON
 * - createRequest(method, path, { body, ...options }) - object body with options
 */
function createRequest(
  method: string,
  path: string,
  bodyOrOptions?: string | {
    body?: unknown
    namespace?: string
    doName?: string
    baseUrl?: string
    searchParams?: Record<string, string>
  }
): Request {
  // Parse the third argument
  const isRawBody = typeof bodyOrOptions === 'string'
  const options = isRawBody ? undefined : bodyOrOptions
  const rawBody = isRawBody ? bodyOrOptions : undefined

  const url = new URL(path, BASE_URL)
  if (options?.searchParams) {
    for (const [key, value] of Object.entries(options.searchParams)) {
      url.searchParams.set(key, value)
    }
  }

  const headers = new Headers({
    'X-Namespace': options?.namespace || 'test',
    'X-Base-Url': options?.baseUrl || BASE_URL,
  })
  if (options?.doName) {
    headers.set('X-DO-Name', options.doName)
  }

  const init: RequestInit = { method, headers }

  // Handle body: raw string takes precedence, otherwise use options.body
  if (rawBody !== undefined) {
    headers.set('Content-Type', 'application/json')
    init.body = rawBody
  } else if (options?.body !== undefined) {
    headers.set('Content-Type', 'application/json')
    init.body = JSON.stringify(options.body)
  }

  return new Request(url.toString(), init)
}

// ============================================================================
// GET / - Root endpoint tests
// ============================================================================

describe('GET / - Root endpoint', () => {
  it('should return DO info with empty collections', async () => {
    const request = createRequest('GET', '/')
    const response = await doInstance.fetch(request)

    expect(response.status).toBe(200)
    const body = await response.json() as any
    expect(body.$id).toBe(BASE_URL)
    expect(body.namespace).toBe('test')
    expect(body.collections).toEqual([])
  })

  it('should list collections when they exist', async () => {
    // Create some documents in different collections
    doInstance.putDoc('users', 'u1', { name: 'Alice' })
    doInstance.putDoc('products', 'p1', { name: 'Laptop' })

    const request = createRequest('GET', '/')
    const response = await doInstance.fetch(request)

    expect(response.status).toBe(200)
    const body = await response.json() as any
    expect(body.collections).toHaveLength(2)
    expect(body.collections.map((c: any) => c.name).sort()).toEqual(['products', 'users'])
    expect(body.collections[0].$id).toContain(BASE_URL)
  })

  it('should include doName when set', async () => {
    const request = createRequest('GET', '/', { doName: 'user123:default' })
    const response = await doInstance.fetch(request)

    expect(response.status).toBe(200)
    const body = await response.json() as any
    expect(body.doName).toBe('user123:default')
  })

  it('should use custom namespace from headers', async () => {
    const request = createRequest('GET', '/', { namespace: 'myapp' })
    const response = await doInstance.fetch(request)

    expect(response.status).toBe(200)
    const body = await response.json() as any
    expect(body.namespace).toBe('myapp')
  })
})

// ============================================================================
// GET /:collection - List documents endpoint
// ============================================================================

describe('GET /:collection - List documents', () => {
  beforeEach(() => {
    // Seed some test data
    doInstance.putDoc('users', 'u1', { id: 'u1', name: 'Alice', email: 'alice@test.com', age: 30, active: true })
    doInstance.putDoc('users', 'u2', { id: 'u2', name: 'Bob', email: 'bob@test.com', age: 25, active: true })
    doInstance.putDoc('users', 'u3', { id: 'u3', name: 'Charlie', email: 'charlie@test.com', age: 35, active: false })
  })

  it('should list all documents in a collection', async () => {
    const request = createRequest('GET', '/users')
    const response = await doInstance.fetch(request)

    expect(response.status).toBe(200)
    const body = await response.json() as any
    expect(body.collection).toBe('users')
    expect(body.count).toBe(3)
    expect(body.docs).toHaveLength(3)
  })

  it('should include $id links in response', async () => {
    const request = createRequest('GET', '/users')
    const response = await doInstance.fetch(request)

    expect(response.status).toBe(200)
    const body = await response.json() as any
    expect(body.$id).toBe(`${BASE_URL}/users`)
    expect(body.docs[0].$id).toContain(`${BASE_URL}/users/`)
  })

  it('should support limit parameter', async () => {
    const request = createRequest('GET', '/users', { searchParams: { limit: '2' } })
    const response = await doInstance.fetch(request)

    expect(response.status).toBe(200)
    const body = await response.json() as any
    expect(body.docs).toHaveLength(2)
    expect(body.count).toBe(3) // Total count is still 3
  })

  it('should support offset parameter', async () => {
    const request = createRequest('GET', '/users', { searchParams: { limit: '2', offset: '1' } })
    const response = await doInstance.fetch(request)

    expect(response.status).toBe(200)
    const body = await response.json() as any
    expect(body.docs).toHaveLength(2)
  })

  it('should return empty docs for non-existent collection', async () => {
    const request = createRequest('GET', '/nonexistent')
    const response = await doInstance.fetch(request)

    expect(response.status).toBe(200)
    const body = await response.json() as any
    expect(body.collection).toBe('nonexistent')
    expect(body.count).toBe(0)
    expect(body.docs).toEqual([])
  })
})

// ============================================================================
// GET /:collection/:id - Get document endpoint
// ============================================================================

describe('GET /:collection/:id - Get document', () => {
  beforeEach(() => {
    doInstance.putDoc('users', 'u1', { id: 'u1', name: 'Alice', email: 'alice@test.com', age: 30, active: true })
  })

  it('should return a document by ID', async () => {
    const request = createRequest('GET', '/users/u1')
    const response = await doInstance.fetch(request)

    expect(response.status).toBe(200)
    const body = await response.json() as any
    expect(body.id).toBe('u1')
    expect(body.name).toBe('Alice')
    expect(body.email).toBe('alice@test.com')
  })

  it('should include $id link in response', async () => {
    const request = createRequest('GET', '/users/u1')
    const response = await doInstance.fetch(request)

    expect(response.status).toBe(200)
    const body = await response.json() as any
    expect(body.$id).toBe(`${BASE_URL}/users/u1`)
  })

  it('should return 404 for non-existent document', async () => {
    const request = createRequest('GET', '/users/nonexistent')
    const response = await doInstance.fetch(request)

    expect(response.status).toBe(404)
    const body = await response.json() as any
    expect(body.error).toBe('Not found')
  })

  it('should return 404 for non-existent collection', async () => {
    const request = createRequest('GET', '/products/p1')
    const response = await doInstance.fetch(request)

    expect(response.status).toBe(404)
    const body = await response.json() as any
    expect(body.error).toBe('Not found')
  })

  it('should handle special characters in document ID', async () => {
    doInstance.putDoc('users', 'user-with-dashes', { id: 'user-with-dashes', name: 'Test' })

    const request = createRequest('GET', '/users/user-with-dashes')
    const response = await doInstance.fetch(request)

    expect(response.status).toBe(200)
    const body = await response.json() as any
    expect(body.id).toBe('user-with-dashes')
  })
})

// ============================================================================
// PUT /:collection/:id - Create/Update document endpoint
// ============================================================================

describe('PUT /:collection/:id - Create/Update document', () => {
  it('should create a new document', async () => {
    const userData = { name: 'Alice', email: 'alice@test.com', age: 30, active: true }
    const request = createRequest('PUT', '/users/u1', { body: userData })
    const response = await doInstance.fetch(request)

    expect(response.status).toBe(201)
    const body = await response.json() as any
    expect(body.id).toBe('u1')
    expect(body.name).toBe('Alice')
  })

  it('should update an existing document', async () => {
    // Create initial document
    doInstance.putDoc('users', 'u1', { id: 'u1', name: 'Alice', email: 'alice@test.com' })

    // Update it
    const userData = { name: 'Alice Updated', email: 'alice.new@test.com' }
    const request = createRequest('PUT', '/users/u1', { body: userData })
    const response = await doInstance.fetch(request)

    expect(response.status).toBe(201)
    const body = await response.json() as any
    expect(body.name).toBe('Alice Updated')
    expect(body.email).toBe('alice.new@test.com')

    // Verify it's actually updated
    const doc = doInstance.getDoc('users', 'u1')
    expect(doc?.name).toBe('Alice Updated')
  })

  it('should return 400 for invalid JSON body', async () => {
    const request = new Request(`${BASE_URL}/users/u1`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'X-Namespace': 'test',
        'X-Base-Url': BASE_URL,
      },
      body: 'not valid json',
    })
    const response = await doInstance.fetch(request)

    expect(response.status).toBe(400)
    const body = await response.json() as any
    expect(body.error).toBe('Invalid JSON body')
  })

  it('should return 400 for array body', async () => {
    const request = createRequest('PUT', '/users/u1', { body: [1, 2, 3] })
    const response = await doInstance.fetch(request)

    expect(response.status).toBe(400)
    const body = await response.json() as any
    expect(body.error).toBe('Body must be a JSON object')
  })

  it('should return 400 for null body', async () => {
    const request = createRequest('PUT', '/users/u1', { body: null })
    const response = await doInstance.fetch(request)

    expect(response.status).toBe(400)
    const body = await response.json() as any
    expect(body.error).toBe('Body must be a JSON object')
  })

  it('should handle nested objects in document', async () => {
    const userData = {
      name: 'Alice',
      metadata: {
        preferences: { theme: 'dark' },
        tags: ['admin', 'verified'],
      },
    }
    const request = createRequest('PUT', '/users/u1', { body: userData })
    const response = await doInstance.fetch(request)

    expect(response.status).toBe(201)

    const doc = doInstance.getDoc('users', 'u1')
    expect((doc as any)?.metadata?.preferences?.theme).toBe('dark')
  })
})

// ============================================================================
// DELETE /:collection/:id - Delete document endpoint
// ============================================================================

describe('DELETE /:collection/:id - Delete document', () => {
  beforeEach(() => {
    doInstance.putDoc('users', 'u1', { id: 'u1', name: 'Alice' })
    doInstance.putDoc('users', 'u2', { id: 'u2', name: 'Bob' })
  })

  it('should delete an existing document', async () => {
    const request = createRequest('DELETE', '/users/u1')
    const response = await doInstance.fetch(request)

    expect(response.status).toBe(200)
    const body = await response.json() as any
    expect(body.deleted).toBe(true)

    // Verify it's actually deleted
    expect(doInstance.getDoc('users', 'u1')).toBeNull()
  })

  it('should not affect other documents', async () => {
    const request = createRequest('DELETE', '/users/u1')
    await doInstance.fetch(request)

    // u2 should still exist
    expect(doInstance.getDoc('users', 'u2')).not.toBeNull()
  })

  it('should return 404 for non-existent document', async () => {
    const request = createRequest('DELETE', '/users/nonexistent')
    const response = await doInstance.fetch(request)

    expect(response.status).toBe(404)
    const body = await response.json() as any
    expect(body.error).toBe('Not found')
  })

  it('should return 404 when deleting already deleted document', async () => {
    // Delete once
    await doInstance.fetch(createRequest('DELETE', '/users/u1'))

    // Try to delete again
    const request = createRequest('DELETE', '/users/u1')
    const response = await doInstance.fetch(request)

    expect(response.status).toBe(404)
  })
})

// ============================================================================
// POST /:collection/query - Query documents endpoint
// ============================================================================

describe('POST /:collection/query - Query documents', () => {
  beforeEach(() => {
    doInstance.putDoc('products', 'p1', { id: 'p1', name: 'Laptop', price: 999, category: 'electronics', inStock: true })
    doInstance.putDoc('products', 'p2', { id: 'p2', name: 'Phone', price: 599, category: 'electronics', inStock: true })
    doInstance.putDoc('products', 'p3', { id: 'p3', name: 'Chair', price: 149, category: 'furniture', inStock: false })
    doInstance.putDoc('products', 'p4', { id: 'p4', name: 'Desk', price: 299, category: 'furniture', inStock: true })
  })

  it('should query with simple equality filter', async () => {
    const request = createRequest('POST', '/products/query', {
      body: { filter: { category: 'electronics' } },
    })
    const response = await doInstance.fetch(request)

    expect(response.status).toBe(200)
    const body = await response.json() as any
    expect(body.collection).toBe('products')
    expect(body.count).toBe(2)
    expect(body.docs.every((d: any) => d.category === 'electronics')).toBe(true)
  })

  it('should query with $eq operator', async () => {
    const request = createRequest('POST', '/products/query', {
      body: { filter: { inStock: { $eq: true } } },
    })
    const response = await doInstance.fetch(request)

    expect(response.status).toBe(200)
    const body = await response.json() as any
    expect(body.count).toBe(3)
  })

  it('should query with $gt operator', async () => {
    const request = createRequest('POST', '/products/query', {
      body: { filter: { price: { $gt: 500 } } },
    })
    const response = await doInstance.fetch(request)

    expect(response.status).toBe(200)
    const body = await response.json() as any
    expect(body.count).toBe(2)
    expect(body.docs.every((d: any) => d.price > 500)).toBe(true)
  })

  it('should query with $in operator', async () => {
    const request = createRequest('POST', '/products/query', {
      body: { filter: { category: { $in: ['electronics', 'furniture'] } } },
    })
    const response = await doInstance.fetch(request)

    expect(response.status).toBe(200)
    const body = await response.json() as any
    expect(body.count).toBe(4)
  })

  it('should query with $and operator', async () => {
    const request = createRequest('POST', '/products/query', {
      body: {
        filter: {
          $and: [{ category: 'electronics' }, { inStock: true }],
        },
      },
    })
    const response = await doInstance.fetch(request)

    expect(response.status).toBe(200)
    const body = await response.json() as any
    expect(body.count).toBe(2)
  })

  it('should query with $or operator', async () => {
    const request = createRequest('POST', '/products/query', {
      body: {
        filter: {
          $or: [{ category: 'furniture' }, { price: { $gt: 900 } }],
        },
      },
    })
    const response = await doInstance.fetch(request)

    expect(response.status).toBe(200)
    const body = await response.json() as any
    expect(body.count).toBe(3) // Chair, Desk, Laptop
  })

  it('should support limit in query', async () => {
    const request = createRequest('POST', '/products/query', {
      body: { filter: {}, limit: 2 },
    })
    const response = await doInstance.fetch(request)

    expect(response.status).toBe(200)
    const body = await response.json() as any
    expect(body.docs).toHaveLength(2)
  })

  it('should support offset in query', async () => {
    const request = createRequest('POST', '/products/query', {
      body: { filter: {}, limit: 2, offset: 2 },
    })
    const response = await doInstance.fetch(request)

    expect(response.status).toBe(200)
    const body = await response.json() as any
    expect(body.docs).toHaveLength(2)
  })

  it('should return all documents with empty filter', async () => {
    const request = createRequest('POST', '/products/query', {
      body: { filter: {} },
    })
    const response = await doInstance.fetch(request)

    expect(response.status).toBe(200)
    const body = await response.json() as any
    expect(body.count).toBe(4)
  })

  it('should return 400 for invalid JSON body', async () => {
    const request = new Request(`${BASE_URL}/products/query`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Namespace': 'test',
        'X-Base-Url': BASE_URL,
      },
      body: 'not valid json',
    })
    const response = await doInstance.fetch(request)

    expect(response.status).toBe(400)
  })
})

// ============================================================================
// DELETE /:collection - Clear collection endpoint
// ============================================================================

describe('DELETE /:collection - Clear collection', () => {
  beforeEach(() => {
    doInstance.putDoc('users', 'u1', { id: 'u1', name: 'Alice' })
    doInstance.putDoc('users', 'u2', { id: 'u2', name: 'Bob' })
    doInstance.putDoc('users', 'u3', { id: 'u3', name: 'Charlie' })
    doInstance.putDoc('products', 'p1', { id: 'p1', name: 'Laptop' })
  })

  it('should clear all documents in a collection', async () => {
    const request = createRequest('DELETE', '/users')
    const response = await doInstance.fetch(request)

    expect(response.status).toBe(200)
    const body = await response.json() as any
    expect(body.cleared).toBe(3)

    // Verify collection is empty
    expect(doInstance.countDocs('users')).toBe(0)
  })

  it('should not affect other collections', async () => {
    await doInstance.fetch(createRequest('DELETE', '/users'))

    // Products should still have 1 doc
    expect(doInstance.countDocs('products')).toBe(1)
  })

  it('should return 0 for non-existent collection', async () => {
    const request = createRequest('DELETE', '/nonexistent')
    const response = await doInstance.fetch(request)

    expect(response.status).toBe(200)
    const body = await response.json() as any
    expect(body.cleared).toBe(0)
  })
})

// ============================================================================
// Error handling tests
// ============================================================================

describe('Error handling', () => {
  it('should return 404 for unknown routes', async () => {
    const request = createRequest('GET', '/users/u1/nested/path')
    const response = await doInstance.fetch(request)

    expect(response.status).toBe(404)
    const body = await response.json() as any
    expect(body.error).toBe('Not found')
  })

  it('should return 404 for unsupported methods on root', async () => {
    const request = createRequest('POST', '/')
    const response = await doInstance.fetch(request)

    expect(response.status).toBe(404)
  })

  it('should return 404 for PATCH method (not supported)', async () => {
    const request = createRequest('PATCH', '/users/u1')
    const response = await doInstance.fetch(request)

    expect(response.status).toBe(404)
  })
})

// ============================================================================
// Response formatting tests
// ============================================================================

describe('Response formatting', () => {
  beforeEach(() => {
    doInstance.putDoc('users', 'u1', { id: 'u1', name: 'Alice', email: 'alice@test.com' })
  })

  it('should include proper $id links in all responses', async () => {
    // Test GET /
    const rootResponse = await doInstance.fetch(createRequest('GET', '/'))
    const rootBody = await rootResponse.json() as any
    expect(rootBody.$id).toBe(BASE_URL)

    // Test GET /:collection
    const listResponse = await doInstance.fetch(createRequest('GET', '/users'))
    const listBody = await listResponse.json() as any
    expect(listBody.$id).toBe(`${BASE_URL}/users`)
    expect(listBody.docs[0].$id).toBe(`${BASE_URL}/users/u1`)

    // Test GET /:collection/:id
    const docResponse = await doInstance.fetch(createRequest('GET', '/users/u1'))
    const docBody = await docResponse.json() as any
    expect(docBody.$id).toBe(`${BASE_URL}/users/u1`)
  })

  it('should use custom base URL from header', async () => {
    const customBaseUrl = 'https://myapp.example.com/api'
    const request = createRequest('GET', '/users/u1', { baseUrl: customBaseUrl })
    const response = await doInstance.fetch(request)

    const body = await response.json() as any
    expect(body.$id).toBe(`${customBaseUrl}/users/u1`)
  })

  it('should include document id field in responses', async () => {
    const request = createRequest('GET', '/users/u1')
    const response = await doInstance.fetch(request)

    const body = await response.json() as any
    expect(body.id).toBe('u1')
    expect(body.name).toBe('Alice')
  })

  it('should preserve all document fields in response', async () => {
    doInstance.putDoc('users', 'complex', {
      id: 'complex',
      name: 'Test',
      nested: { a: 1, b: { c: 2 } },
      array: [1, 2, 3],
      nullField: null,
      boolField: false,
    })

    const request = createRequest('GET', '/users/complex')
    const response = await doInstance.fetch(request)

    const body = await response.json() as any
    expect(body.nested).toEqual({ a: 1, b: { c: 2 } })
    expect(body.array).toEqual([1, 2, 3])
    expect(body.nullField).toBeNull()
    expect(body.boolField).toBe(false)
  })
})

// ============================================================================
// Query parameter validation tests
// ============================================================================

describe('Query parameter validation', () => {
  beforeEach(() => {
    // Seed some test data
    doInstance.putDoc('users', 'u1', { id: 'u1', name: 'Alice', email: 'alice@test.com', age: 30, active: true })
    doInstance.putDoc('users', 'u2', { id: 'u2', name: 'Bob', email: 'bob@test.com', age: 25, active: true })
  })

  it('should return 400 for limit=NaN', async () => {
    const request = createRequest('GET', '/users?limit=abc')
    const response = await doInstance.fetch(request)
    expect(response.status).toBe(400)
    const body = await response.json() as any
    expect(body.error).toContain('limit')
  })

  it('should return 400 for negative limit', async () => {
    const request = createRequest('GET', '/users?limit=-1')
    const response = await doInstance.fetch(request)
    expect(response.status).toBe(400)
  })

  it('should return 400 for limit exceeding maximum', async () => {
    const request = createRequest('GET', '/users?limit=99999')
    const response = await doInstance.fetch(request)
    expect(response.status).toBe(400)
  })

  it('should return 400 for negative offset', async () => {
    const request = createRequest('GET', '/users?limit=10&offset=-5')
    const response = await doInstance.fetch(request)
    expect(response.status).toBe(400)
  })

  it('should accept valid limit and offset', async () => {
    const request = createRequest('GET', '/users?limit=10&offset=0')
    const response = await doInstance.fetch(request)
    expect(response.status).toBe(200)
  })

  it('should accept limit at maximum boundary', async () => {
    const request = createRequest('GET', '/users?limit=10000')
    const response = await doInstance.fetch(request)
    expect(response.status).toBe(200)
  })

  it('should return 400 for limit=0', async () => {
    const request = createRequest('GET', '/users?limit=0')
    const response = await doInstance.fetch(request)
    expect(response.status).toBe(400)
  })
})

// ============================================================================
// Collection isolation tests
// ============================================================================

describe('Collection isolation', () => {
  it('should isolate documents between collections', async () => {
    doInstance.putDoc('users', 'id1', { id: 'id1', type: 'user', name: 'Alice' })
    doInstance.putDoc('products', 'id1', { id: 'id1', type: 'product', name: 'Laptop' })

    const userResponse = await doInstance.fetch(createRequest('GET', '/users/id1'))
    const userBody = await userResponse.json() as any
    expect(userBody.type).toBe('user')

    const productResponse = await doInstance.fetch(createRequest('GET', '/products/id1'))
    const productBody = await productResponse.json() as any
    expect(productBody.type).toBe('product')
  })

  it('should have independent counts per collection', async () => {
    doInstance.putDoc('users', 'u1', { id: 'u1' })
    doInstance.putDoc('users', 'u2', { id: 'u2' })
    doInstance.putDoc('products', 'p1', { id: 'p1' })

    const usersResponse = await doInstance.fetch(createRequest('GET', '/users'))
    const usersBody = await usersResponse.json() as any
    expect(usersBody.count).toBe(2)

    const productsResponse = await doInstance.fetch(createRequest('GET', '/products'))
    const productsBody = await productsResponse.json() as any
    expect(productsBody.count).toBe(1)
  })

  it('should have independent clear operations', async () => {
    doInstance.putDoc('users', 'u1', { id: 'u1' })
    doInstance.putDoc('products', 'p1', { id: 'p1' })

    await doInstance.fetch(createRequest('DELETE', '/users'))

    expect(doInstance.countDocs('users')).toBe(0)
    expect(doInstance.countDocs('products')).toBe(1)
  })
})

// ============================================================================
// countDocs tests
// ============================================================================

describe('countDocs', () => {
  beforeEach(() => {
    doInstance.putDoc('products', 'p1', { id: 'p1', name: 'Laptop', price: 999, category: 'electronics', inStock: true })
    doInstance.putDoc('products', 'p2', { id: 'p2', name: 'Phone', price: 599, category: 'electronics', inStock: true })
    doInstance.putDoc('products', 'p3', { id: 'p3', name: 'Chair', price: 149, category: 'furniture', inStock: false })
    doInstance.putDoc('products', 'p4', { id: 'p4', name: 'Desk', price: 299, category: 'furniture', inStock: true })
  })

  it('should count all documents without filter', () => {
    const count = doInstance.countDocs('products')
    expect(count).toBe(4)
  })

  it('should count documents with filter', () => {
    const count = doInstance.countDocs('products', { category: 'electronics' })
    expect(count).toBe(2)
  })

  it('should count documents with complex filter', () => {
    const count = doInstance.countDocs('products', { inStock: true })
    expect(count).toBe(3)
  })

  it('should return 0 for non-matching filter', () => {
    const count = doInstance.countDocs('products', { category: 'appliances' })
    expect(count).toBe(0)
  })

  it('should return 0 for empty collection', () => {
    const count = doInstance.countDocs('nonexistent')
    expect(count).toBe(0)
  })
})

// ============================================================================
// Invalid JSON body error handling tests
// ============================================================================

describe('error handling', () => {
  it('should return 400 for PUT with invalid JSON body', async () => {
    const request = createRequest('PUT', '/users/user1', 'invalid json {{{')
    const response = await doInstance.fetch(request)
    expect(response.status).toBe(400)
    const body = await response.json() as any
    expect(body.error).toContain('JSON')
  })

  it('should return 400 for POST /query with invalid JSON body', async () => {
    const request = createRequest('POST', '/users/query', 'not valid json')
    const response = await doInstance.fetch(request)
    expect(response.status).toBe(400)
  })
})

// ============================================================================
// Request body size limit tests
// ============================================================================

describe('request body size limit', () => {
  const MAX_BODY_SIZE = 1024 * 1024 // 1MB

  it('should return 413 for requests with Content-Length > MAX_BODY_SIZE', async () => {
    const request = new Request(`${BASE_URL}/users/u1`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': String(MAX_BODY_SIZE + 1),
        'X-Namespace': 'test',
        'X-Base-Url': BASE_URL,
      },
      body: JSON.stringify({ name: 'Test' }),
    })
    const response = await doInstance.fetch(request)

    expect(response.status).toBe(413)
    const body = await response.json() as any
    expect(body.error).toBe('Request body too large')
  })

  it('should accept requests within the size limit', async () => {
    const request = new Request(`${BASE_URL}/users/u1`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': String(100),
        'X-Namespace': 'test',
        'X-Base-Url': BASE_URL,
      },
      body: JSON.stringify({ name: 'Test' }),
    })
    const response = await doInstance.fetch(request)

    expect(response.status).toBe(201)
    const body = await response.json() as any
    expect(body.name).toBe('Test')
  })

  it('should accept requests at exactly MAX_BODY_SIZE', async () => {
    const request = new Request(`${BASE_URL}/users/u1`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': String(MAX_BODY_SIZE),
        'X-Namespace': 'test',
        'X-Base-Url': BASE_URL,
      },
      body: JSON.stringify({ name: 'Test' }),
    })
    const response = await doInstance.fetch(request)

    expect(response.status).toBe(201)
  })

  it('should return 413 for POST /query with Content-Length > MAX_BODY_SIZE', async () => {
    const request = new Request(`${BASE_URL}/products/query`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': String(MAX_BODY_SIZE + 1000),
        'X-Namespace': 'test',
        'X-Base-Url': BASE_URL,
      },
      body: JSON.stringify({ filter: {} }),
    })
    const response = await doInstance.fetch(request)

    expect(response.status).toBe(413)
    const body = await response.json() as any
    expect(body.error).toBe('Request body too large')
  })
})

// ============================================================================
// API Key Cache Size Limit Tests
// ============================================================================

import { apiKeyCache, MAX_CACHE_SIZE, setApiKeyCacheEntry, hashApiKey } from '../src/cache'

describe('API Key Cache Size Limit', () => {
  beforeEach(() => {
    // Clear the cache before each test
    apiKeyCache.clear()
  })

  it('should not exceed MAX_CACHE_SIZE', async () => {
    // Add MAX_CACHE_SIZE + 100 entries
    for (let i = 0; i < MAX_CACHE_SIZE + 100; i++) {
      const keyHash = await hashApiKey(`sk_test_key_${i}`)
      setApiKeyCacheEntry(keyHash, {
        user: { id: `user-${i}`, name: `User ${i}` },
        expiresAt: Date.now() + 5 * 60 * 1000,
      })
    }

    // Cache size should not exceed MAX_CACHE_SIZE
    expect(apiKeyCache.size).toBeLessThanOrEqual(MAX_CACHE_SIZE)
  })

  it('should evict oldest entries when limit reached', async () => {
    // First, add some entries to fill the cache
    const firstKeyHash = await hashApiKey('sk_first_key')
    setApiKeyCacheEntry(firstKeyHash, {
      user: { id: 'first-user', name: 'First User' },
      expiresAt: Date.now() + 5 * 60 * 1000,
    })

    // Add more entries to approach the limit
    for (let i = 0; i < MAX_CACHE_SIZE; i++) {
      const keyHash = await hashApiKey(`sk_test_key_${i}`)
      setApiKeyCacheEntry(keyHash, {
        user: { id: `user-${i}`, name: `User ${i}` },
        expiresAt: Date.now() + 5 * 60 * 1000,
      })
    }

    // The first entry should have been evicted (oldest by insertion order)
    expect(apiKeyCache.has(firstKeyHash)).toBe(false)
    expect(apiKeyCache.size).toBeLessThanOrEqual(MAX_CACHE_SIZE)
  })
})

// ============================================================================
// Auth Middleware Tests
// ============================================================================

/**
 * Auth Middleware Test Suite
 *
 * Tests the authentication middleware in src/do.ts (lines 395-630).
 * This is security-critical code that handles:
 * - API key validation (Bearer sk_...)
 * - JWT token verification (Bearer <jwt>)
 * - Cookie-based authentication
 * - Silent token refresh
 */
describe('Auth Middleware', () => {
  // Mock AUTH and OAUTH service bindings
  let mockAuthService: {
    fetch: ReturnType<typeof vi.fn>
  }
  let mockOAuthService: {
    fetch: ReturnType<typeof vi.fn>
  }

  // Create a minimal test Hono app with the auth middleware
  // This mimics the middleware from src/do.ts but allows us to inject mocks
  const { Hono } = require('hono')

  interface AuthUser {
    id: string
    email?: string
    name?: string
    image?: string
    org?: string
    roles?: string[]
    permissions?: string[]
  }

  // Test environment type
  interface TestEnv {
    AUTH: { fetch: (req: Request) => Promise<Response> }
    OAUTH: { fetch: (req: Request) => Promise<Response> }
  }

  // API key cache for testing
  let testApiKeyCache: Map<string, { user: AuthUser; expiresAt: number }>
  const API_KEY_CACHE_TTL = 5 * 60 * 1000 // 5 minutes

  /**
   * Hash an API key for cache lookup (local version for tests)
   */
  async function hashApiKeyLocal(apiKey: string): Promise<string> {
    const encoder = new TextEncoder()
    const data = encoder.encode(apiKey)
    const hashBuffer = await crypto.subtle.digest('SHA-256', data)
    const hashArray = Array.from(new Uint8Array(hashBuffer))
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('')
  }

  /**
   * Helper to check if a token looks like a valid JWT
   */
  function isValidJwtFormat(token: string | null): boolean {
    if (!token) return false
    const parts = token.split('.')
    return parts.length === 3 && parts.every(p => p.length > 0)
  }

  /**
   * Helper to extract cookie value
   */
  function getCookie(cookies: string | null | undefined, name: string): string | null {
    if (!cookies) return null
    const match = cookies.match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`))
    return match ? match[1]! : null
  }

  /**
   * Get cookie domain from host
   */
  function getCookieDomain(host: string): string | undefined {
    const hostname = host.split(':')[0] || ''
    if (hostname === 'localhost' || /^\d+\.\d+\.\d+\.\d+$/.test(hostname)) return undefined
    const parts = hostname.split('.')
    return parts.length >= 2 ? '.' + parts.slice(-2).join('.') : undefined
  }

  /**
   * Create a test app with auth middleware
   * This replicates the auth middleware logic from src/do.ts for isolated testing
   */
  function createAuthTestApp() {
    const app = new Hono<{ Bindings: TestEnv; Variables: { user: AuthUser | null; newCookies?: string[] } }>()

    // Auth middleware - mirrors src/do.ts lines 395-619
    app.use('/*', async (c: any, next: () => Promise<void>) => {
      const path = c.req.path

      // Skip auth for auth/OAuth/MCP routes
      const publicPaths = ['/login', '/logout', '/callback', '/authorize', '/token', '/introspect', '/revoke', '/register']
      const wellKnownPaths = ['/.well-known/oauth-authorization-server', '/.well-known/oauth-protected-resource', '/.well-known/jwks.json', '/.well-known/openid-configuration']
      if (publicPaths.includes(path) || wellKnownPaths.includes(path) || path.startsWith('/mcp')) {
        return next()
      }

      // Check for API key in Authorization header (Bearer token starting with sk_)
      const authHeader = c.req.header('Authorization')
      if (authHeader?.startsWith('Bearer sk_')) {
        const apiKey = authHeader.slice(7) // Remove 'Bearer '

        // Hash the API key for cache lookup
        const keyHash = await hashApiKeyLocal(apiKey)

        // Check cache first
        const cached = testApiKeyCache.get(keyHash)
        if (cached && cached.expiresAt > Date.now()) {
          // Cache hit - use cached user
          c.set('user', cached.user)
          return next()
        }

        // Cache miss - validate via oauth.do
        const validateResponse = await c.env.OAUTH.fetch(new Request('https://oauth.do/validate-api-key', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ value: apiKey }),
        }))

        if (validateResponse.ok) {
          const validation = await validateResponse.json() as {
            valid: boolean
            id?: string
            name?: string
            organization_id?: string
            permissions?: string[]
            error?: string
          }

          if (validation.valid) {
            // API key is valid - build user object
            const user: AuthUser = {
              id: validation.id || `api:${apiKey.slice(0, 16)}`,
              name: validation.name || 'API Key User',
              roles: ['api'],
              permissions: validation.permissions || [],
              ...(validation.organization_id && { org: validation.organization_id }),
            }

            // Cache the validated key
            testApiKeyCache.set(keyHash, {
              user,
              expiresAt: Date.now() + API_KEY_CACHE_TTL,
            })

            c.set('user', user)
            return next()
          }
        }

        // API key validation failed - remove from cache if present
        testApiKeyCache.delete(keyHash)
        return c.json({ error: 'Invalid API key' }, 401)
      }

      // Check for JWT in Authorization header (Bearer token that's NOT an API key)
      if (authHeader?.startsWith('Bearer ') && !authHeader.startsWith('Bearer sk_')) {
        const token = authHeader.slice(7) // Remove 'Bearer '

        // Validate JWT looks correct
        if (isValidJwtFormat(token)) {
          // Verify JWT via AUTH service (lightweight, handles JWKS caching)
          const response = await c.env.AUTH.fetch(new Request('https://auth/user', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              request: {
                url: c.req.url,
                headers: { 'Authorization': authHeader },
              },
            }),
          }))

          if (response.ok) {
            const { user } = await response.json() as { user: AuthUser | null }

            if (user) {
              c.set('user', user)
              return next()
            }
          }
        }

        // JWT validation failed
        return c.json({ error: 'Invalid token' }, 401)
      }

      // Check for invalid auth cookie and clear it
      const cookies = c.req.header('Cookie')
      const authCookie = getCookie(cookies, 'auth')
      if (authCookie && !isValidJwtFormat(authCookie)) {
        // Invalid cookie - clear it
        const domain = getCookieDomain(c.req.header('host') || '')
        const cookieBase = ['HttpOnly', 'Secure', 'SameSite=Lax', 'Max-Age=0', 'Path=/']
        if (domain) cookieBase.push(`Domain=${domain}`)

        const accept = c.req.header('Accept') || ''
        if (accept.includes('text/html')) {
          const headers = new Headers({ 'Location': `/login?returnTo=${encodeURIComponent(c.req.url)}` })
          headers.append('Set-Cookie', ['auth=', ...cookieBase].join('; '))
          headers.append('Set-Cookie', ['refresh=', ...cookieBase].join('; '))
          return new Response(null, { status: 302, headers })
        }
        // For API requests, just clear cookie and return 401
        const headers = new Headers({ 'Content-Type': 'application/json' })
        headers.append('Set-Cookie', ['auth=', ...cookieBase].join('; '))
        headers.append('Set-Cookie', ['refresh=', ...cookieBase].join('; '))
        return new Response(JSON.stringify({ error: 'Invalid token, please re-authenticate' }), { status: 401, headers })
      }

      // Call AUTH service to verify JWT (from cookie)
      const response = await c.env.AUTH.fetch(new Request('https://auth/user', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          request: {
            url: c.req.url,
            headers: Object.fromEntries(c.req.raw.headers.entries()),
          },
        }),
      }))

      const { user } = await response.json() as { user: AuthUser | null }

      if (user) {
        c.set('user', user)
        return next()
      }

      // Not authenticated
      const accept = c.req.header('Accept') || ''
      if (accept.includes('text/html')) {
        return c.redirect(`/login?returnTo=${encodeURIComponent(c.req.url)}`)
      }
      return c.json({ error: 'Authentication required' }, 401)
    })

    // Protected test route
    app.get('/protected', (c: any) => {
      const user = c.get('user')
      return c.json({ user, message: 'Access granted' })
    })

    // Public routes (should skip auth)
    app.get('/login', (c: any) => c.json({ message: 'Login page' }))
    app.get('/mcp/test', (c: any) => c.json({ message: 'MCP route' }))
    app.get('/.well-known/oauth-authorization-server', (c: any) => c.json({ message: 'OAuth metadata' }))

    return app
  }

  beforeEach(() => {
    // Reset mocks before each test
    mockAuthService = {
      fetch: vi.fn(),
    }
    mockOAuthService = {
      fetch: vi.fn(),
    }
    // Reset API key cache
    testApiKeyCache = new Map()
  })

  /**
   * Create a request with auth and make it against the test app
   */
  async function makeAuthRequest(
    path: string,
    options: {
      authorization?: string
      cookie?: string
      accept?: string
    } = {}
  ): Promise<Response> {
    const app = createAuthTestApp()
    const headers = new Headers()

    if (options.authorization) {
      headers.set('Authorization', options.authorization)
    }
    if (options.cookie) {
      headers.set('Cookie', options.cookie)
    }
    if (options.accept) {
      headers.set('Accept', options.accept)
    }

    const request = new Request(`https://test.collections.do${path}`, {
      method: 'GET',
      headers,
    })

    return app.fetch(request, {
      AUTH: mockAuthService,
      OAUTH: mockOAuthService,
    })
  }

  // -------------------------------------------------------------------------
  // Public Routes (should skip auth)
  // -------------------------------------------------------------------------

  describe('public routes', () => {
    it('should allow access to /login without auth', async () => {
      const response = await makeAuthRequest('/login')
      expect(response.status).toBe(200)
      const body = await response.json() as any
      expect(body.message).toBe('Login page')
    })

    it('should allow access to MCP routes without auth', async () => {
      const response = await makeAuthRequest('/mcp/test')
      expect(response.status).toBe(200)
      const body = await response.json() as any
      expect(body.message).toBe('MCP route')
    })

    it('should allow access to .well-known routes without auth', async () => {
      const response = await makeAuthRequest('/.well-known/oauth-authorization-server')
      expect(response.status).toBe(200)
      const body = await response.json() as any
      expect(body.message).toBe('OAuth metadata')
    })
  })

  // -------------------------------------------------------------------------
  // API Key Authentication
  // -------------------------------------------------------------------------

  describe('API key authentication', () => {
    it('should authenticate with valid API key', async () => {
      // Mock OAuth service to return valid API key
      mockOAuthService.fetch.mockResolvedValue(
        Response.json({
          valid: true,
          id: 'user_123',
          name: 'Test User',
          organization_id: 'org_456',
          permissions: ['read', 'write'],
        })
      )

      const response = await makeAuthRequest('/protected', {
        authorization: 'Bearer sk_test_valid_api_key_here',
      })

      expect(response.status).toBe(200)
      const body = await response.json() as any
      expect(body.user).toEqual({
        id: 'user_123',
        name: 'Test User',
        roles: ['api'],
        permissions: ['read', 'write'],
        org: 'org_456',
      })
    })

    it('should reject invalid API key', async () => {
      // Mock OAuth service to return invalid
      mockOAuthService.fetch.mockResolvedValue(
        Response.json({ valid: false, error: 'Invalid API key' })
      )

      const response = await makeAuthRequest('/protected', {
        authorization: 'Bearer sk_invalid_key',
      })

      expect(response.status).toBe(401)
      const body = await response.json() as any
      expect(body.error).toBe('Invalid API key')
    })

    it('should cache valid API key and reuse on subsequent requests', async () => {
      // First request - will hit OAuth service
      mockOAuthService.fetch.mockResolvedValue(
        Response.json({
          valid: true,
          id: 'cached_user',
          name: 'Cached User',
        })
      )

      // First request
      const response1 = await makeAuthRequest('/protected', {
        authorization: 'Bearer sk_cache_test_key',
      })
      expect(response1.status).toBe(200)
      expect(mockOAuthService.fetch).toHaveBeenCalledTimes(1)

      // Second request - should use cache
      const response2 = await makeAuthRequest('/protected', {
        authorization: 'Bearer sk_cache_test_key',
      })
      expect(response2.status).toBe(200)
      // OAuth service should NOT be called again (cache hit)
      expect(mockOAuthService.fetch).toHaveBeenCalledTimes(1)
    })

    it('should not use expired cache entries', async () => {
      // Manually add an expired cache entry
      const keyHash = await hashApiKeyLocal('sk_expired_key')
      testApiKeyCache.set(keyHash, {
        user: { id: 'old_user', name: 'Old User', roles: ['api'], permissions: [] },
        expiresAt: Date.now() - 1000, // Already expired
      })

      // Mock OAuth service for fresh validation
      mockOAuthService.fetch.mockResolvedValue(
        Response.json({
          valid: true,
          id: 'new_user',
          name: 'New User',
        })
      )

      const response = await makeAuthRequest('/protected', {
        authorization: 'Bearer sk_expired_key',
      })

      expect(response.status).toBe(200)
      const body = await response.json() as any
      // Should get the new user from fresh validation, not cached
      expect(body.user.id).toBe('new_user')
      expect(mockOAuthService.fetch).toHaveBeenCalledTimes(1)
    })

    it('should handle OAuth service errors gracefully', async () => {
      // Mock OAuth service to fail
      mockOAuthService.fetch.mockResolvedValue(
        new Response('Internal Server Error', { status: 500 })
      )

      const response = await makeAuthRequest('/protected', {
        authorization: 'Bearer sk_service_error_key',
      })

      expect(response.status).toBe(401)
      const body = await response.json() as any
      expect(body.error).toBe('Invalid API key')
    })

    it('should use default values when API key response is minimal', async () => {
      // Mock OAuth service to return minimal valid response
      mockOAuthService.fetch.mockResolvedValue(
        Response.json({ valid: true })
      )

      const response = await makeAuthRequest('/protected', {
        authorization: 'Bearer sk_minimal_response_key',
      })

      expect(response.status).toBe(200)
      const body = await response.json() as any
      expect(body.user.name).toBe('API Key User')
      expect(body.user.roles).toEqual(['api'])
      expect(body.user.permissions).toEqual([])
      expect(body.user.id).toMatch(/^api:sk_minimal_resp/)
    })
  })

  // -------------------------------------------------------------------------
  // JWT Token Authentication
  // -------------------------------------------------------------------------

  describe('JWT token authentication', () => {
    // Valid JWT format: three base64url-encoded parts separated by dots
    const validJwt = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c'

    it('should authenticate with valid JWT token', async () => {
      // Mock AUTH service to return valid user
      mockAuthService.fetch.mockResolvedValue(
        Response.json({
          user: {
            id: 'jwt_user_123',
            name: 'JWT User',
            email: 'jwt@test.com',
            roles: ['user'],
          },
        })
      )

      const response = await makeAuthRequest('/protected', {
        authorization: `Bearer ${validJwt}`,
      })

      expect(response.status).toBe(200)
      const body = await response.json() as any
      expect(body.user.id).toBe('jwt_user_123')
      expect(body.user.name).toBe('JWT User')
    })

    it('should reject invalid JWT format', async () => {
      // Token with only 2 parts (invalid format)
      const invalidJwt = 'invalid.token'

      const response = await makeAuthRequest('/protected', {
        authorization: `Bearer ${invalidJwt}`,
      })

      expect(response.status).toBe(401)
      const body = await response.json() as any
      expect(body.error).toBe('Invalid token')
      // AUTH service should NOT be called for invalid format
      expect(mockAuthService.fetch).not.toHaveBeenCalled()
    })

    it('should reject JWT when AUTH service returns null user', async () => {
      // Mock AUTH service to return null user (invalid token)
      mockAuthService.fetch.mockResolvedValue(
        Response.json({ user: null })
      )

      const response = await makeAuthRequest('/protected', {
        authorization: `Bearer ${validJwt}`,
      })

      expect(response.status).toBe(401)
      const body = await response.json() as any
      expect(body.error).toBe('Invalid token')
    })

    it('should reject JWT when AUTH service returns error', async () => {
      // Mock AUTH service to fail
      mockAuthService.fetch.mockResolvedValue(
        new Response('Unauthorized', { status: 401 })
      )

      const response = await makeAuthRequest('/protected', {
        authorization: `Bearer ${validJwt}`,
      })

      expect(response.status).toBe(401)
      const body = await response.json() as any
      expect(body.error).toBe('Invalid token')
    })

    it('should send correct request to AUTH service', async () => {
      mockAuthService.fetch.mockResolvedValue(
        Response.json({ user: { id: 'test', name: 'Test' } })
      )

      await makeAuthRequest('/protected', {
        authorization: `Bearer ${validJwt}`,
      })

      expect(mockAuthService.fetch).toHaveBeenCalledTimes(1)
      const [request] = mockAuthService.fetch.mock.calls[0] as [Request]
      expect(request.url).toBe('https://auth/user')
      expect(request.method).toBe('POST')

      const body = await request.json() as any
      expect(body.request.headers.Authorization).toBe(`Bearer ${validJwt}`)
    })
  })

  // -------------------------------------------------------------------------
  // Cookie-based Authentication
  // -------------------------------------------------------------------------

  describe('cookie-based authentication', () => {
    const validJwt = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c'

    it('should authenticate with valid JWT in cookie', async () => {
      // Mock AUTH service to return valid user
      mockAuthService.fetch.mockResolvedValue(
        Response.json({
          user: {
            id: 'cookie_user',
            name: 'Cookie User',
          },
        })
      )

      const response = await makeAuthRequest('/protected', {
        cookie: `auth=${validJwt}`,
      })

      expect(response.status).toBe(200)
      const body = await response.json() as any
      expect(body.user.id).toBe('cookie_user')
    })

    it('should clear invalid auth cookie and return 401 for API requests', async () => {
      const response = await makeAuthRequest('/protected', {
        cookie: 'auth=invalid_not_jwt_format',
        accept: 'application/json',
      })

      expect(response.status).toBe(401)
      const body = await response.json() as any
      expect(body.error).toBe('Invalid token, please re-authenticate')

      // Check that Set-Cookie headers are present to clear cookies
      const setCookies = response.headers.getSetCookie()
      expect(setCookies.length).toBeGreaterThan(0)
      expect(setCookies.some(c => c.startsWith('auth=;') || c.includes('Max-Age=0'))).toBe(true)
    })

    it('should redirect to login for invalid auth cookie on HTML requests', async () => {
      const response = await makeAuthRequest('/protected', {
        cookie: 'auth=invalid_not_jwt_format',
        accept: 'text/html',
      })

      expect(response.status).toBe(302)
      expect(response.headers.get('Location')).toContain('/login')
      expect(response.headers.get('Location')).toContain('returnTo=')
    })

    it('should pass cookie to AUTH service for verification', async () => {
      mockAuthService.fetch.mockResolvedValue(
        Response.json({ user: { id: 'test', name: 'Test' } })
      )

      await makeAuthRequest('/protected', {
        cookie: `auth=${validJwt}`,
      })

      expect(mockAuthService.fetch).toHaveBeenCalledTimes(1)
      const [request] = mockAuthService.fetch.mock.calls[0] as [Request]
      const body = await request.json() as any
      // Headers object may have lowercase keys from Object.fromEntries
      const cookieHeader = body.request.headers.Cookie || body.request.headers.cookie
      expect(cookieHeader).toBeDefined()
      expect(cookieHeader).toContain(`auth=${validJwt}`)
    })
  })

  // -------------------------------------------------------------------------
  // Missing Authentication
  // -------------------------------------------------------------------------

  describe('missing authentication', () => {
    it('should return 401 for API requests without auth', async () => {
      // Mock AUTH service to return null user (no auth)
      mockAuthService.fetch.mockResolvedValue(
        Response.json({ user: null })
      )

      const response = await makeAuthRequest('/protected', {
        accept: 'application/json',
      })

      expect(response.status).toBe(401)
      const body = await response.json() as any
      expect(body.error).toBe('Authentication required')
    })

    it('should redirect to login for HTML requests without auth', async () => {
      // Mock AUTH service to return null user (no auth)
      mockAuthService.fetch.mockResolvedValue(
        Response.json({ user: null })
      )

      const response = await makeAuthRequest('/protected', {
        accept: 'text/html',
      })

      expect(response.status).toBe(302)
      expect(response.headers.get('Location')).toContain('/login')
      expect(response.headers.get('Location')).toContain('returnTo=')
    })

    it('should include returnTo URL in login redirect', async () => {
      mockAuthService.fetch.mockResolvedValue(
        Response.json({ user: null })
      )

      const response = await makeAuthRequest('/protected?foo=bar', {
        accept: 'text/html',
      })

      expect(response.status).toBe(302)
      const location = response.headers.get('Location')
      expect(location).toContain('/login')
      expect(location).toContain(encodeURIComponent('https://test.collections.do/protected?foo=bar'))
    })
  })

  // -------------------------------------------------------------------------
  // Edge Cases
  // -------------------------------------------------------------------------

  describe('edge cases', () => {
    it('should handle empty Authorization header', async () => {
      mockAuthService.fetch.mockResolvedValue(
        Response.json({ user: null })
      )

      const response = await makeAuthRequest('/protected', {
        authorization: '',
      })

      expect(response.status).toBe(401)
    })

    it('should handle Authorization header without Bearer prefix', async () => {
      mockAuthService.fetch.mockResolvedValue(
        Response.json({ user: null })
      )

      const response = await makeAuthRequest('/protected', {
        authorization: 'Basic dXNlcjpwYXNz',
      })

      expect(response.status).toBe(401)
    })

    it('should handle JWT with empty parts', async () => {
      // JWT with empty middle part
      const emptyPartJwt = 'eyJhbGciOiJIUzI1NiJ9..signature'

      const response = await makeAuthRequest('/protected', {
        authorization: `Bearer ${emptyPartJwt}`,
      })

      expect(response.status).toBe(401)
      const body = await response.json() as any
      expect(body.error).toBe('Invalid token')
    })

    it('should prefer API key over JWT when both present (sk_ prefix)', async () => {
      mockOAuthService.fetch.mockResolvedValue(
        Response.json({
          valid: true,
          id: 'api_key_user',
          name: 'API Key User',
        })
      )

      // Authorization header with sk_ prefix should be treated as API key
      const response = await makeAuthRequest('/protected', {
        authorization: 'Bearer sk_test_api_key_here',
      })

      expect(response.status).toBe(200)
      const body = await response.json() as any
      expect(body.user.id).toBe('api_key_user')
      // OAuth service should be called (for API key), not AUTH service
      expect(mockOAuthService.fetch).toHaveBeenCalledTimes(1)
      expect(mockAuthService.fetch).not.toHaveBeenCalled()
    })
  })
})
