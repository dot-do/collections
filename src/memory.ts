/**
 * Memory Collection
 *
 * In-memory implementation for testing without SQLite dependency
 */

import type { Collection, Filter, QueryOptions } from './types'
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
          const regex = new RegExp(value.$regex)
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
 * const users = new MemoryCollection<User>()
 * users.put('user1', { name: 'Alice', email: 'alice@example.com' })
 * const user = users.get('user1')
 * ```
 */
export class MemoryCollection<T extends Record<string, unknown> = Record<string, unknown>> implements Collection<T> {
  private data = new Map<string, { doc: T; createdAt: number; updatedAt: number }>()

  get(id: string): T | null {
    const entry = this.data.get(id)
    return entry ? { ...entry.doc } : null
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

  find(filter?: Filter<T>, options?: QueryOptions): T[] {
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

  count(filter?: Filter<T>): number {
    if (!filter || Object.keys(filter).length === 0) {
      return this.data.size
    }

    let count = 0
    for (const entry of this.data.values()) {
      if (evaluateFilter(entry.doc, filter)) {
        count++
      }
    }
    return count
  }

  list(options?: QueryOptions): T[] {
    return this.find(undefined, options)
  }

  keys(): string[] {
    return Array.from(this.data.keys()).sort()
  }

  clear(): number {
    const count = this.data.size
    this.data.clear()
    return count
  }
}

/**
 * Factory function to create a MemoryCollection
 *
 * @returns A new MemoryCollection instance
 */
export function createMemoryCollection<T extends Record<string, unknown> = Record<string, unknown>>(): Collection<T> {
  return new MemoryCollection<T>()
}
