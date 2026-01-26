/**
 * Memory Collection
 *
 * In-memory implementation for testing without SQLite dependency
 *
 * @security Regex patterns ($regex operator) have the following limitations to prevent ReDoS attacks:
 * - Maximum pattern length: 1000 characters
 * - Patterns with nested quantifiers like (a+)+, (a*)*, etc. are rejected
 * - Invalid regex patterns return no matches (fail closed)
 */

import type { SyncCollection, Filter, SyncQueryOptions } from '@dotdo/types/database'
import {
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
} from './types'

// ============================================================================
// Memory Filter Evaluation
// ============================================================================

/**
 * Get a nested value from an object using dot notation
 */
function getNestedValue(obj: Record<string, unknown>, path: string): unknown {
  const parts = path.split('.')
  let current: unknown = obj
  for (const part of parts) {
    if (current === null || current === undefined || typeof current !== 'object') {
      return undefined
    }
    current = (current as Record<string, unknown>)[part]
  }
  return current
}

/**
 * Evaluate a filter against a document
 */
function evaluateFilter<T extends Record<string, unknown>>(doc: T, filter: Filter<T>): boolean {
  for (const [key, value] of Object.entries(filter)) {
    if (key === '$and' && Array.isArray(value)) {
      if (!value.every((f) => evaluateFilter(doc, f))) {
        return false
      }
    } else if (key === '$or' && Array.isArray(value)) {
      if (!value.some((f) => evaluateFilter(doc, f))) {
        return false
      }
    } else if (key === '$not' && value !== null && typeof value === 'object') {
      // $not operator: negate the filter
      if (evaluateFilter(doc, value as Filter<T>)) {
        return false
      }
    } else if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      const docValue = getNestedValue(doc, key)

      if (isEqOperator(value)) {
        if (docValue !== value.$eq) return false
      } else if (isNeOperator(value)) {
        if (docValue === value.$ne) return false
      } else if (isGtOperator(value)) {
        if (typeof docValue !== 'number' || docValue <= value.$gt) return false
      } else if (isGteOperator(value)) {
        if (typeof docValue !== 'number' || docValue < value.$gte) return false
      } else if (isLtOperator(value)) {
        if (typeof docValue !== 'number' || docValue >= value.$lt) return false
      } else if (isLteOperator(value)) {
        if (typeof docValue !== 'number' || docValue > value.$lte) return false
      } else if (isInOperator(value)) {
        if (!value.$in.includes(docValue)) return false
      } else if (isNinOperator(value)) {
        if (value.$nin.includes(docValue)) return false
      } else if (isExistsOperator(value)) {
        const exists = docValue !== undefined && docValue !== null
        if (value.$exists !== exists) return false
      } else if (isRegexOperator(value)) {
        if (typeof docValue !== 'string') return false
        try {
          const pattern = value.$regex
          // Security: Reject patterns that are too long (potential ReDoS)
          if (pattern.length > 1000) {
            return false
          }
          // Security: Reject patterns with excessive nested quantifiers (common ReDoS pattern)
          // Detects patterns like (a+)+, (a*)+, (a+)*, etc.
          const dangerousPattern = /(\([^)]*[+*][^)]*\))[+*]|\([^)]*\([^)]*[+*]/
          if (dangerousPattern.test(pattern)) {
            return false
          }
          const regex = new RegExp(pattern)
          if (!regex.test(docValue)) return false
        } catch {
          return false
        }
      } else {
        // Plain object - exact match
        if (JSON.stringify(docValue) !== JSON.stringify(value)) return false
      }
    } else {
      // Simple equality
      const docValue = getNestedValue(doc, key)
      if (docValue !== value) return false
    }
  }
  return true
}

// ============================================================================
// Memory Collection
// ============================================================================

/**
 * In-memory collection implementation for testing
 *
 * This implementation mimics the behavior of the SQLite-backed collection
 * but stores all data in memory. Useful for unit testing without dependencies.
 *
 * @example
 * ```typescript
 * const users = new MemoryCollection<User>('users')
 * users.put('user1', { name: 'Alice', email: 'alice@example.com' })
 * const user = users.get('user1')
 * ```
 */
export class MemoryCollection<T extends Record<string, unknown> = Record<string, unknown>>
  implements SyncCollection<T>
{
  private data = new Map<string, { doc: T; createdAt: number; updatedAt: number }>()
  private _name: string

  constructor(name: string = 'default') {
    this._name = name
  }

  get name(): string {
    return this._name
  }

  get(id: string): T | undefined {
    const entry = this.data.get(id)
    return entry ? { ...entry.doc } : undefined
  }

  getMany(ids: string[]): Array<T | undefined> {
    return ids.map((id) => this.get(id))
  }

  put(id: string, doc: T): void {
    const now = Date.now()
    const existing = this.data.get(id)
    this.data.set(id, {
      doc: { ...doc },
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    })
  }

  delete(id: string): boolean {
    return this.data.delete(id)
  }

  has(id: string): boolean {
    return this.data.has(id)
  }

  query(filter: Filter<T>, options?: SyncQueryOptions): T[] {
    let results: Array<{ id: string; doc: T; updatedAt: number }> = []

    for (const [id, entry] of this.data.entries()) {
      if (!filter || Object.keys(filter).length === 0 || evaluateFilter(entry.doc, filter)) {
        results.push({ id, doc: { ...entry.doc }, updatedAt: entry.updatedAt })
      }
    }

    // Sort
    if (options?.sort) {
      const desc = options.sort.startsWith('-')
      const field = desc ? options.sort.slice(1) : options.sort
      results.sort((a, b) => {
        const aVal = getNestedValue(a.doc, field)
        const bVal = getNestedValue(b.doc, field)
        if (aVal === bVal) return 0
        if (aVal === undefined || aVal === null) return 1
        if (bVal === undefined || bVal === null) return -1
        const cmp = aVal < bVal ? -1 : 1
        return desc ? -cmp : cmp
      })
    } else {
      // Default: sort by updated_at descending
      results.sort((a, b) => b.updatedAt - a.updatedAt)
    }

    // Pagination
    if (options?.offset) {
      results = results.slice(options.offset)
    }
    if (options?.limit) {
      results = results.slice(0, options.limit)
    }

    return results.map((r) => r.doc)
  }

  count(): number {
    return this.data.size
  }

  list(options?: SyncQueryOptions): T[] {
    return this.query({} as Filter<T>, options)
  }

  keys(): string[] {
    return Array.from(this.data.keys()).sort()
  }

  clear(): number {
    const count = this.data.size
    this.data.clear()
    return count
  }

  putMany(items: Array<{ id: string; doc: T }>): number {
    if (items.length === 0) {
      return 0
    }

    const now = Date.now()
    for (const { id, doc } of items) {
      const existing = this.data.get(id)
      this.data.set(id, {
        doc: { ...doc },
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      })
    }

    return items.length
  }

  deleteMany(ids: string[]): number {
    if (ids.length === 0) {
      return 0
    }

    let count = 0
    for (const id of ids) {
      if (this.data.delete(id)) {
        count++
      }
    }

    return count
  }
}

/**
 * Factory function to create a MemoryCollection
 *
 * @param name - The collection name (default: 'default')
 * @returns A new MemoryCollection instance
 */
export function createMemoryCollection<T extends Record<string, unknown> = Record<string, unknown>>(
  name: string = 'default'
): SyncCollection<T> {
  return new MemoryCollection<T>(name)
}
