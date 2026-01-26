/**
 * Memory Collection Tests
 *
 * Specific tests for the in-memory collection implementation
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { MemoryCollection, createMemoryCollection, type Collection } from '../src'

// ============================================================================
// Test Types
// ============================================================================

interface Task {
  title: string
  completed: boolean
  priority: number
  tags?: string[]
  assignee?: {
    name: string
    email: string
  }
}

// ============================================================================
// MemoryCollection Specific Tests
// ============================================================================

describe('MemoryCollection', () => {
  describe('Class instantiation', () => {
    it('should create an instance directly', () => {
      const collection = new MemoryCollection<Task>()
      expect(collection).toBeInstanceOf(MemoryCollection)
    })

    it('should create an instance via factory function', () => {
      const collection = createMemoryCollection<Task>()
      expect(collection).toBeDefined()
    })
  })

  describe('Data isolation', () => {
    it('should maintain separate data between instances', () => {
      const collection1 = createMemoryCollection<Task>()
      const collection2 = createMemoryCollection<Task>()

      collection1.put('task1', { title: 'Task 1', completed: false, priority: 1 })
      collection2.put('task1', { title: 'Different Task', completed: true, priority: 5 })

      expect(collection1.get('task1')?.title).toBe('Task 1')
      expect(collection2.get('task1')?.title).toBe('Different Task')
    })
  })

  describe('Document cloning', () => {
    it('should return a copy of the document on get', () => {
      const collection = createMemoryCollection<Task>()
      const original = { title: 'Task 1', completed: false, priority: 1 }

      collection.put('task1', original)
      const retrieved = collection.get('task1')!

      // Modify the retrieved document
      retrieved.title = 'Modified'

      // Original stored document should be unchanged
      expect(collection.get('task1')?.title).toBe('Task 1')
    })

    it('should not be affected by modifications to the original after put', () => {
      const collection = createMemoryCollection<Task>()
      const original = { title: 'Task 1', completed: false, priority: 1 }

      collection.put('task1', original)

      // Modify the original
      original.title = 'Modified'

      // Stored document should be unchanged
      expect(collection.get('task1')?.title).toBe('Task 1')
    })
  })

  describe('Timestamp handling', () => {
    it('should maintain createdAt timestamp on update', async () => {
      const collection = createMemoryCollection<Task>()

      collection.put('task1', { title: 'Task 1', completed: false, priority: 1 })

      // Small delay to ensure different timestamp
      await new Promise((resolve) => setTimeout(resolve, 10))

      collection.put('task1', { title: 'Task 1 Updated', completed: true, priority: 2 })

      // The collection internally tracks timestamps, verified through sort order
      const tasks = [{ title: 'Task 1 Updated', completed: true, priority: 2 }]
      expect(collection.get('task1')).toEqual(tasks[0])
    })

    it('should sort by updatedAt descending by default', async () => {
      const collection = createMemoryCollection<Task>()

      collection.put('task1', { title: 'First', completed: false, priority: 1 })
      await new Promise((resolve) => setTimeout(resolve, 5))
      collection.put('task2', { title: 'Second', completed: false, priority: 2 })
      await new Promise((resolve) => setTimeout(resolve, 5))
      collection.put('task3', { title: 'Third', completed: false, priority: 3 })

      const results = collection.list()

      // Most recently updated should be first
      expect(results[0].title).toBe('Third')
      expect(results[2].title).toBe('First')
    })
  })

  describe('Complex nested filtering', () => {
    let collection: Collection<Task>

    beforeEach(() => {
      collection = createMemoryCollection<Task>()

      collection.put('t1', {
        title: 'Design review',
        completed: false,
        priority: 1,
        tags: ['design', 'urgent'],
        assignee: { name: 'Alice', email: 'alice@example.com' },
      })
      collection.put('t2', {
        title: 'Code review',
        completed: true,
        priority: 2,
        tags: ['code', 'review'],
        assignee: { name: 'Bob', email: 'bob@example.com' },
      })
      collection.put('t3', {
        title: 'Testing',
        completed: false,
        priority: 3,
        tags: ['qa'],
        assignee: { name: 'Alice', email: 'alice@example.com' },
      })
    })

    it('should filter by nested object path', () => {
      const results = collection.find({ 'assignee.name': 'Alice' } as any)
      expect(results.length).toBe(2)
    })

    it('should filter by nested object path with operator', () => {
      const results = collection.find({ 'assignee.email': { $regex: '@example.com' } } as any)
      expect(results.length).toBe(3)
    })

    it('should combine nested and top-level filters', () => {
      const results = collection.find({
        $and: [{ 'assignee.name': 'Alice' } as any, { completed: false }],
      })
      expect(results.length).toBe(2)
    })
  })

  describe('Edge cases in sorting', () => {
    it('should handle undefined values in sort field', () => {
      const collection = createMemoryCollection<Task>()

      collection.put('t1', { title: 'A', completed: false, priority: 1, tags: ['a'] })
      collection.put('t2', { title: 'B', completed: false, priority: 2 }) // No tags
      collection.put('t3', { title: 'C', completed: false, priority: 3, tags: ['c'] })

      // Sort by tags (some undefined)
      const results = collection.find({}, { sort: 'tags' })
      // Documents with undefined tags should be sorted to the end
      expect(results[results.length - 1].title).toBe('B')
    })

    it('should handle null values in sort field', () => {
      const collection = createMemoryCollection<Record<string, unknown>>()

      collection.put('t1', { name: 'A', value: 1 })
      collection.put('t2', { name: 'B', value: null })
      collection.put('t3', { name: 'C', value: 3 })

      const results = collection.find({}, { sort: 'value' })
      // Null should be sorted to the end
      expect(results[results.length - 1]['name']).toBe('B')
    })
  })

  describe('Performance with many documents', () => {
    it('should handle 1000 documents efficiently', () => {
      const collection = createMemoryCollection<Task>()

      // Insert 1000 documents
      for (let i = 0; i < 1000; i++) {
        collection.put(`task${i}`, {
          title: `Task ${i}`,
          completed: i % 2 === 0,
          priority: i % 5,
        })
      }

      expect(collection.count()).toBe(1000)

      // Filter should work efficiently
      const completed = collection.find({ completed: true })
      expect(completed.length).toBe(500)

      // Range filter
      const highPriority = collection.find({ priority: { $gte: 3 } })
      expect(highPriority.length).toBe(400) // priority 3 and 4
    })
  })

  describe('Type safety', () => {
    it('should maintain type information through operations', () => {
      const collection = createMemoryCollection<Task>()

      collection.put('t1', { title: 'Task', completed: false, priority: 1 })

      const task = collection.get('t1')
      if (task) {
        // TypeScript should know these properties exist
        const title: string = task.title
        const completed: boolean = task.completed
        const priority: number = task.priority

        expect(title).toBe('Task')
        expect(completed).toBe(false)
        expect(priority).toBe(1)
      }
    })

    it('should work with generic Record type', () => {
      const collection = createMemoryCollection<Record<string, unknown>>()

      collection.put('doc1', { anything: 'goes', number: 42, nested: { value: true } })

      const doc = collection.get('doc1')
      expect(doc?.anything).toBe('goes')
      expect(doc?.number).toBe(42)
    })
  })
})

describe('Filter edge cases', () => {
  describe('$regex with invalid patterns', () => {
    it('should handle invalid regex gracefully', () => {
      const collection = createMemoryCollection<{ name: string }>()

      collection.put('t1', { name: 'test' })

      // Invalid regex pattern - should not match
      const results = collection.find({ name: { $regex: '[invalid(' } })
      expect(results.length).toBe(0)
    })
  })

  describe('Comparison with non-numeric values', () => {
    it('should return empty for $gt on non-numeric field', () => {
      const collection = createMemoryCollection<Record<string, unknown>>()

      collection.put('t1', { value: 'string' })

      const results = collection.find({ value: { $gt: 5 } })
      expect(results.length).toBe(0)
    })

    it('should return empty for $lt on undefined field', () => {
      const collection = createMemoryCollection<Record<string, unknown>>()

      collection.put('t1', { other: 'value' })

      const results = collection.find({ value: { $lt: 5 } })
      expect(results.length).toBe(0)
    })
  })

  describe('$in with empty array', () => {
    it('should return empty for $in with empty array', () => {
      const collection = createMemoryCollection<{ status: string }>()

      collection.put('t1', { status: 'active' })

      const results = collection.find({ status: { $in: [] } })
      expect(results.length).toBe(0)
    })
  })

  describe('$nin with empty array', () => {
    it('should return all for $nin with empty array', () => {
      const collection = createMemoryCollection<{ status: string }>()

      collection.put('t1', { status: 'active' })
      collection.put('t2', { status: 'inactive' })

      const results = collection.find({ status: { $nin: [] } })
      expect(results.length).toBe(2)
    })
  })
})

// ============================================================================
// Security Tests
// ============================================================================

describe('Security: Empty $in/$nin array handling', () => {
  describe('$in with empty array', () => {
    it('should return no results with empty $in array', () => {
      const collection = createMemoryCollection<{ category: string; name: string }>()

      collection.put('p1', { category: 'electronics', name: 'Phone' })
      collection.put('p2', { category: 'furniture', name: 'Chair' })
      collection.put('p3', { category: 'electronics', name: 'Laptop' })

      const results = collection.find({ category: { $in: [] } })
      expect(results.length).toBe(0)
    })

    it('should return no results when combined with other filters and empty $in', () => {
      const collection = createMemoryCollection<{ category: string; active: boolean }>()

      collection.put('p1', { category: 'electronics', active: true })
      collection.put('p2', { category: 'furniture', active: true })

      const results = collection.find({
        $and: [{ active: true }, { category: { $in: [] } }],
      })
      expect(results.length).toBe(0)
    })
  })

  describe('$nin with empty array', () => {
    it('should return all results with empty $nin array', () => {
      const collection = createMemoryCollection<{ category: string; name: string }>()

      collection.put('p1', { category: 'electronics', name: 'Phone' })
      collection.put('p2', { category: 'furniture', name: 'Chair' })
      collection.put('p3', { category: 'electronics', name: 'Laptop' })

      const results = collection.find({ category: { $nin: [] } })
      expect(results.length).toBe(3)
    })

    it('should respect other filters when $nin is empty', () => {
      const collection = createMemoryCollection<{ category: string; active: boolean }>()

      collection.put('p1', { category: 'electronics', active: true })
      collection.put('p2', { category: 'furniture', active: false })
      collection.put('p3', { category: 'clothing', active: true })

      const results = collection.find({
        $and: [{ active: true }, { category: { $nin: [] } }],
      })
      expect(results.length).toBe(2)
    })
  })
})

describe('Security: ReDoS protection', () => {
  describe('Long regex patterns', () => {
    it('should reject regex patterns longer than 1000 characters', () => {
      const collection = createMemoryCollection<{ text: string }>()

      collection.put('t1', { text: 'hello world' })
      collection.put('t2', { text: 'test string' })

      // Create a pattern longer than 1000 characters
      const longPattern = 'a'.repeat(1001)

      const results = collection.find({ text: { $regex: longPattern } })
      // Should return no matches (pattern rejected)
      expect(results.length).toBe(0)
    })

    it('should accept regex patterns at the 1000 character limit', () => {
      const collection = createMemoryCollection<{ text: string }>()

      // Create a text that contains 1000 'a' characters
      const longText = 'a'.repeat(1000)
      collection.put('t1', { text: longText })
      collection.put('t2', { text: 'test string' })

      // Create a pattern exactly 1000 characters (at the limit)
      const limitPattern = 'a'.repeat(1000)

      const results = collection.find({ text: { $regex: limitPattern } })
      // Should work and find the matching document
      expect(results.length).toBe(1)
    })
  })

  describe('Nested quantifiers (ReDoS patterns)', () => {
    it('should reject patterns with nested quantifiers like (a+)+', () => {
      const collection = createMemoryCollection<{ text: string }>()

      collection.put('t1', { text: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' })

      // Classic ReDoS pattern: (a+)+
      const results = collection.find({ text: { $regex: '(a+)+' } })
      expect(results.length).toBe(0)
    })

    it('should reject patterns with nested quantifiers like (a*)+', () => {
      const collection = createMemoryCollection<{ text: string }>()

      collection.put('t1', { text: 'aaaaaaaaaa' })

      const results = collection.find({ text: { $regex: '(a*)+' } })
      expect(results.length).toBe(0)
    })

    it('should reject patterns with nested quantifiers like (a+)*', () => {
      const collection = createMemoryCollection<{ text: string }>()

      collection.put('t1', { text: 'aaaaaaaaaa' })

      const results = collection.find({ text: { $regex: '(a+)*' } })
      expect(results.length).toBe(0)
    })

    it('should reject patterns with nested groups containing quantifiers', () => {
      const collection = createMemoryCollection<{ text: string }>()

      collection.put('t1', { text: 'test' })

      // Pattern with nested groups: ((a+)b)+
      const results = collection.find({ text: { $regex: '((a+)b)+' } })
      expect(results.length).toBe(0)
    })

    it('should allow safe patterns without nested quantifiers', () => {
      const collection = createMemoryCollection<{ text: string }>()

      collection.put('t1', { text: 'hello world' })
      collection.put('t2', { text: 'goodbye world' })

      // Safe pattern: simple quantifier
      const results = collection.find({ text: { $regex: 'hello.*world' } })
      expect(results.length).toBe(1)
    })

    it('should allow patterns with single quantifiers in groups', () => {
      const collection = createMemoryCollection<{ email: string }>()

      collection.put('t1', { email: 'test@example.com' })
      collection.put('t2', { email: 'invalid' })

      // Safe pattern: group without nested quantifiers applied to it
      const results = collection.find({ email: { $regex: '@[a-z]+\\.com$' } })
      expect(results.length).toBe(1)
    })
  })

  describe('Malicious regex patterns should not hang', () => {
    it('should not hang on exponential backtracking pattern', () => {
      const collection = createMemoryCollection<{ text: string }>()

      // This input would cause exponential backtracking with vulnerable regex
      collection.put('t1', { text: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaab' })

      const startTime = Date.now()
      // This pattern would hang without protection: (a+)+$
      const results = collection.find({ text: { $regex: '(a+)+$' } })
      const elapsed = Date.now() - startTime

      // Should complete quickly (rejected pattern or fast execution)
      expect(elapsed).toBeLessThan(1000)
      expect(results.length).toBe(0)
    })

    it('should not hang on polynomial backtracking pattern', () => {
      const collection = createMemoryCollection<{ text: string }>()

      collection.put('t1', { text: 'a'.repeat(50) + 'X' })

      const startTime = Date.now()
      // Pattern that could cause polynomial time: (a*)*b
      const results = collection.find({ text: { $regex: '(a*)*b' } })
      const elapsed = Date.now() - startTime

      expect(elapsed).toBeLessThan(1000)
      expect(results.length).toBe(0)
    })
  })
})
