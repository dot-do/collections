/**
 * E2E Tests for collections.do client SDK - Workers Runtime
 *
 * Tests the client in Cloudflare Workers environment against live service.
 * Uses vitest-pool-workers to run tests in the workerd runtime.
 *
 * Run:
 *   pnpm test:e2e:workers
 */

import { describe, it, expect, beforeAll, afterAll, env } from 'vitest'
import { Collections } from '../../src/client'

// Type the env bindings
interface Env {
  DO_API_KEY: string
  COLLECTIONS_URL?: string
}

const TEST_NAMESPACE = `test-workers-${Date.now()}`
const TEST_COLLECTION = 'e2e-workers'

interface TestDoc {
  name: string
  value: number
}

describe('collections.do client e2e (Workers runtime)', () => {
  let client: Collections
  let collection: ReturnType<ReturnType<Collections['namespace']>['collection']<TestDoc>>

  beforeAll(() => {
    // In Workers pool, env is available via vitest
    const token = (env as unknown as Env).DO_API_KEY
    if (!token) {
      throw new Error('DO_API_KEY binding required for Workers e2e tests')
    }

    const baseUrl = (env as unknown as Env).COLLECTIONS_URL || 'https://collections.do'

    client = new Collections({ baseUrl, token })
    collection = client.namespace(TEST_NAMESPACE).collection<TestDoc>(TEST_COLLECTION)
  })

  afterAll(async () => {
    try {
      await collection.clear()
    } catch {
      // Ignore cleanup errors
    }
  })

  it('should authenticate and get user info', async () => {
    const me = await client.me()
    expect(me.user).toBeDefined()
    expect(me.user.id).toBeDefined()
  })

  it('should perform CRUD operations', async () => {
    const testDoc: TestDoc = { name: 'Workers Test', value: 123 }

    // Create
    await collection.put('workers-test', testDoc)

    // Read
    const doc = await collection.get('workers-test')
    expect(doc?.name).toBe('Workers Test')
    expect(doc?.value).toBe(123)

    // Update
    await collection.put('workers-test', { name: 'Updated', value: 456 })
    const updated = await collection.get('workers-test')
    expect(updated?.value).toBe(456)

    // Delete
    const deleted = await collection.delete('workers-test')
    expect(deleted).toBe(true)

    const gone = await collection.get('workers-test')
    expect(gone).toBeNull()
  })

  it('should query documents', async () => {
    await collection.putMany([
      { id: 'w1', doc: { name: 'One', value: 1 } },
      { id: 'w2', doc: { name: 'Two', value: 2 } },
      { id: 'w3', doc: { name: 'Three', value: 3 } },
    ])

    const docs = await collection.find({ value: { $gte: 2 } })
    expect(docs.length).toBeGreaterThanOrEqual(2)

    const count = await collection.count()
    expect(count).toBeGreaterThanOrEqual(3)

    await collection.deleteMany(['w1', 'w2', 'w3'])
  })

  it('should handle fetch correctly in Workers runtime', async () => {
    // Verify that the native fetch is being used correctly
    // This tests that the client works with Workers' fetch implementation
    const list = await collection.list({ limit: 1 })
    expect(Array.isArray(list)).toBe(true)
  })
})
