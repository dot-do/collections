/**
 * Filter Tests
 *
 * Tests for the filter compilation and recursion depth limit
 */

import { describe, it, expect } from 'vitest'
import { compileFilter, MAX_FILTER_DEPTH } from '../src/filter'

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Create a deeply nested $and/$or filter structure
 */
function createNestedFilter(depth: number, operator: '$and' | '$or' = '$and'): Record<string, unknown> {
  if (depth <= 0) {
    return { name: 'test' }
  }
  return {
    [operator]: [createNestedFilter(depth - 1, operator)],
  }
}

/**
 * Create a filter with alternating $and/$or nesting
 */
function createAlternatingNestedFilter(depth: number): Record<string, unknown> {
  if (depth <= 0) {
    return { status: 'active' }
  }
  const operator = depth % 2 === 0 ? '$and' : '$or'
  return {
    [operator]: [createAlternatingNestedFilter(depth - 1)],
  }
}

// ============================================================================
// MAX_FILTER_DEPTH Export Tests
// ============================================================================

describe('MAX_FILTER_DEPTH constant', () => {
  it('should be exported and be a positive number', () => {
    expect(MAX_FILTER_DEPTH).toBeDefined()
    expect(typeof MAX_FILTER_DEPTH).toBe('number')
    expect(MAX_FILTER_DEPTH).toBeGreaterThan(0)
  })

  it('should be 10', () => {
    expect(MAX_FILTER_DEPTH).toBe(10)
  })
})

// ============================================================================
// Recursion Depth Limit Tests
// ============================================================================

describe('Filter Recursion Depth Limit', () => {
  describe('filters with reasonable nesting', () => {
    it('should allow nesting up to 5 levels with $and', () => {
      const filter = createNestedFilter(5, '$and')
      const params: unknown[] = []

      // Should not throw
      const result = compileFilter(filter, params)
      expect(result).toContain('json_extract')
    })

    it('should allow nesting up to 5 levels with $or', () => {
      const filter = createNestedFilter(5, '$or')
      const params: unknown[] = []

      // Should not throw
      const result = compileFilter(filter, params)
      expect(result).toContain('json_extract')
    })

    it('should allow nesting at exactly MAX_FILTER_DEPTH', () => {
      const filter = createNestedFilter(10, '$and')
      const params: unknown[] = []

      // Should not throw at the limit
      const result = compileFilter(filter, params)
      expect(result).toContain('json_extract')
    })

    it('should handle mixed $and and $or at reasonable depth', () => {
      const filter = createAlternatingNestedFilter(5)
      const params: unknown[] = []

      // Should not throw
      const result = compileFilter(filter, params)
      expect(result).toContain('json_extract')
    })

    it('should handle complex real-world queries within depth limit', () => {
      const filter = {
        $and: [
          { status: 'active' },
          {
            $or: [
              { role: 'admin' },
              {
                $and: [
                  { role: 'user' },
                  { verified: true },
                ],
              },
            ],
          },
        ],
      }
      const params: unknown[] = []

      // Should not throw - this is depth 3
      const result = compileFilter(filter as any, params)
      expect(result).toContain('json_extract')
    })
  })

  describe('filters exceeding max depth', () => {
    it('should throw error when nesting exceeds MAX_FILTER_DEPTH with $and', () => {
      const filter = createNestedFilter(15, '$and')
      const params: unknown[] = []

      expect(() => compileFilter(filter as any, params)).toThrow(/depth|recursion|nested/i)
    })

    it('should throw error when nesting exceeds MAX_FILTER_DEPTH with $or', () => {
      const filter = createNestedFilter(15, '$or')
      const params: unknown[] = []

      expect(() => compileFilter(filter as any, params)).toThrow(/depth|recursion|nested/i)
    })

    it('should throw error for 20+ levels of nesting', () => {
      const filter = createNestedFilter(20, '$and')
      const params: unknown[] = []

      expect(() => compileFilter(filter as any, params)).toThrow(/depth|recursion|nested/i)
    })

    it('should throw error for deeply nested alternating $and/$or', () => {
      const filter = createAlternatingNestedFilter(15)
      const params: unknown[] = []

      expect(() => compileFilter(filter as any, params)).toThrow(/depth|recursion|nested/i)
    })

    it('should throw error at exactly MAX_FILTER_DEPTH + 1', () => {
      const filter = createNestedFilter(11, '$and')
      const params: unknown[] = []

      expect(() => compileFilter(filter as any, params)).toThrow(/depth|recursion|nested/i)
    })

    it('should include helpful error message with depth limit', () => {
      const filter = createNestedFilter(15, '$and')
      const params: unknown[] = []

      try {
        compileFilter(filter as any, params)
        expect.fail('Expected an error to be thrown')
      } catch (error) {
        expect((error as Error).message).toMatch(/10|MAX_FILTER_DEPTH|maximum/i)
      }
    })
  })

  describe('$not operator depth tracking', () => {
    it('should track depth through $not operator', () => {
      // Create a filter with $not that exceeds depth
      const deepNotFilter = {
        $not: {
          $and: [createNestedFilter(12, '$and')],
        },
      }
      const params: unknown[] = []

      expect(() => compileFilter(deepNotFilter as any, params)).toThrow(/depth|recursion|nested/i)
    })

    it('should allow $not at reasonable depth', () => {
      const filter = {
        $not: {
          $and: [
            { status: 'inactive' },
            { deleted: true },
          ],
        },
      }
      const params: unknown[] = []

      // Should not throw
      const result = compileFilter(filter as any, params)
      expect(result).toContain('NOT')
    })
  })

  describe('edge cases', () => {
    it('should handle empty $and arrays', () => {
      const filter = { $and: [] }
      const params: unknown[] = []

      // Should not throw
      const result = compileFilter(filter as any, params)
      expect(result).toBeDefined()
    })

    it('should handle empty $or arrays', () => {
      const filter = { $or: [] }
      const params: unknown[] = []

      // Should not throw
      const result = compileFilter(filter as any, params)
      expect(result).toBeDefined()
    })

    it('should handle flat filters without nesting', () => {
      const filter = {
        name: 'test',
        age: { $gt: 18 },
        status: { $in: ['active', 'pending'] },
      }
      const params: unknown[] = []

      // Should not throw
      const result = compileFilter(filter as any, params)
      expect(result).toContain('json_extract')
    })

    it('should handle multiple items in $and at same depth', () => {
      const filter = {
        $and: [
          { field1: 'value1' },
          { field2: 'value2' },
          { field3: 'value3' },
          { field4: 'value4' },
          { field5: 'value5' },
          { field6: 'value6' },
          { field7: 'value7' },
          { field8: 'value8' },
          { field9: 'value9' },
          { field10: 'value10' },
        ],
      }
      const params: unknown[] = []

      // Width should not count towards depth
      const result = compileFilter(filter as any, params)
      expect(result).toContain('AND')
    })
  })
})
