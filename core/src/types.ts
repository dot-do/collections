/**
 * Collection Types
 *
 * Type definitions for MongoDB-style document store interfaces.
 *
 * These types are designed for Cloudflare Durable Object KV API compatibility,
 * with synchronous SQLite operations and MongoDB-style filter operators
 * ($eq, $gt, $in, etc.).
 *
 * @see {@link https://collections.do} for documentation
 */

// =============================================================================
// Filter Types (re-exported from @dotdo/types/database for compatibility)
// =============================================================================

export type {
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

import type { Filter, SyncQueryOptions } from '@dotdo/types/database'

// =============================================================================
// Sync Collection Interfaces (Cloudflare DO KV API Compatible)
// =============================================================================

/**
 * Read-only synchronous collection interface.
 *
 * Provides synchronous read operations for SQLite-backed collections
 * within Durable Objects. Returns null for missing keys (Cloudflare DO KV compatible).
 *
 * @template T - The document type stored in the collection
 */
export interface SyncReadCollection<T extends Record<string, unknown> = Record<string, unknown>> {
  /**
   * Get a document by its ID.
   *
   * @param id - The document identifier
   * @returns The document if found, or null if not found (DO KV compatible)
   */
  get(id: string): T | null

  /**
   * Get multiple documents by their IDs.
   *
   * @param ids - Array of document identifiers
   * @returns Array of documents in the same order as IDs (null for missing docs)
   */
  getMany(ids: string[]): Array<T | null>

  /**
   * Check if a document exists by ID.
   *
   * @param id - The document identifier
   * @returns True if the document exists
   */
  has(id: string): boolean

  /**
   * Count documents in the collection.
   *
   * @param filter - Optional filter criteria
   * @returns Number of documents (matching filter if provided)
   */
  count(filter?: Filter<T>): number

  /**
   * List all documents in the collection.
   *
   * @param options - Query options (limit, offset, sort)
   * @returns Array of all documents
   */
  list(options?: SyncQueryOptions): T[]

  /**
   * Get all document IDs in the collection.
   *
   * @returns Array of document IDs
   */
  keys(): string[]

  /**
   * Find documents matching a filter.
   *
   * @param filter - Optional filter criteria (returns all if omitted)
   * @param options - Query options (limit, offset, sort)
   * @returns Array of matching documents
   */
  find(filter?: Filter<T>, options?: SyncQueryOptions): T[]

  /**
   * Query documents matching a filter.
   *
   * @param filter - Filter criteria (required)
   * @param options - Query options (limit, offset, sort)
   * @returns Array of matching documents
   */
  query(filter: Filter<T>, options?: SyncQueryOptions): T[]
}

/**
 * Write-only synchronous collection interface.
 *
 * Provides synchronous write operations for SQLite-backed collections
 * within Durable Objects.
 *
 * @template T - The document type stored in the collection
 */
export interface SyncWriteCollection<T extends Record<string, unknown> = Record<string, unknown>> {
  /**
   * Insert or update a document by ID.
   *
   * If a document with the same ID exists, it will be replaced.
   *
   * @param id - The document identifier
   * @param doc - The document to insert/update
   */
  put(id: string, doc: T): void

  /**
   * Insert or update multiple documents.
   *
   * @param items - Array of {id, doc} pairs to insert/update
   * @returns Number of items processed
   */
  putMany(items: Array<{ id: string; doc: T }>): number

  /**
   * Delete a document by ID.
   *
   * @param id - The document identifier
   * @returns True if a document was deleted, false if not found
   */
  delete(id: string): boolean

  /**
   * Delete multiple documents by their IDs.
   *
   * @param ids - Array of document IDs to delete
   * @returns Number of documents deleted
   */
  deleteMany(ids: string[]): number

  /**
   * Delete all documents in the collection.
   *
   * @returns Number of documents deleted
   */
  clear(): number
}

/**
 * Full synchronous collection interface combining read and write operations.
 *
 * This is the primary interface for working with SQLite-backed collections
 * within Durable Objects, where all operations are synchronous.
 *
 * Key differences from @dotdo/types/database SyncCollection:
 * - get() returns T | null (not T | undefined) for DO KV compatibility
 * - find() method with optional filter (not query() with required filter)
 * - count() accepts optional filter parameter
 *
 * @template T - The document type stored in the collection
 */
export interface SyncCollection<T extends Record<string, unknown> = Record<string, unknown>>
  extends SyncReadCollection<T>,
    SyncWriteCollection<T> {
  /** The name of this collection */
  readonly name: string
}

/**
 * Collection interface (alias for SyncCollection)
 */
export type Collection<T extends Record<string, unknown> = Record<string, unknown>> = SyncCollection<T>

/**
 * Read-only collection interface (alias for SyncReadCollection)
 */
export type ReadCollection<T extends Record<string, unknown> = Record<string, unknown>> = SyncReadCollection<T>

/**
 * Write-only collection interface (alias for SyncWriteCollection)
 */
export type WriteCollection<T extends Record<string, unknown> = Record<string, unknown>> = SyncWriteCollection<T>

/**
 * Query options (alias for SyncQueryOptions)
 */
export type QueryOptions = SyncQueryOptions

// =============================================================================
// Async Collection Interfaces
// =============================================================================

import type { AsyncQueryOptions, BulkResult } from '@dotdo/types/database'

/**
 * Read-only asynchronous collection interface for remote/RPC access.
 *
 * @template T - The document type stored in the collection
 */
export interface AsyncReadCollection<T extends Record<string, unknown> = Record<string, unknown>> {
  get(id: string): Promise<T | null>
  getMany(ids: string[]): Promise<Array<T | null>>
  has(id: string): Promise<boolean>
  count(filter?: Filter<T>): Promise<number>
  list(options?: AsyncQueryOptions): Promise<T[]>
  keys(): Promise<string[]>
  find(filter?: Filter<T>, options?: AsyncQueryOptions): Promise<T[]>
  query(filter: Filter<T>, options?: AsyncQueryOptions): Promise<T[]>
}

/**
 * Write-only asynchronous collection interface for remote/RPC access.
 *
 * @template T - The document type stored in the collection
 */
export interface AsyncWriteCollection<T extends Record<string, unknown> = Record<string, unknown>> {
  put(id: string, doc: T): Promise<void>
  putMany(items: Array<{ id: string; doc: T }>): Promise<BulkResult>
  delete(id: string): Promise<boolean>
  deleteMany(ids: string[]): Promise<BulkResult>
  clear(): Promise<BulkResult>
}

/**
 * Full asynchronous collection interface for remote/RPC access.
 *
 * @template T - The document type stored in the collection
 */
export interface AsyncCollection<T extends Record<string, unknown> = Record<string, unknown>>
  extends AsyncReadCollection<T>,
    AsyncWriteCollection<T> {
  readonly name: string
}

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
 * Contains operator (substring match)
 */
export interface ContainsOperator {
  $contains: string
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
  | ContainsOperator

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
 * Check if value is a ContainsOperator
 */
export function isContainsOperator(value: unknown): value is ContainsOperator {
  return value !== null && typeof value === 'object' && '$contains' in value
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
    isRegexOperator(value) ||
    isContainsOperator(value)
  )
}
