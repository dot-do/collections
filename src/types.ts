/**
 * Collection Types
 *
 * Type definitions for MongoDB-style document store interfaces.
 *
 * These types are imported from @dotdo/types/database and re-exported for
 * convenience. They are designed for synchronous SQLite operations with
 * MongoDB-style filter operators ($eq, $gt, $in, etc.).
 *
 * For Digital Object integration, this package can be used as the underlying
 * storage implementation for $.db collections.
 *
 * @see {@link https://collections.do} for documentation
 * @see {@link @dotdo/types/database} for type definitions
 */

// =============================================================================
// Re-export types from @dotdo/types/database
// =============================================================================

export type {
  // Collection interfaces
  SyncCollection,
  SyncReadCollection,
  SyncWriteCollection,
  AsyncCollection,
  AsyncReadCollection,
  AsyncWriteCollection,
  // Filter types
  Filter,
  FilterOperator,
  FilterValue,
  // Query options
  SyncQueryOptions,
  AsyncQueryOptions,
  // Bulk operations
  BulkResult,
  BulkResultError,
  // Legacy types (deprecated but still exported for compatibility)
  CollectionFilter,
  CollectionFilterOperator,
  CollectionFieldFilter,
} from '@dotdo/types/database'

// =============================================================================
// Local Type Aliases for Backward Compatibility
// =============================================================================

import type {
  SyncCollection,
  SyncReadCollection,
  SyncWriteCollection,
  Filter,
  SyncQueryOptions,
} from '@dotdo/types/database'

/**
 * Collection interface (alias for SyncCollection)
 * @deprecated Use SyncCollection from @dotdo/types/database
 */
export type Collection<T extends Record<string, unknown> = Record<string, unknown>> = SyncCollection<T>

/**
 * Read-only collection interface (alias for SyncReadCollection)
 * @deprecated Use SyncReadCollection from @dotdo/types/database
 */
export type ReadCollection<T extends Record<string, unknown> = Record<string, unknown>> = SyncReadCollection<T>

/**
 * Write-only collection interface (alias for SyncWriteCollection)
 * @deprecated Use SyncWriteCollection from @dotdo/types/database
 */
export type WriteCollection<T extends Record<string, unknown> = Record<string, unknown>> = SyncWriteCollection<T>

/**
 * Query options (alias for SyncQueryOptions)
 * @deprecated Use SyncQueryOptions from @dotdo/types/database
 */
export type QueryOptions = SyncQueryOptions

// =============================================================================
// Individual Filter Operator Types (for type guards)
// =============================================================================

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
 * MongoDB-style filter operators (union of all operator interfaces)
 */
export type FilterOperatorObject =
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

// =============================================================================
// Type Guards
// =============================================================================

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
 * Check if value is any FilterOperator object
 */
export function isFilterOperator(value: unknown): value is FilterOperatorObject {
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
