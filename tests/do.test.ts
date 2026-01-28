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
    return filter ? this.getCollection(collection).find(filter).length : this.getCollection(collection).count()
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
   * Returns parsed body or a 400 error Response for invalid JSON
   */
  private async parseJsonBody<T>(request: Request): Promise<T | Response> {
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
