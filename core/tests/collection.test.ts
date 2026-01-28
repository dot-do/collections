/**
 * Collection Tests
 *
 * Tests for the MongoDB-style document store, ported from rpc.do
 * Uses MemoryCollection for testing without SQLite dependency
 */

import { describe, it, expect, beforeEach } from 'vitest'
import {
  MemoryCollection,
  createMemoryCollection,
  type Collection,
  type Filter,
  validateFieldName,
  escapeSql,
  isEqOperator,
  isNeOperator,
  isGtOperator,
  isGteOperator,
  isLtOperator,
  isLteOperator,
  isInOperator,
  isNinOperator,
  isExistsOperator,
  isRegexOperator,
  isFilterOperator,
} from '../src'

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
// Type Guards Tests
// ============================================================================

describe('Type Guards', () => {
  describe('isEqOperator', () => {
    it('should return true for $eq operator', () => {
      expect(isEqOperator({ $eq: 'value' })).toBe(true)
      expect(isEqOperator({ $eq: 123 })).toBe(true)
      expect(isEqOperator({ $eq: null })).toBe(true)
    })

    it('should return false for non-$eq values', () => {
      expect(isEqOperator({ $ne: 'value' })).toBe(false)
      expect(isEqOperator('value')).toBe(false)
      expect(isEqOperator(null)).toBe(false)
    })
  })

  describe('isNeOperator', () => {
    it('should return true for $ne operator', () => {
      expect(isNeOperator({ $ne: 'value' })).toBe(true)
    })

    it('should return false for non-$ne values', () => {
      expect(isNeOperator({ $eq: 'value' })).toBe(false)
    })
  })

  describe('isGtOperator', () => {
    it('should return true for $gt operator', () => {
      expect(isGtOperator({ $gt: 10 })).toBe(true)
    })

    it('should return false for non-$gt values', () => {
      expect(isGtOperator({ $gte: 10 })).toBe(false)
    })
  })

  describe('isGteOperator', () => {
    it('should return true for $gte operator', () => {
      expect(isGteOperator({ $gte: 10 })).toBe(true)
    })

    it('should return false for non-$gte values', () => {
      expect(isGteOperator({ $gt: 10 })).toBe(false)
    })
  })

  describe('isLtOperator', () => {
    it('should return true for $lt operator', () => {
      expect(isLtOperator({ $lt: 10 })).toBe(true)
    })

    it('should return false for non-$lt values', () => {
      expect(isLtOperator({ $lte: 10 })).toBe(false)
    })
  })

  describe('isLteOperator', () => {
    it('should return true for $lte operator', () => {
      expect(isLteOperator({ $lte: 10 })).toBe(true)
    })

    it('should return false for non-$lte values', () => {
      expect(isLteOperator({ $lt: 10 })).toBe(false)
    })
  })

  describe('isInOperator', () => {
    it('should return true for $in operator with array', () => {
      expect(isInOperator({ $in: [1, 2, 3] })).toBe(true)
      expect(isInOperator({ $in: [] })).toBe(true)
    })

    it('should return false for non-$in values', () => {
      expect(isInOperator({ $in: 'not-array' })).toBe(false)
      expect(isInOperator({ $nin: [1, 2] })).toBe(false)
    })
  })

  describe('isNinOperator', () => {
    it('should return true for $nin operator with array', () => {
      expect(isNinOperator({ $nin: [1, 2, 3] })).toBe(true)
    })

    it('should return false for non-$nin values', () => {
      expect(isNinOperator({ $in: [1, 2] })).toBe(false)
    })
  })

  describe('isExistsOperator', () => {
    it('should return true for $exists operator', () => {
      expect(isExistsOperator({ $exists: true })).toBe(true)
      expect(isExistsOperator({ $exists: false })).toBe(true)
    })

    it('should return false for non-$exists values', () => {
      expect(isExistsOperator({ $eq: true })).toBe(false)
    })
  })

  describe('isRegexOperator', () => {
    it('should return true for $regex operator', () => {
      expect(isRegexOperator({ $regex: '^test' })).toBe(true)
    })

    it('should return false for non-$regex values', () => {
      expect(isRegexOperator({ $eq: '^test' })).toBe(false)
    })
  })

  describe('isFilterOperator', () => {
    it('should return true for any filter operator', () => {
      expect(isFilterOperator({ $eq: 'value' })).toBe(true)
      expect(isFilterOperator({ $ne: 'value' })).toBe(true)
      expect(isFilterOperator({ $gt: 10 })).toBe(true)
      expect(isFilterOperator({ $gte: 10 })).toBe(true)
      expect(isFilterOperator({ $lt: 10 })).toBe(true)
      expect(isFilterOperator({ $lte: 10 })).toBe(true)
      expect(isFilterOperator({ $in: [1, 2] })).toBe(true)
      expect(isFilterOperator({ $nin: [1, 2] })).toBe(true)
      expect(isFilterOperator({ $exists: true })).toBe(true)
      expect(isFilterOperator({ $regex: '^test' })).toBe(true)
    })

    it('should return false for non-operator values', () => {
      expect(isFilterOperator('value')).toBe(false)
      expect(isFilterOperator(123)).toBe(false)
      expect(isFilterOperator({ name: 'value' })).toBe(false)
      expect(isFilterOperator(null)).toBe(false)
    })
  })
})

// ============================================================================
// Field Validation Tests
// ============================================================================

describe('Field Validation', () => {
  describe('validateFieldName', () => {
    it('should accept valid field names', () => {
      expect(validateFieldName('name')).toBe('name')
      expect(validateFieldName('user_id')).toBe('user_id')
      expect(validateFieldName('metadata.level')).toBe('metadata.level')
      expect(validateFieldName('a123')).toBe('a123')
    })

    it('should reject invalid field names', () => {
      expect(() => validateFieldName("'; DROP TABLE users; --")).toThrow()
      expect(() => validateFieldName('name OR 1=1')).toThrow()
      expect(() => validateFieldName('field-with-dash')).toThrow()
      expect(() => validateFieldName('field with space')).toThrow()
      expect(() => validateFieldName('')).toThrow()
    })
  })

  describe('escapeSql', () => {
    it('should escape single quotes', () => {
      expect(escapeSql("O'Brien")).toBe("O''Brien")
      expect(escapeSql("It's a test")).toBe("It''s a test")
    })

    it('should handle strings without quotes', () => {
      expect(escapeSql('normal string')).toBe('normal string')
    })
  })
})

// ============================================================================
// Basic CRUD Operations Tests
// ============================================================================

describe('Collection CRUD Operations', () => {
  let users: Collection<User>

  beforeEach(() => {
    users = createMemoryCollection<User>()
  })

  describe('put() - insert new document', () => {
    it('should insert a new document with the given ID', () => {
      users.put('user1', { name: 'Alice', email: 'alice@example.com', age: 30, active: true })

      const retrieved = users.get('user1')
      expect(retrieved).toEqual({ name: 'Alice', email: 'alice@example.com', age: 30, active: true })
    })

    it('should insert multiple documents with different IDs', () => {
      users.put('user1', { name: 'Alice', email: 'alice@example.com', age: 30, active: true })
      users.put('user2', { name: 'Bob', email: 'bob@example.com', age: 25, active: false })

      expect(users.get('user1')?.name).toBe('Alice')
      expect(users.get('user2')?.name).toBe('Bob')
    })

    it('should store complex nested objects', () => {
      users.put('user1', {
        name: 'Alice',
        email: 'alice@example.com',
        age: 30,
        active: true,
        metadata: { preferences: { theme: 'dark', notifications: true }, tags: ['admin', 'verified'] },
      })

      const retrieved = users.get('user1')
      expect(retrieved?.metadata).toEqual({
        preferences: { theme: 'dark', notifications: true },
        tags: ['admin', 'verified'],
      })
    })
  })

  describe('put() - update existing document', () => {
    it('should update an existing document', () => {
      users.put('user1', { name: 'Alice', email: 'alice@example.com', age: 30, active: true })
      users.put('user1', { name: 'Alice Updated', email: 'alice.new@example.com', age: 31, active: false })

      const retrieved = users.get('user1')
      expect(retrieved).toEqual({ name: 'Alice Updated', email: 'alice.new@example.com', age: 31, active: false })
    })

    it('should only update the specified document', () => {
      users.put('user1', { name: 'Alice', email: 'alice@example.com', age: 30, active: true })
      users.put('user2', { name: 'Bob', email: 'bob@example.com', age: 25, active: true })
      users.put('user1', { name: 'Alice Updated', email: 'alice@example.com', age: 30, active: true })

      expect(users.get('user1')?.name).toBe('Alice Updated')
      expect(users.get('user2')?.name).toBe('Bob')
    })

    it('should completely replace the document on update', () => {
      users.put('user1', { name: 'Alice', email: 'alice@example.com', age: 30, active: true, role: 'admin' })
      users.put('user1', { name: 'Alice', email: 'alice@example.com', age: 30, active: true })

      const retrieved = users.get('user1')
      expect(retrieved?.role).toBeUndefined()
    })
  })

  describe('get() - retrieve existing document', () => {
    it('should retrieve an existing document by ID', () => {
      users.put('user1', { name: 'Alice', email: 'alice@example.com', age: 30, active: true })

      const retrieved = users.get('user1')
      expect(retrieved).not.toBeNull()
      expect(retrieved?.name).toBe('Alice')
    })

    it('should return the complete document structure', () => {
      const originalDoc = { name: 'Alice', email: 'alice@example.com', age: 30, active: true }

      users.put('user1', originalDoc)

      const retrieved = users.get('user1')
      expect(retrieved).toEqual(originalDoc)
    })
  })

  describe('get() - return null for non-existent document', () => {
    it('should return null for non-existent document', () => {
      const retrieved = users.get('nonexistent')
      expect(retrieved).toBeNull()
    })

    it('should return null for deleted document', () => {
      users.put('user1', { name: 'Alice', email: 'alice@example.com', age: 30, active: true })
      users.delete('user1')

      expect(users.get('user1')).toBeNull()
    })
  })

  describe('delete() - delete existing document', () => {
    it('should return true when deleting existing document', () => {
      users.put('user1', { name: 'Alice', email: 'alice@example.com', age: 30, active: true })

      const result = users.delete('user1')
      expect(result).toBe(true)
    })

    it('should actually remove the document', () => {
      users.put('user1', { name: 'Alice', email: 'alice@example.com', age: 30, active: true })
      users.delete('user1')

      expect(users.get('user1')).toBeNull()
      expect(users.has('user1')).toBe(false)
    })

    it('should not affect other documents', () => {
      users.put('user1', { name: 'Alice', email: 'alice@example.com', age: 30, active: true })
      users.put('user2', { name: 'Bob', email: 'bob@example.com', age: 25, active: true })
      users.delete('user1')

      expect(users.get('user2')).not.toBeNull()
    })
  })

  describe('delete() - delete non-existent document', () => {
    it('should return false when deleting non-existent document', () => {
      const result = users.delete('nonexistent')
      expect(result).toBe(false)
    })

    it('should return false when deleting already deleted document', () => {
      users.put('user1', { name: 'Alice', email: 'alice@example.com', age: 30, active: true })
      users.delete('user1')

      const result = users.delete('user1')
      expect(result).toBe(false)
    })
  })

  describe('has() - check existence', () => {
    it('should return true for existing document', () => {
      users.put('user1', { name: 'Alice', email: 'alice@example.com', age: 30, active: true })

      expect(users.has('user1')).toBe(true)
    })

    it('should return false for non-existent document', () => {
      expect(users.has('nonexistent')).toBe(false)
    })

    it('should return false after document is deleted', () => {
      users.put('user1', { name: 'Alice', email: 'alice@example.com', age: 30, active: true })
      users.delete('user1')

      expect(users.has('user1')).toBe(false)
    })
  })
})

// ============================================================================
// Bulk Operations Tests
// ============================================================================

describe('Bulk Operations', () => {
  let users: Collection<User>

  beforeEach(() => {
    users = createMemoryCollection<User>()
  })

  describe('putMany()', () => {
    it('should return 0 for empty array', () => {
      const count = users.putMany([])
      expect(count).toBe(0)
      expect(users.count()).toBe(0)
    })

    it('should insert multiple documents', () => {
      const count = users.putMany([
        { id: 'u1', doc: { name: 'Alice', email: 'alice@test.com', age: 30, active: true } },
        { id: 'u2', doc: { name: 'Bob', email: 'bob@test.com', age: 25, active: true } },
        { id: 'u3', doc: { name: 'Charlie', email: 'charlie@test.com', age: 35, active: false } },
      ])

      expect(count).toBe(3)
      expect(users.count()).toBe(3)
      expect(users.get('u1')?.name).toBe('Alice')
      expect(users.get('u2')?.name).toBe('Bob')
      expect(users.get('u3')?.name).toBe('Charlie')
    })

    it('should update existing documents', () => {
      // Insert initial documents
      users.put('u1', { name: 'Alice', email: 'alice@test.com', age: 30, active: true })
      users.put('u2', { name: 'Bob', email: 'bob@test.com', age: 25, active: true })

      // Update with putMany
      const count = users.putMany([
        { id: 'u1', doc: { name: 'Alice Updated', email: 'alice.new@test.com', age: 31, active: false } },
        { id: 'u3', doc: { name: 'Charlie', email: 'charlie@test.com', age: 35, active: true } },
      ])

      expect(count).toBe(2)
      expect(users.count()).toBe(3)
      expect(users.get('u1')?.name).toBe('Alice Updated')
      expect(users.get('u1')?.age).toBe(31)
      expect(users.get('u2')?.name).toBe('Bob') // Unchanged
      expect(users.get('u3')?.name).toBe('Charlie') // New
    })

    it('should handle single document', () => {
      const count = users.putMany([
        { id: 'u1', doc: { name: 'Alice', email: 'alice@test.com', age: 30, active: true } },
      ])

      expect(count).toBe(1)
      expect(users.count()).toBe(1)
      expect(users.get('u1')?.name).toBe('Alice')
    })

    it('should handle large batch', () => {
      const docs = Array.from({ length: 100 }, (_, i) => ({
        id: `user${i}`,
        doc: { name: `User ${i}`, email: `user${i}@test.com`, age: 20 + (i % 50), active: i % 2 === 0 },
      }))

      const count = users.putMany(docs)

      expect(count).toBe(100)
      expect(users.count()).toBe(100)
      expect(users.get('user50')?.name).toBe('User 50')
    })
  })

  describe('deleteMany()', () => {
    beforeEach(() => {
      users.put('u1', { name: 'Alice', email: 'alice@test.com', age: 30, active: true })
      users.put('u2', { name: 'Bob', email: 'bob@test.com', age: 25, active: true })
      users.put('u3', { name: 'Charlie', email: 'charlie@test.com', age: 35, active: false })
      users.put('u4', { name: 'Diana', email: 'diana@test.com', age: 28, active: true })
      users.put('u5', { name: 'Eve', email: 'eve@test.com', age: 22, active: false })
    })

    it('should return 0 for empty array', () => {
      const count = users.deleteMany([])
      expect(count).toBe(0)
      expect(users.count()).toBe(5)
    })

    it('should delete multiple documents', () => {
      const count = users.deleteMany(['u1', 'u3', 'u5'])

      expect(count).toBe(3)
      expect(users.count()).toBe(2)
      expect(users.get('u1')).toBeNull()
      expect(users.get('u2')?.name).toBe('Bob')
      expect(users.get('u3')).toBeNull()
      expect(users.get('u4')?.name).toBe('Diana')
      expect(users.get('u5')).toBeNull()
    })

    it('should return 0 for non-existent IDs', () => {
      const count = users.deleteMany(['nonexistent1', 'nonexistent2', 'nonexistent3'])

      expect(count).toBe(0)
      expect(users.count()).toBe(5)
    })

    it('should return correct count with mixed existing and non-existent IDs', () => {
      const count = users.deleteMany(['u1', 'nonexistent', 'u3'])

      expect(count).toBe(2)
      expect(users.count()).toBe(3)
      expect(users.get('u1')).toBeNull()
      expect(users.get('u3')).toBeNull()
    })

    it('should handle single ID', () => {
      const count = users.deleteMany(['u1'])

      expect(count).toBe(1)
      expect(users.count()).toBe(4)
      expect(users.get('u1')).toBeNull()
    })

    it('should handle deleting all documents', () => {
      const count = users.deleteMany(['u1', 'u2', 'u3', 'u4', 'u5'])

      expect(count).toBe(5)
      expect(users.count()).toBe(0)
    })

    it('should handle duplicate IDs gracefully', () => {
      const count = users.deleteMany(['u1', 'u1', 'u2', 'u2', 'u2'])

      // In memory implementation, duplicates after first delete won't count
      // The exact count depends on implementation, but documents should be deleted
      expect(users.get('u1')).toBeNull()
      expect(users.get('u2')).toBeNull()
      expect(users.count()).toBe(3)
    })
  })
})

// ============================================================================
// Filter Operations Tests
// ============================================================================

describe('Filter Operations', () => {
  let products: Collection<Product>

  beforeEach(() => {
    products = createMemoryCollection<Product>()

    // Seed test data
    products.put('p1', {
      name: 'Laptop',
      price: 999,
      category: 'electronics',
      inStock: true,
      tags: ['computer', 'portable'],
    })
    products.put('p2', { name: 'Phone', price: 599, category: 'electronics', inStock: true, tags: ['mobile'] })
    products.put('p3', { name: 'Chair', price: 149, category: 'furniture', inStock: false, tags: ['office'] })
    products.put('p4', { name: 'Desk', price: 299, category: 'furniture', inStock: true, tags: ['office', 'wood'] })
    products.put('p5', {
      name: 'Monitor',
      price: 399,
      category: 'electronics',
      inStock: false,
      tags: ['computer', 'display'],
    })
  })

  describe('$eq - equality operator', () => {
    it('should find documents with exact field match', () => {
      const results = products.find({ category: { $eq: 'electronics' } })
      expect(results.length).toBe(3)
      expect(results.every((p) => p.category === 'electronics')).toBe(true)
    })

    it('should find documents with boolean equality', () => {
      const results = products.find({ inStock: { $eq: true } })
      expect(results.length).toBe(3)
      expect(results.every((p) => p.inStock === true)).toBe(true)
    })

    it('should find documents with numeric equality', () => {
      const results = products.find({ price: { $eq: 599 } })
      expect(results.length).toBe(1)
      expect(results[0].name).toBe('Phone')
    })
  })

  describe('$ne - not equal operator', () => {
    it('should find documents where field is not equal', () => {
      const results = products.find({ category: { $ne: 'electronics' } })
      expect(results.length).toBe(2)
      expect(results.every((p) => p.category !== 'electronics')).toBe(true)
    })

    it('should work with boolean values', () => {
      const results = products.find({ inStock: { $ne: true } })
      expect(results.length).toBe(2)
      expect(results.every((p) => p.inStock !== true)).toBe(true)
    })
  })

  describe('$gt - greater than operator', () => {
    it('should find documents with field greater than value', () => {
      const results = products.find({ price: { $gt: 500 } })
      expect(results.length).toBe(2)
      expect(results.every((p) => p.price > 500)).toBe(true)
    })

    it('should not include equal values', () => {
      const results = products.find({ price: { $gt: 599 } })
      expect(results.length).toBe(1)
      expect(results[0].price).toBe(999)
    })
  })

  describe('$gte - greater than or equal operator', () => {
    it('should find documents with field greater than or equal to value', () => {
      const results = products.find({ price: { $gte: 399 } })
      expect(results.length).toBe(3)
      expect(results.every((p) => p.price >= 399)).toBe(true)
    })

    it('should include equal values', () => {
      const results = products.find({ price: { $gte: 599 } })
      expect(results.length).toBe(2)
      expect(results.some((p) => p.price === 599)).toBe(true)
    })
  })

  describe('$lt - less than operator', () => {
    it('should find documents with field less than value', () => {
      const results = products.find({ price: { $lt: 300 } })
      expect(results.length).toBe(2)
      expect(results.every((p) => p.price < 300)).toBe(true)
    })

    it('should not include equal values', () => {
      const results = products.find({ price: { $lt: 149 } })
      expect(results.length).toBe(0)
    })
  })

  describe('$lte - less than or equal operator', () => {
    it('should find documents with field less than or equal to value', () => {
      const results = products.find({ price: { $lte: 299 } })
      expect(results.length).toBe(2)
      expect(results.every((p) => p.price <= 299)).toBe(true)
    })

    it('should include equal values', () => {
      const results = products.find({ price: { $lte: 149 } })
      expect(results.length).toBe(1)
      expect(results[0].price).toBe(149)
    })
  })

  describe('$in - array membership operator', () => {
    it('should find documents where field is in array', () => {
      const results = products.find({ category: { $in: ['electronics', 'furniture'] } })
      expect(results.length).toBe(5)
    })

    it('should find documents with price in array', () => {
      const results = products.find({ price: { $in: [149, 599, 999] } })
      expect(results.length).toBe(3)
    })

    it('should return empty when no match in array', () => {
      const results = products.find({ category: { $in: ['clothing', 'food'] } })
      expect(results.length).toBe(0)
    })
  })

  describe('$nin - not in array operator', () => {
    it('should find documents where field is not in array', () => {
      const results = products.find({ category: { $nin: ['electronics'] } })
      expect(results.length).toBe(2)
      expect(results.every((p) => p.category !== 'electronics')).toBe(true)
    })

    it('should work with numeric values', () => {
      const results = products.find({ price: { $nin: [999, 599] } })
      expect(results.length).toBe(3)
      expect(results.every((p) => p.price !== 999 && p.price !== 599)).toBe(true)
    })
  })

  describe('$exists - field existence operator', () => {
    it('should find documents where field exists', () => {
      const users = createMemoryCollection<User>()
      users.put('u1', { name: 'Alice', email: 'a@test.com', age: 30, active: true, role: 'admin' })
      users.put('u2', { name: 'Bob', email: 'b@test.com', age: 25, active: true })

      const results = users.find({ role: { $exists: true } })
      expect(results.length).toBe(1)
      expect(results[0].name).toBe('Alice')
    })

    it('should find documents where field does not exist', () => {
      const users = createMemoryCollection<User>()
      users.put('u1', { name: 'Alice', email: 'a@test.com', age: 30, active: true, role: 'admin' })
      users.put('u2', { name: 'Bob', email: 'b@test.com', age: 25, active: true })

      const results = users.find({ role: { $exists: false } })
      expect(results.length).toBe(1)
      expect(results[0].name).toBe('Bob')
    })
  })

  describe('$regex - regex matching operator', () => {
    it('should find documents matching regex pattern', () => {
      const results = products.find({ name: { $regex: '^[A-M]' } })
      expect(results.length).toBe(4)
      expect(results.every((p) => /^[A-M]/.test(p.name))).toBe(true)
    })

    it('should find documents with partial match', () => {
      const results = products.find({ name: { $regex: 'o' } })
      expect(results.length).toBe(3) // Phone, Monitor, Laptop
    })
  })

  describe('$and - logical AND operator', () => {
    it('should find documents matching all conditions', () => {
      const results = products.find({
        $and: [{ category: 'electronics' }, { inStock: true }],
      })
      expect(results.length).toBe(2)
      expect(results.every((p) => p.category === 'electronics' && p.inStock === true)).toBe(true)
    })

    it('should work with multiple comparison operators', () => {
      const results = products.find({
        $and: [{ price: { $gte: 300 } }, { price: { $lte: 700 } }],
      })
      expect(results.length).toBe(2)
      expect(results.every((p) => p.price >= 300 && p.price <= 700)).toBe(true)
    })

    it('should return empty when no documents match all conditions', () => {
      const results = products.find({
        $and: [{ category: 'electronics' }, { price: { $lt: 100 } }],
      })
      expect(results.length).toBe(0)
    })
  })

  describe('$or - logical OR operator', () => {
    it('should find documents matching any condition', () => {
      const results = products.find({
        $or: [{ category: 'electronics' }, { inStock: false }],
      })
      expect(results.length).toBe(4)
    })

    it('should work with equality and comparison operators', () => {
      const results = products.find({
        $or: [{ price: { $lt: 200 } }, { price: { $gt: 900 } }],
      })
      expect(results.length).toBe(2)
    })
  })

  describe('Nested field queries', () => {
    it('should query nested object fields', () => {
      const users = createMemoryCollection<User>()
      users.put('u1', {
        name: 'Alice',
        email: 'a@test.com',
        age: 30,
        active: true,
        metadata: { level: 5, verified: true },
      })
      users.put('u2', {
        name: 'Bob',
        email: 'b@test.com',
        age: 25,
        active: true,
        metadata: { level: 3, verified: false },
      })

      const results = users.find({ 'metadata.level': 5 } as any)
      expect(results.length).toBe(1)
      expect(results[0].name).toBe('Alice')
    })
  })

  describe('Plain object value matching', () => {
    it('should match plain object values exactly', () => {
      const users = createMemoryCollection<User>()
      users.put('u1', {
        name: 'Alice',
        email: 'a@test.com',
        age: 30,
        active: true,
        metadata: { role: 'admin', level: 5 },
      })
      users.put('u2', {
        name: 'Bob',
        email: 'b@test.com',
        age: 25,
        active: true,
        metadata: { role: 'user', level: 1 },
      })

      const results = users.find({ metadata: { role: 'admin', level: 5 } } as any)
      expect(results.length).toBe(1)
      expect(results[0].name).toBe('Alice')
    })
  })

  describe('Implicit equality matching', () => {
    it('should treat plain values as equality filter', () => {
      const results = products.find({ category: 'electronics' })
      expect(results.length).toBe(3)
      expect(results.every((p) => p.category === 'electronics')).toBe(true)
    })

    it('should match boolean values', () => {
      const results = products.find({ inStock: true })
      expect(results.length).toBe(3)
    })

    it('should match numeric values', () => {
      const results = products.find({ price: 599 })
      expect(results.length).toBe(1)
      expect(results[0].name).toBe('Phone')
    })
  })
})

// ============================================================================
// Query Options Tests
// ============================================================================

describe('Query Options', () => {
  let products: Collection<Product>

  beforeEach(() => {
    products = createMemoryCollection<Product>()

    // Seed in specific order for testing
    products.put('p1', { name: 'Alpha', price: 100, category: 'a', inStock: true })
    products.put('p2', { name: 'Beta', price: 200, category: 'b', inStock: true })
    products.put('p3', { name: 'Gamma', price: 300, category: 'c', inStock: true })
    products.put('p4', { name: 'Delta', price: 400, category: 'd', inStock: true })
    products.put('p5', { name: 'Epsilon', price: 500, category: 'e', inStock: true })
  })

  describe('limit option', () => {
    it('should limit the number of results', () => {
      const results = products.list({ limit: 2 })
      expect(results.length).toBe(2)
    })

    it('should return all if limit is greater than count', () => {
      const results = products.list({ limit: 100 })
      expect(results.length).toBe(5)
    })

    it('should return 1 result with limit 1', () => {
      const results = products.list({ limit: 1 })
      expect(results.length).toBe(1)
    })

    it('should work with find and filter', () => {
      const results = products.find({ inStock: true }, { limit: 3 })
      expect(results.length).toBe(3)
    })
  })

  describe('offset option', () => {
    it('should skip the specified number of results', () => {
      const results = products.find({}, { sort: 'name', offset: 2, limit: 100 })
      expect(results.length).toBe(3)
      expect(results[0].name).toBe('Delta')
    })

    it('should return empty array if offset is greater than count', () => {
      const results = products.list({ offset: 100, limit: 100 })
      expect(results.length).toBe(0)
    })

    it('should work with limit for pagination', () => {
      const page1 = products.find({}, { sort: 'name', limit: 2, offset: 0 })
      const page2 = products.find({}, { sort: 'name', limit: 2, offset: 2 })
      const page3 = products.find({}, { sort: 'name', limit: 2, offset: 4 })

      expect(page1.map((p) => p.name)).toEqual(['Alpha', 'Beta'])
      expect(page2.map((p) => p.name)).toEqual(['Delta', 'Epsilon'])
      expect(page3.map((p) => p.name)).toEqual(['Gamma'])
    })
  })

  describe('sort option - ascending', () => {
    it('should sort results by field ascending', () => {
      const results = products.find({}, { sort: 'name' })
      expect(results.map((p) => p.name)).toEqual(['Alpha', 'Beta', 'Delta', 'Epsilon', 'Gamma'])
    })

    it('should sort numeric fields ascending', () => {
      const results = products.find({}, { sort: 'price' })
      expect(results.map((p) => p.price)).toEqual([100, 200, 300, 400, 500])
    })
  })

  describe('sort option - descending with - prefix', () => {
    it('should sort results by field descending', () => {
      const results = products.find({}, { sort: '-name' })
      expect(results.map((p) => p.name)).toEqual(['Gamma', 'Epsilon', 'Delta', 'Beta', 'Alpha'])
    })

    it('should sort numeric fields descending', () => {
      const results = products.find({}, { sort: '-price' })
      expect(results.map((p) => p.price)).toEqual([500, 400, 300, 200, 100])
    })
  })

  describe('combined options', () => {
    it('should apply sort, limit, and offset together', () => {
      const results = products.find({}, { sort: 'price', limit: 2, offset: 1 })
      expect(results.length).toBe(2)
      expect(results.map((p) => p.price)).toEqual([200, 300])
    })

    it('should apply filter with sort and limit', () => {
      products.put('p6', { name: 'Zeta', price: 50, category: 'a', inStock: true })

      const results = products.find({ category: 'a' }, { sort: '-price', limit: 1 })
      expect(results.length).toBe(1)
      expect(results[0].name).toBe('Alpha')
    })
  })
})

// ============================================================================
// Collection Management Tests
// ============================================================================

describe('Collection Management', () => {
  describe('list() - list all documents', () => {
    it('should return all documents in collection', () => {
      const users = createMemoryCollection<User>()

      users.put('u1', { name: 'Alice', email: 'a@test.com', age: 30, active: true })
      users.put('u2', { name: 'Bob', email: 'b@test.com', age: 25, active: true })
      users.put('u3', { name: 'Charlie', email: 'c@test.com', age: 35, active: false })

      const results = users.list()
      expect(results.length).toBe(3)
    })

    it('should return empty array for empty collection', () => {
      const users = createMemoryCollection<User>()

      const results = users.list()
      expect(results).toEqual([])
    })

    it('should support query options', () => {
      const users = createMemoryCollection<User>()

      users.put('u1', { name: 'Alice', email: 'a@test.com', age: 30, active: true })
      users.put('u2', { name: 'Bob', email: 'b@test.com', age: 25, active: true })
      users.put('u3', { name: 'Charlie', email: 'c@test.com', age: 35, active: false })

      const results = users.list({ sort: 'name', limit: 2 })
      expect(results.length).toBe(2)
      expect(results.map((u) => u.name)).toEqual(['Alice', 'Bob'])
    })
  })

  describe('keys() - get all IDs', () => {
    it('should return all document IDs', () => {
      const users = createMemoryCollection<User>()

      users.put('u1', { name: 'Alice', email: 'a@test.com', age: 30, active: true })
      users.put('u2', { name: 'Bob', email: 'b@test.com', age: 25, active: true })
      users.put('u3', { name: 'Charlie', email: 'c@test.com', age: 35, active: false })

      const keys = users.keys()
      expect(keys.sort()).toEqual(['u1', 'u2', 'u3'])
    })

    it('should return empty array for empty collection', () => {
      const users = createMemoryCollection<User>()

      const keys = users.keys()
      expect(keys).toEqual([])
    })

    it('should return sorted keys', () => {
      const users = createMemoryCollection<User>()

      users.put('c', { name: 'C', email: 'c@test.com', age: 30, active: true })
      users.put('a', { name: 'A', email: 'a@test.com', age: 25, active: true })
      users.put('b', { name: 'B', email: 'b@test.com', age: 35, active: false })

      const keys = users.keys()
      expect(keys).toEqual(['a', 'b', 'c'])
    })
  })

  describe('count() - count documents', () => {
    it('should return total count without filter', () => {
      const users = createMemoryCollection<User>()

      users.put('u1', { name: 'Alice', email: 'a@test.com', age: 30, active: true })
      users.put('u2', { name: 'Bob', email: 'b@test.com', age: 25, active: true })
      users.put('u3', { name: 'Charlie', email: 'c@test.com', age: 35, active: false })

      expect(users.count()).toBe(3)
    })

    it('should return 0 for empty collection', () => {
      const users = createMemoryCollection<User>()

      expect(users.count()).toBe(0)
    })

    it('should return count with filter', () => {
      const users = createMemoryCollection<User>()

      users.put('u1', { name: 'Alice', email: 'a@test.com', age: 30, active: true })
      users.put('u2', { name: 'Bob', email: 'b@test.com', age: 25, active: true })
      users.put('u3', { name: 'Charlie', email: 'c@test.com', age: 35, active: false })

      expect(users.find({ active: true }).length).toBe(2)
      expect(users.find({ active: false }).length).toBe(1)
      expect(users.find({ age: { $gt: 28 } }).length).toBe(2)
    })
  })

  describe('clear() - delete all documents', () => {
    it('should delete all documents and return count', () => {
      const users = createMemoryCollection<User>()

      users.put('u1', { name: 'Alice', email: 'a@test.com', age: 30, active: true })
      users.put('u2', { name: 'Bob', email: 'b@test.com', age: 25, active: true })
      users.put('u3', { name: 'Charlie', email: 'c@test.com', age: 35, active: false })

      const deleted = users.clear()
      expect(deleted).toBe(3)
      expect(users.count()).toBe(0)
    })

    it('should return 0 for empty collection', () => {
      const users = createMemoryCollection<User>()

      const deleted = users.clear()
      expect(deleted).toBe(0)
    })
  })
})

// ============================================================================
// Edge Cases Tests
// ============================================================================

describe('Edge Cases', () => {
  describe('Empty collection operations', () => {
    it('should handle find on empty collection', () => {
      const users = createMemoryCollection<User>()

      const results = users.find({ active: true })
      expect(results).toEqual([])
    })

    it('should handle count on empty collection', () => {
      const users = createMemoryCollection<User>()

      expect(users.count()).toBe(0)
      expect(users.find({ active: true }).length).toBe(0)
    })

    it('should handle list on empty collection', () => {
      const users = createMemoryCollection<User>()

      expect(users.list()).toEqual([])
    })

    it('should handle keys on empty collection', () => {
      const users = createMemoryCollection<User>()

      expect(users.keys()).toEqual([])
    })

    it('should handle clear on empty collection', () => {
      const users = createMemoryCollection<User>()

      expect(users.clear()).toBe(0)
    })
  })

  describe('Large documents', () => {
    it('should handle documents with many fields', () => {
      const users = createMemoryCollection<Record<string, unknown>>()

      const largeDoc: Record<string, unknown> = {}
      for (let i = 0; i < 100; i++) {
        largeDoc[`field${i}`] = `value${i}`
      }

      users.put('large', largeDoc)

      const retrieved = users.get('large')
      expect(retrieved).not.toBeNull()
      expect(Object.keys(retrieved!).length).toBe(100)
      expect(retrieved!['field50']).toBe('value50')
    })

    it('should handle documents with large string values', () => {
      const users = createMemoryCollection<Record<string, unknown>>()

      const largeString = 'x'.repeat(100000)
      users.put('large', { content: largeString })

      const retrieved = users.get('large')
      expect(retrieved).not.toBeNull()
      expect((retrieved!['content'] as string).length).toBe(100000)
    })

    it('should handle deeply nested documents', () => {
      const users = createMemoryCollection<Record<string, unknown>>()

      const deepDoc = {
        level1: {
          level2: {
            level3: {
              level4: {
                level5: {
                  value: 'deep',
                },
              },
            },
          },
        },
      }

      users.put('deep', deepDoc)

      const retrieved = users.get('deep')
      expect(retrieved).not.toBeNull()
      expect((retrieved as any).level1.level2.level3.level4.level5.value).toBe('deep')
    })
  })

  describe('Special characters in IDs', () => {
    it('should handle IDs with spaces', () => {
      const users = createMemoryCollection<User>()

      users.put('user with spaces', { name: 'Alice', email: 'a@test.com', age: 30, active: true })

      expect(users.has('user with spaces')).toBe(true)
      expect(users.get('user with spaces')?.name).toBe('Alice')
    })

    it('should handle IDs with special characters', () => {
      const users = createMemoryCollection<User>()

      const specialIds = [
        'user-with-dashes',
        'user_with_underscores',
        'user.with.dots',
        'user@with@at',
        'user#with#hash',
        'user$with$dollar',
        'user%with%percent',
      ]

      for (const id of specialIds) {
        users.put(id, { name: id, email: `${id}@test.com`, age: 30, active: true })
      }

      for (const id of specialIds) {
        expect(users.has(id)).toBe(true)
        expect(users.get(id)?.name).toBe(id)
      }
    })

    it('should handle empty string ID', () => {
      const users = createMemoryCollection<User>()

      users.put('', { name: 'Empty ID', email: 'empty@test.com', age: 30, active: true })

      expect(users.has('')).toBe(true)
      expect(users.get('')?.name).toBe('Empty ID')
    })
  })

  describe('NULL values in documents', () => {
    it('should store and retrieve null field values', () => {
      const users = createMemoryCollection<Record<string, unknown>>()

      users.put('u1', { name: 'Alice', middleName: null, age: 30 })

      const retrieved = users.get('u1')
      expect(retrieved).not.toBeNull()
      expect(retrieved!['middleName']).toBeNull()
    })

    it('should distinguish between null and undefined/missing fields', () => {
      const users = createMemoryCollection<Record<string, unknown>>()

      users.put('u1', { name: 'Alice', middleName: null })
      users.put('u2', { name: 'Bob' })

      const u1 = users.get('u1')
      const u2 = users.get('u2')

      expect(u1!['middleName']).toBeNull()
      expect(u2!['middleName']).toBeUndefined()
    })
  })

  describe('Empty filter handling', () => {
    it('should return all documents with empty filter object', () => {
      const users = createMemoryCollection<User>()

      users.put('u1', { name: 'Alice', email: 'a@test.com', age: 30, active: true })
      users.put('u2', { name: 'Bob', email: 'b@test.com', age: 25, active: false })

      const results = users.find({})
      expect(results.length).toBe(2)
    })

    it('should return all documents with undefined filter', () => {
      const users = createMemoryCollection<User>()

      users.put('u1', { name: 'Alice', email: 'a@test.com', age: 30, active: true })
      users.put('u2', { name: 'Bob', email: 'b@test.com', age: 25, active: false })

      const results = users.find(undefined)
      expect(results.length).toBe(2)
    })
  })

  describe('Array field handling', () => {
    it('should store and retrieve array fields', () => {
      const products = createMemoryCollection<Product>()

      products.put('p1', {
        name: 'Laptop',
        price: 999,
        category: 'electronics',
        inStock: true,
        tags: ['computer', 'portable', 'work'],
      })

      const retrieved = products.get('p1')
      expect(retrieved?.tags).toEqual(['computer', 'portable', 'work'])
    })

    it('should handle empty arrays', () => {
      const products = createMemoryCollection<Product>()

      products.put('p1', { name: 'Laptop', price: 999, category: 'electronics', inStock: true, tags: [] })

      const retrieved = products.get('p1')
      expect(retrieved?.tags).toEqual([])
    })
  })

  describe('Concurrent operations', () => {
    it('should handle rapid put/get operations', () => {
      const users = createMemoryCollection<Record<string, unknown>>()

      // Rapid puts
      for (let i = 0; i < 100; i++) {
        users.put(`user${i}`, { index: i, name: `User ${i}` })
      }

      // Verify all were stored
      expect(users.count()).toBe(100)

      // Rapid gets
      for (let i = 0; i < 100; i++) {
        const doc = users.get(`user${i}`)
        expect(doc).not.toBeNull()
        expect(doc!['index']).toBe(i)
      }
    })
  })
})

// ============================================================================
// Error Cases Tests
// ============================================================================

describe('Error Cases', () => {
  describe('Invalid filter operators', () => {
    it('should handle unknown operator gracefully (treated as object match)', () => {
      const users = createMemoryCollection<User>()

      users.put('u1', { name: 'Alice', email: 'a@test.com', age: 30, active: true })

      // Unknown operator should be treated as plain object match
      const results = users.find({ age: { $unknown: 30 } as any })
      // This will try to match the object { $unknown: 30 } which won't match
      expect(results.length).toBe(0)
    })
  })

  describe('Empty $and and $or arrays', () => {
    it('should handle empty $and array', () => {
      const users = createMemoryCollection<User>()

      users.put('u1', { name: 'Alice', email: 'a@test.com', age: 30, active: true })

      // Empty $and should not add conditions
      const results = users.find({ $and: [] })
      expect(results.length).toBe(1)
    })

    it('should handle empty $or array', () => {
      const users = createMemoryCollection<User>()

      users.put('u1', { name: 'Alice', email: 'a@test.com', age: 30, active: true })

      // Empty $or should not add conditions (but currently returns 0 since none match)
      const results = users.find({ $or: [] })
      // In our implementation, empty $or returns no matches
      expect(results.length).toBe(0)
    })
  })

  describe('Numeric comparison edge cases', () => {
    it('should handle comparison with zero', () => {
      const users = createMemoryCollection<Record<string, unknown>>()

      users.put('u1', { name: 'Alice', score: 0 })
      users.put('u2', { name: 'Bob', score: 5 })
      users.put('u3', { name: 'Charlie', score: -5 })

      const gtZero = users.find({ score: { $gt: 0 } })
      expect(gtZero.length).toBe(1)
      expect(gtZero[0]['name']).toBe('Bob')

      const gteZero = users.find({ score: { $gte: 0 } })
      expect(gteZero.length).toBe(2)

      const ltZero = users.find({ score: { $lt: 0 } })
      expect(ltZero.length).toBe(1)
      expect(ltZero[0]['name']).toBe('Charlie')
    })

    it('should handle negative numbers', () => {
      const users = createMemoryCollection<Record<string, unknown>>()

      users.put('u1', { name: 'Alice', balance: -100 })
      users.put('u2', { name: 'Bob', balance: -50 })
      users.put('u3', { name: 'Charlie', balance: 50 })

      const negative = users.find({ balance: { $lt: 0 } })
      expect(negative.length).toBe(2)

      const moreThanNeg75 = users.find({ balance: { $gt: -75 } })
      expect(moreThanNeg75.length).toBe(2)
    })

    it('should handle floating point numbers', () => {
      const users = createMemoryCollection<Record<string, unknown>>()

      users.put('u1', { name: 'Alice', rating: 4.5 })
      users.put('u2', { name: 'Bob', rating: 3.7 })
      users.put('u3', { name: 'Charlie', rating: 4.0 })

      const highRating = users.find({ rating: { $gte: 4.0 } })
      expect(highRating.length).toBe(2)
    })
  })
})
