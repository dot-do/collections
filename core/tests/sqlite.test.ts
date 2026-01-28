/**
 * SQLite-backed Collection Tests
 *
 * Tests for the SQL-backed collection implementation using sql.js to simulate SQLite
 * This tests the actual SQL queries and schema, not just the in-memory mock.
 */

import { describe, it, expect, beforeEach, afterEach, beforeAll, vi } from 'vitest'
import initSqlJs, { type Database } from 'sql.js'
import { createCollection, Collections, type Collection } from '../src'

// ============================================================================
// sql.js Mock SqlStorage Implementation
// ============================================================================

// sql.js instance (loaded once)
let SQL: Awaited<ReturnType<typeof initSqlJs>>

// Schema for _collections table (copied from collection.ts)
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
// Test Types
// ============================================================================

interface User {
  name: string
  email: string
  age: number
  active: boolean
  role?: string
  metadata?: Record<string, unknown>
}

interface Product {
  name: string
  price: number
  category: string
  inStock: boolean
  tags?: string[]
}

// ============================================================================
// Test Setup
// ============================================================================

let mockSql: MockSqlStorage
let db: Database

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
})

afterEach(() => {
  if (mockSql) {
    mockSql.close()
  }
})

// ============================================================================
// SQLite-backed createCollection Tests
// ============================================================================

describe('SQLite-backed createCollection', () => {
  describe('Basic CRUD Operations', () => {
    it('should insert and retrieve a document', () => {
      const users = createCollection<User>(mockSql as unknown as SqlStorage, 'users')

      users.put('user1', { name: 'Alice', email: 'alice@example.com', age: 30, active: true })

      const retrieved = users.get('user1')
      expect(retrieved).toEqual({ name: 'Alice', email: 'alice@example.com', age: 30, active: true })
    })

    it('should update an existing document', () => {
      const users = createCollection<User>(mockSql as unknown as SqlStorage, 'users')

      users.put('user1', { name: 'Alice', email: 'alice@example.com', age: 30, active: true })
      users.put('user1', { name: 'Alice Updated', email: 'alice.new@example.com', age: 31, active: false })

      const retrieved = users.get('user1')
      expect(retrieved).toEqual({ name: 'Alice Updated', email: 'alice.new@example.com', age: 31, active: false })
    })

    it('should delete a document', () => {
      const users = createCollection<User>(mockSql as unknown as SqlStorage, 'users')

      users.put('user1', { name: 'Alice', email: 'alice@example.com', age: 30, active: true })

      const deleted = users.delete('user1')
      expect(deleted).toBe(true)
      expect(users.get('user1')).toBeNull()
    })

    it('should return false when deleting non-existent document', () => {
      const users = createCollection<User>(mockSql as unknown as SqlStorage, 'users')

      const deleted = users.delete('nonexistent')
      expect(deleted).toBe(false)
    })

    it('should check document existence with has()', () => {
      const users = createCollection<User>(mockSql as unknown as SqlStorage, 'users')

      users.put('user1', { name: 'Alice', email: 'alice@example.com', age: 30, active: true })

      expect(users.has('user1')).toBe(true)
      expect(users.has('nonexistent')).toBe(false)
    })
  })

  describe('Filter Operations', () => {
    let products: Collection<Product>

    beforeEach(() => {
      products = createCollection<Product>(mockSql as unknown as SqlStorage, 'products')

      products.put('p1', { name: 'Laptop', price: 999, category: 'electronics', inStock: true })
      products.put('p2', { name: 'Phone', price: 599, category: 'electronics', inStock: true })
      products.put('p3', { name: 'Chair', price: 149, category: 'furniture', inStock: false })
      products.put('p4', { name: 'Desk', price: 299, category: 'furniture', inStock: true })
    })

    it('should filter with $eq operator', () => {
      const results = products.find({ category: { $eq: 'electronics' } })
      expect(results.length).toBe(2)
      expect(results.every((p) => p.category === 'electronics')).toBe(true)
    })

    it('should filter with $gt operator', () => {
      const results = products.find({ price: { $gt: 500 } })
      expect(results.length).toBe(2)
      expect(results.every((p) => p.price > 500)).toBe(true)
    })

    it('should filter with $in operator', () => {
      const results = products.find({ price: { $in: [149, 999] } })
      expect(results.length).toBe(2)
    })

    it('should filter with $and operator', () => {
      const results = products.find({
        $and: [{ category: 'electronics' }, { inStock: true }],
      })
      expect(results.length).toBe(2)
    })

    it('should filter with $or operator', () => {
      const results = products.find({
        $or: [{ category: 'furniture' }, { price: { $gt: 900 } }],
      })
      expect(results.length).toBe(3) // Chair, Desk, Laptop
    })

    it('should filter with $regex operator', () => {
      const results = products.find({ name: { $regex: '^[A-M]' } })
      expect(results.length).toBe(3) // Laptop, Chair, Desk (L, C, D in A-M)
    })
  })

  describe('Query Options', () => {
    let products: Collection<Product>

    beforeEach(() => {
      products = createCollection<Product>(mockSql as unknown as SqlStorage, 'products')

      products.put('p1', { name: 'Alpha', price: 100, category: 'a', inStock: true })
      products.put('p2', { name: 'Beta', price: 200, category: 'b', inStock: true })
      products.put('p3', { name: 'Gamma', price: 300, category: 'c', inStock: true })
    })

    it('should limit results', () => {
      const results = products.list({ limit: 2 })
      expect(results.length).toBe(2)
    })

    it('should sort ascending', () => {
      const results = products.find({}, { sort: 'name' })
      expect(results.map((p) => p.name)).toEqual(['Alpha', 'Beta', 'Gamma'])
    })

    it('should sort descending with - prefix', () => {
      const results = products.find({}, { sort: '-price' })
      expect(results.map((p) => p.price)).toEqual([300, 200, 100])
    })

    it('should paginate with offset and limit', () => {
      const page1 = products.find({}, { sort: 'name', limit: 1, offset: 0 })
      const page2 = products.find({}, { sort: 'name', limit: 1, offset: 1 })
      const page3 = products.find({}, { sort: 'name', limit: 1, offset: 2 })

      expect(page1.map((p) => p.name)).toEqual(['Alpha'])
      expect(page2.map((p) => p.name)).toEqual(['Beta'])
      expect(page3.map((p) => p.name)).toEqual(['Gamma'])
    })
  })

  describe('Collection Utilities', () => {
    it('should return all keys', () => {
      const users = createCollection<User>(mockSql as unknown as SqlStorage, 'users')

      users.put('c', { name: 'C', email: 'c@test.com', age: 30, active: true })
      users.put('a', { name: 'A', email: 'a@test.com', age: 25, active: true })
      users.put('b', { name: 'B', email: 'b@test.com', age: 35, active: false })

      const keys = users.keys()
      expect(keys).toEqual(['a', 'b', 'c'])
    })

    it('should count documents', () => {
      const users = createCollection<User>(mockSql as unknown as SqlStorage, 'users')

      users.put('u1', { name: 'Alice', email: 'a@test.com', age: 30, active: true })
      users.put('u2', { name: 'Bob', email: 'b@test.com', age: 25, active: false })

      expect(users.count()).toBe(2)
      expect(users.find({ active: true }).length).toBe(1)
    })

    it('should count documents with filter', () => {
      const users = createCollection<User>(mockSql as unknown as SqlStorage, 'users')

      users.put('u1', { name: 'Alice', email: 'a@test.com', age: 30, active: true })
      users.put('u2', { name: 'Bob', email: 'b@test.com', age: 25, active: true })
      users.put('u3', { name: 'Charlie', email: 'c@test.com', age: 35, active: false })

      // count() with filter should use SQL COUNT(*) directly, not find().length
      expect(users.count({ active: true })).toBe(2)
      expect(users.count({ active: false })).toBe(1)
      expect(users.count({ age: { $gt: 28 } })).toBe(2)
      expect(users.count({ name: 'NonExistent' })).toBe(0)
    })

    it('should clear all documents', () => {
      const users = createCollection<User>(mockSql as unknown as SqlStorage, 'users')

      users.put('u1', { name: 'Alice', email: 'a@test.com', age: 30, active: true })
      users.put('u2', { name: 'Bob', email: 'b@test.com', age: 25, active: true })

      const deleted = users.clear()
      expect(deleted).toBe(2)
      expect(users.count()).toBe(0)
    })
  })

  describe('Collection Isolation', () => {
    it('should isolate data between collections', () => {
      const users = createCollection<User>(mockSql as unknown as SqlStorage, 'users')
      const products = createCollection<Product>(mockSql as unknown as SqlStorage, 'products')

      users.put('id1', { name: 'Alice', email: 'a@test.com', age: 30, active: true })
      products.put('id1', { name: 'Laptop', price: 999, category: 'electronics', inStock: true })

      expect(users.get('id1')?.name).toBe('Alice')
      expect(products.get('id1')?.name).toBe('Laptop')
    })

    it('should have independent counts', () => {
      const users = createCollection<User>(mockSql as unknown as SqlStorage, 'users')
      const products = createCollection<Product>(mockSql as unknown as SqlStorage, 'products')

      users.put('u1', { name: 'Alice', email: 'a@test.com', age: 30, active: true })
      users.put('u2', { name: 'Bob', email: 'b@test.com', age: 25, active: true })
      products.put('p1', { name: 'Laptop', price: 999, category: 'electronics', inStock: true })

      expect(users.count()).toBe(2)
      expect(products.count()).toBe(1)
    })

    it('should have independent clear operations', () => {
      const users = createCollection<User>(mockSql as unknown as SqlStorage, 'users')
      const products = createCollection<Product>(mockSql as unknown as SqlStorage, 'products')

      users.put('u1', { name: 'Alice', email: 'a@test.com', age: 30, active: true })
      products.put('p1', { name: 'Laptop', price: 999, category: 'electronics', inStock: true })

      users.clear()

      expect(users.count()).toBe(0)
      expect(products.count()).toBe(1)
    })
  })

  describe('Input Validation', () => {
    it('should reject empty string ID', () => {
      const users = createCollection<User>(mockSql as unknown as SqlStorage, 'users')

      expect(() => {
        users.put('', { name: 'Empty ID', email: 'empty@test.com', age: 30, active: true })
      }).toThrow('Document ID must be a non-empty string')
    })

    it('should reject null document', () => {
      const users = createCollection<User>(mockSql as unknown as SqlStorage, 'users')

      expect(() => {
        users.put('u1', null as any)
      }).toThrow('Document must be a non-null object')
    })

    it('should reject array as document', () => {
      const users = createCollection<User>(mockSql as unknown as SqlStorage, 'users')

      expect(() => {
        users.put('u1', ['item1', 'item2'] as any)
      }).toThrow('Document must be a non-null object')
    })

    it('should reject offset without limit', () => {
      const users = createCollection<User>(mockSql as unknown as SqlStorage, 'users')
      users.put('u1', { name: 'Alice', email: 'a@test.com', age: 30, active: true })

      expect(() => {
        users.find({}, { offset: 1 })
      }).toThrow('offset requires limit to be specified')
    })
  })

  describe('SQL Injection Prevention', () => {
    it('should reject field names with SQL injection attempts', () => {
      const users = createCollection<User>(mockSql as unknown as SqlStorage, 'users')
      users.put('u1', { name: 'Alice', email: 'a@test.com', age: 30, active: true })

      expect(() => {
        users.find({ "name'); DROP TABLE _collections; --": 'test' } as any)
      }).toThrow('Invalid field name')
    })

    it('should handle SQL injection values safely via parameterization', () => {
      const users = createCollection<User>(mockSql as unknown as SqlStorage, 'users')
      users.put('u1', { name: 'Alice', email: 'a@test.com', age: 30, active: true })

      const results = users.find({ name: { $eq: "'; DROP TABLE _collections; --" } })
      expect(results.length).toBe(0)

      // Verify table still exists
      expect(users.get('u1')).not.toBeNull()
    })
  })
})

// ============================================================================
// Collections Manager Tests
// ============================================================================

describe('Collections Manager', () => {
  describe('collection() - getting/creating collections', () => {
    it('should create and return a collection', () => {
      const collections = new Collections(mockSql as unknown as SqlStorage)

      const users = collections.collection<User>('users')
      users.put('u1', { name: 'Alice', email: 'alice@test.com', age: 30, active: true })

      expect(users.get('u1')?.name).toBe('Alice')
    })

    it('should return the same collection instance for same name', () => {
      const collections = new Collections(mockSql as unknown as SqlStorage)

      const users1 = collections.collection('users')
      const users2 = collections.collection('users')

      expect(users1).toBe(users2)
    })

    it('should return different instances for different names', () => {
      const collections = new Collections(mockSql as unknown as SqlStorage)

      const users = collections.collection('users')
      const products = collections.collection('products')

      expect(users).not.toBe(products)
    })

    it('should allow typed collections', () => {
      const collections = new Collections(mockSql as unknown as SqlStorage)

      const users = collections.collection<User>('users')
      users.put('u1', { name: 'Alice', email: 'alice@test.com', age: 30, active: true })

      const user = users.get('u1')
      // TypeScript should know these properties exist
      expect(user?.name).toBe('Alice')
      expect(user?.email).toBe('alice@test.com')
    })
  })

  describe('names() - listing collection names', () => {
    it('should return all collection names', () => {
      const collections = new Collections(mockSql as unknown as SqlStorage)

      collections.collection('users').put('u1', { name: 'Alice' })
      collections.collection('products').put('p1', { name: 'Laptop' })
      collections.collection('orders').put('o1', { id: 1 })

      const names = collections.names()
      expect(names.sort()).toEqual(['orders', 'products', 'users'])
    })

    it('should return sorted collection names', () => {
      const collections = new Collections(mockSql as unknown as SqlStorage)

      collections.collection('zebra').put('z1', {})
      collections.collection('alpha').put('a1', {})
      collections.collection('beta').put('b1', {})

      const names = collections.names()
      expect(names).toEqual(['alpha', 'beta', 'zebra'])
    })

    it('should return empty array when no collections exist', () => {
      const collections = new Collections(mockSql as unknown as SqlStorage)

      const names = collections.names()
      expect(names).toEqual([])
    })

    it('should not include collections that have been completely cleared', () => {
      const collections = new Collections(mockSql as unknown as SqlStorage)

      collections.collection('users').put('u1', { name: 'Alice' })
      collections.collection('temp').put('t1', { value: 'temporary' })

      // Drop the temp collection
      collections.drop('temp')

      const names = collections.names()
      expect(names).toEqual(['users'])
    })
  })

  describe('drop() - dropping collections', () => {
    it('should delete all documents in collection and return count', () => {
      const collections = new Collections(mockSql as unknown as SqlStorage)

      collections.collection('users').put('u1', { name: 'Alice' })
      collections.collection('users').put('u2', { name: 'Bob' })

      const deleted = collections.drop('users')
      expect(deleted).toBe(2)
    })

    it('should return 0 when collection does not exist', () => {
      const collections = new Collections(mockSql as unknown as SqlStorage)

      const deleted = collections.drop('nonexistent')
      expect(deleted).toBe(0)
    })

    it('should remove collection from cache', () => {
      const collections = new Collections(mockSql as unknown as SqlStorage)

      const users1 = collections.collection('users')
      users1.put('u1', { name: 'Alice' })

      collections.drop('users')

      // Getting the collection again should create a new instance
      const users2 = collections.collection('users')
      expect(users2.count()).toBe(0)
    })

    it('should not affect other collections', () => {
      const collections = new Collections(mockSql as unknown as SqlStorage)

      collections.collection('users').put('u1', { name: 'Alice' })
      collections.collection('products').put('p1', { name: 'Laptop' })

      collections.drop('users')

      expect(collections.collection('products').count()).toBe(1)
    })
  })

  describe('stats() - getting statistics', () => {
    it('should return stats for all collections', () => {
      const collections = new Collections(mockSql as unknown as SqlStorage)

      collections.collection('users').put('u1', { name: 'Alice', email: 'alice@example.com' })
      collections.collection('users').put('u2', { name: 'Bob', email: 'bob@example.com' })
      collections.collection('products').put('p1', { name: 'Laptop', price: 999 })

      const stats = collections.stats()

      expect(stats.length).toBe(2)

      const usersStats = stats.find((s) => s.name === 'users')
      expect(usersStats).toBeDefined()
      expect(usersStats!.count).toBe(2)
      expect(usersStats!.size).toBeGreaterThan(0)

      const productsStats = stats.find((s) => s.name === 'products')
      expect(productsStats).toBeDefined()
      expect(productsStats!.count).toBe(1)
    })

    it('should return empty array when no collections exist', () => {
      const collections = new Collections(mockSql as unknown as SqlStorage)

      const stats = collections.stats()
      expect(stats).toEqual([])
    })

    it('should calculate size based on data length', () => {
      const collections = new Collections(mockSql as unknown as SqlStorage)

      const largeData = 'x'.repeat(1000)
      collections.collection('large').put('l1', { content: largeData })
      collections.collection('small').put('s1', { x: 1 })

      const stats = collections.stats()

      const largeStats = stats.find((s) => s.name === 'large')
      const smallStats = stats.find((s) => s.name === 'small')

      expect(largeStats!.size).toBeGreaterThan(smallStats!.size)
    })

    it('should update stats after operations', () => {
      const collections = new Collections(mockSql as unknown as SqlStorage)

      collections.collection('users').put('u1', { name: 'Alice' })
      let stats = collections.stats()
      expect(stats.find((s) => s.name === 'users')!.count).toBe(1)

      collections.collection('users').put('u2', { name: 'Bob' })
      stats = collections.stats()
      expect(stats.find((s) => s.name === 'users')!.count).toBe(2)

      collections.collection('users').delete('u1')
      stats = collections.stats()
      expect(stats.find((s) => s.name === 'users')!.count).toBe(1)
    })
  })
})

// ============================================================================
// Collection Name SQL Injection Tests
// ============================================================================

describe('Collection Name Validation', () => {
  describe('SQL injection prevention via collection names', () => {
    it('should safely handle collection names with single quotes', () => {
      const collections = new Collections(mockSql as unknown as SqlStorage)

      // This should not cause SQL injection - the name is used as a parameter
      const dangerousName = "users'; DROP TABLE _collections; --"
      const col = collections.collection(dangerousName)

      col.put('doc1', { value: 'test' })

      // Verify the document was stored
      expect(col.get('doc1')).toEqual({ value: 'test' })

      // Verify the table still exists by checking another collection
      const safeCol = collections.collection('safe')
      safeCol.put('s1', { data: 'safe' })
      expect(safeCol.get('s1')).toEqual({ data: 'safe' })
    })

    it('should safely handle collection names with double quotes', () => {
      const collections = new Collections(mockSql as unknown as SqlStorage)

      const dangerousName = 'users"; DROP TABLE _collections; --'
      const col = collections.collection(dangerousName)

      col.put('doc1', { value: 'test' })
      expect(col.get('doc1')).toEqual({ value: 'test' })
    })

    it('should safely handle collection names with SQL keywords', () => {
      const collections = new Collections(mockSql as unknown as SqlStorage)

      const dangerousNames = ['SELECT * FROM users', 'DROP TABLE _collections', 'DELETE FROM _collections', '1=1 OR']

      for (const name of dangerousNames) {
        const col = collections.collection(name)
        col.put('doc1', { value: name })
        expect(col.get('doc1')?.value).toBe(name)
      }
    })

    it('should safely handle collection names with semicolons', () => {
      const collections = new Collections(mockSql as unknown as SqlStorage)

      const dangerousName = 'users; DROP TABLE _collections'
      const col = collections.collection(dangerousName)

      col.put('doc1', { value: 'test' })
      expect(col.get('doc1')).toEqual({ value: 'test' })
    })

    it('should safely handle collection names with parentheses', () => {
      const collections = new Collections(mockSql as unknown as SqlStorage)

      const dangerousName = 'users()'
      const col = collections.collection(dangerousName)

      col.put('doc1', { value: 'test' })
      expect(col.get('doc1')).toEqual({ value: 'test' })
    })

    it('should safely handle collection names with null bytes', () => {
      const collections = new Collections(mockSql as unknown as SqlStorage)

      const dangerousName = 'users\x00DROP'
      const col = collections.collection(dangerousName)

      col.put('doc1', { value: 'test' })
      expect(col.get('doc1')).toEqual({ value: 'test' })
    })

    it('should handle empty collection name gracefully', () => {
      const collections = new Collections(mockSql as unknown as SqlStorage)

      const col = collections.collection('')
      col.put('doc1', { value: 'test' })
      expect(col.get('doc1')).toEqual({ value: 'test' })
    })

    it('should isolate collections with similar malicious names', () => {
      const collections = new Collections(mockSql as unknown as SqlStorage)

      const name1 = "users'; --"
      const name2 = "users'; --x"

      const col1 = collections.collection(name1)
      const col2 = collections.collection(name2)

      col1.put('doc1', { value: 'from col1' })
      col2.put('doc1', { value: 'from col2' })

      expect(col1.get('doc1')?.value).toBe('from col1')
      expect(col2.get('doc1')?.value).toBe('from col2')
    })
  })

  describe('Collection name in names() and stats()', () => {
    it('should correctly list collections with special characters', () => {
      const collections = new Collections(mockSql as unknown as SqlStorage)

      const specialNames = ["test's collection", 'test"s collection', 'test;drop', 'test--comment']

      for (const name of specialNames) {
        collections.collection(name).put('doc1', { value: 'test' })
      }

      const names = collections.names()
      expect(names.length).toBe(4)

      for (const name of specialNames) {
        expect(names).toContain(name)
      }
    })

    it('should correctly drop collections with special characters', () => {
      const collections = new Collections(mockSql as unknown as SqlStorage)

      const specialName = "malicious'; DROP TABLE users; --"
      const col = collections.collection(specialName)
      col.put('doc1', { value: 'test' })

      expect(col.count()).toBe(1)

      const deleted = collections.drop(specialName)
      expect(deleted).toBe(1)
      expect(col.count()).toBe(0)
    })
  })
})
