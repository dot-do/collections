/**
 * Collection Types
 *
 * Type definitions for MongoDB-style document store interfaces
 */

// ============================================================================
// Filter Operators
// ============================================================================

/**
 * Equality operator
 */
export interface EqOperator {
  $eq: unknown
}

/**
 * Not equal operator
 */
export interface NeOperator {
  $ne: unknown
}

/**
 * Greater than operator
 */
export interface GtOperator {
  $gt: number
}

/**
 * Greater than or equal operator
 */
export interface GteOperator {
  $gte: number
}

/**
 * Less than operator
 */
export interface LtOperator {
  $lt: number
}

/**
 * Less than or equal operator
 */
export interface LteOperator {
  $lte: number
}

/**
 * In array operator
 */
export interface InOperator {
  $in: unknown[]
}

/**
 * Not in array operator
 */
export interface NinOperator {
  $nin: unknown[]
}

/**
 * Field existence operator
 */
export interface ExistsOperator {
  $exists: boolean
}

/**
 * Regular expression operator
 */
export interface RegexOperator {
  $regex: string
}

/**
 * MongoDB-style filter operators
 */
export type FilterOperator =
  | EqOperator
  | NeOperator
  | GtOperator
  | GteOperator
  | LtOperator
  | LteOperator
  | InOperator
  | NinOperator
  | ExistsOperator
  | RegexOperator

/**
 * MongoDB-style filter query
 */
export type Filter<T> = {
  [K in keyof T]?: T[K] | FilterOperator
} & {
  $and?: Filter<T>[]
  $or?: Filter<T>[]
}

/**
 * Query options
 */
export interface QueryOptions {
  /** Maximum number of results */
  limit?: number
  /** Number of results to skip */
  offset?: number
  /** Sort by field (prefix with - for descending) */
  sort?: string
}

// ============================================================================
// Type Guards
// ============================================================================

/**
 * Check if value is an EqOperator
 */
export function isEqOperator(value: unknown): value is EqOperator {
  return value !== null && typeof value === 'object' && '$eq' in value
}

/**
 * Check if value is a NeOperator
 */
export function isNeOperator(value: unknown): value is NeOperator {
  return value !== null && typeof value === 'object' && '$ne' in value
}

/**
 * Check if value is a GtOperator
 */
export function isGtOperator(value: unknown): value is GtOperator {
  return value !== null && typeof value === 'object' && '$gt' in value
}

/**
 * Check if value is a GteOperator
 */
export function isGteOperator(value: unknown): value is GteOperator {
  return value !== null && typeof value === 'object' && '$gte' in value
}

/**
 * Check if value is a LtOperator
 */
export function isLtOperator(value: unknown): value is LtOperator {
  return value !== null && typeof value === 'object' && '$lt' in value
}

/**
 * Check if value is a LteOperator
 */
export function isLteOperator(value: unknown): value is LteOperator {
  return value !== null && typeof value === 'object' && '$lte' in value
}

/**
 * Check if value is an InOperator
 */
export function isInOperator(value: unknown): value is InOperator {
  return value !== null && typeof value === 'object' && '$in' in value && Array.isArray((value as InOperator).$in)
}

/**
 * Check if value is a NinOperator
 */
export function isNinOperator(value: unknown): value is NinOperator {
  return value !== null && typeof value === 'object' && '$nin' in value && Array.isArray((value as NinOperator).$nin)
}

/**
 * Check if value is an ExistsOperator
 */
export function isExistsOperator(value: unknown): value is ExistsOperator {
  return value !== null && typeof value === 'object' && '$exists' in value
}

/**
 * Check if value is a RegexOperator
 */
export function isRegexOperator(value: unknown): value is RegexOperator {
  return value !== null && typeof value === 'object' && '$regex' in value
}

/**
 * Check if value is any FilterOperator
 */
export function isFilterOperator(value: unknown): value is FilterOperator {
  return (
    isEqOperator(value) ||
    isNeOperator(value) ||
    isGtOperator(value) ||
    isGteOperator(value) ||
    isLtOperator(value) ||
    isLteOperator(value) ||
    isInOperator(value) ||
    isNinOperator(value) ||
    isExistsOperator(value) ||
    isRegexOperator(value)
  )
}

// ============================================================================
// Collection Interfaces
// ============================================================================

/**
 * Read-only collection interface
 */
export interface ReadCollection<T extends Record<string, unknown> = Record<string, unknown>> {
  /** Get a document by ID */
  get(id: string): T | null
  /** Check if document exists */
  has(id: string): boolean
  /** Find documents matching filter */
  find(filter?: Filter<T>, options?: QueryOptions): T[]
  /** Count documents matching filter */
  count(filter?: Filter<T>): number
  /** List all documents */
  list(options?: QueryOptions): T[]
  /** Get all IDs */
  keys(): string[]
}

/**
 * Write-only collection interface
 */
export interface WriteCollection<T extends Record<string, unknown> = Record<string, unknown>> {
  /** Put a document (insert or update) */
  put(id: string, doc: T): void
  /** Delete a document */
  delete(id: string): boolean
  /** Delete all documents in collection */
  clear(): number
}

/**
 * Full collection interface (read + write)
 */
export interface Collection<T extends Record<string, unknown> = Record<string, unknown>>
  extends ReadCollection<T>,
    WriteCollection<T> {}
