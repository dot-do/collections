/**
 * E2E Tests for collections.do client SDK
 *
 * Tests the client against live deployed collections.do service.
 * Run in both Node.js and Workers environments.
 *
 * Prerequisites:
 * - DO_API_KEY env var (from .env file)
 * - COLLECTIONS_URL env var (optional, defaults to https://collections.do)
 *
 * Run:
 *   pnpm test:e2e           # Node.js
 *   pnpm test:e2e:workers   # Cloudflare Workers (via vitest-pool-workers)
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { Collections } from '../src/client'

const TEST_NAMESPACE = `test-${Date.now()}`
const TEST_COLLECTION = 'e2e-tests'

interface TestDoc {
  name: string
  value: number
  tags?: string[]
}

describe('collections.do client e2e', () => {
  let client: Collections
  let namespace: ReturnType<Collections['namespace']>
  let collection: ReturnType<typeof namespace.collection<TestDoc>>

  beforeAll(() => {
    const token = process.env['DO_API_KEY']
    if (!token) {
      throw new Error('DO_API_KEY environment variable required for e2e tests')
    }

    const baseUrl = process.env['COLLECTIONS_URL'] || 'https://collections.do'

    client = new Collections({ baseUrl, token })
    namespace = client.namespace(TEST_NAMESPACE)
    collection = namespace.collection<TestDoc>(TEST_COLLECTION)
  })

  afterAll(async () => {
    // Cleanup: clear test collection
    try {
      await collection.clear()
    } catch {
      // Ignore cleanup errors
    }
  })

  describe('authentication', () => {
    it('should get user info via /me', async () => {
      const me = await client.me()
      expect(me.user).toBeDefined()
      expect(me.user.id).toBeDefined()
      expect(me.defaultNamespace).toBeDefined()
    })
  })

  describe('basic CRUD operations', () => {
    const testId = 'test-doc-1'
    const testDoc: TestDoc = { name: 'Test Document', value: 42, tags: ['a', 'b'] }

    it('should put a document', async () => {
      await collection.put(testId, testDoc)
      // No error means success
    })

    it('should get a document', async () => {
      const doc = await collection.get(testId)
      expect(doc).toBeDefined()
      expect(doc?.name).toBe(testDoc.name)
      expect(doc?.value).toBe(testDoc.value)
      expect(doc?.tags).toEqual(testDoc.tags)
    })

    it('should return null for non-existent document', async () => {
      const doc = await collection.get('non-existent-id')
      expect(doc).toBeNull()
    })

    it('should check document existence with has()', async () => {
      const exists = await collection.has(testId)
      expect(exists).toBe(true)

      const notExists = await collection.has('non-existent-id')
      expect(notExists).toBe(false)
    })

    it('should update a document', async () => {
      const updatedDoc: TestDoc = { name: 'Updated Document', value: 100 }
      await collection.put(testId, updatedDoc)

      const doc = await collection.get(testId)
      expect(doc?.name).toBe('Updated Document')
      expect(doc?.value).toBe(100)
    })

    it('should delete a document', async () => {
      const deleted = await collection.delete(testId)
      expect(deleted).toBe(true)

      const doc = await collection.get(testId)
      expect(doc).toBeNull()
    })

    it('should return false when deleting non-existent document', async () => {
      const deleted = await collection.delete('non-existent-id')
      expect(deleted).toBe(false)
    })
  })

  describe('bulk operations', () => {
    const docs: Array<{ id: string; doc: TestDoc }> = [
      { id: 'bulk-1', doc: { name: 'Bulk 1', value: 1 } },
      { id: 'bulk-2', doc: { name: 'Bulk 2', value: 2 } },
      { id: 'bulk-3', doc: { name: 'Bulk 3', value: 3 } },
    ]

    it('should put multiple documents', async () => {
      const result = await collection.putMany(docs)
      expect(result.count).toBe(3)
      expect(result.success).toBe(true)
    })

    it('should get multiple documents', async () => {
      const results = await collection.getMany(['bulk-1', 'bulk-2', 'non-existent'])
      expect(results).toHaveLength(3)
      expect(results[0]?.name).toBe('Bulk 1')
      expect(results[1]?.name).toBe('Bulk 2')
      expect(results[2]).toBeNull()
    })

    it('should delete multiple documents', async () => {
      const result = await collection.deleteMany(['bulk-1', 'bulk-2', 'bulk-3'])
      expect(result.count).toBe(3)
    })
  })

  describe('queries', () => {
    beforeAll(async () => {
      // Setup test data
      await collection.putMany([
        { id: 'q1', doc: { name: 'Alice', value: 10 } },
        { id: 'q2', doc: { name: 'Bob', value: 20 } },
        { id: 'q3', doc: { name: 'Charlie', value: 30 } },
        { id: 'q4', doc: { name: 'Diana', value: 40 } },
        { id: 'q5', doc: { name: 'Eve', value: 50 } },
      ])
    })

    afterAll(async () => {
      await collection.deleteMany(['q1', 'q2', 'q3', 'q4', 'q5'])
    })

    it('should list all documents', async () => {
      const docs = await collection.list()
      expect(docs.length).toBeGreaterThanOrEqual(5)
    })

    it('should list with limit', async () => {
      const docs = await collection.list({ limit: 2 })
      expect(docs).toHaveLength(2)
    })

    it('should find documents with filter', async () => {
      const docs = await collection.find({ value: { $gt: 25 } })
      expect(docs.length).toBeGreaterThanOrEqual(3)
      docs.forEach((doc) => {
        expect(doc.value).toBeGreaterThan(25)
      })
    })

    it('should find with equality filter', async () => {
      const docs = await collection.find({ name: 'Alice' })
      expect(docs).toHaveLength(1)
      expect(docs[0]?.name).toBe('Alice')
    })

    it('should count documents', async () => {
      const count = await collection.count()
      expect(count).toBeGreaterThanOrEqual(5)
    })

    it('should count with filter', async () => {
      const count = await collection.count({ value: { $gte: 30 } })
      expect(count).toBeGreaterThanOrEqual(3)
    })

    it('should get all keys', async () => {
      const keys = await collection.keys()
      expect(keys).toContain('q1')
      expect(keys).toContain('q5')
    })
  })

  describe('clear', () => {
    it('should clear all documents', async () => {
      // Add some docs
      await collection.putMany([
        { id: 'clear-1', doc: { name: 'Clear 1', value: 1 } },
        { id: 'clear-2', doc: { name: 'Clear 2', value: 2 } },
      ])

      const result = await collection.clear()
      expect(result.success).toBe(true)

      const count = await collection.count()
      expect(count).toBe(0)
    })
  })
})
