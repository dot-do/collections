/**
 * @dotdo/collections
 *
 * MongoDB-style document store on DO SQLite
 *
 * Simple wrapper that provides:
 * - Named collections (like MongoDB)
 * - get/put/delete operations
 * - MongoDB-style filter queries
 * - All stored in a single SQLite table
 *
 * Billing: Each document is 1 row. Queries read only matching rows.
 *
 * @example
 * ```typescript
 * // Inside DO
 * export class MyDO extends DurableObject {
 *   users = createCollection<User>(this.ctx.storage.sql, 'users')
 *
 *   async createUser(data: User) {
 *     await this.users.put(data.id, data)
 *   }
 *
 *   async getActiveUsers() {
 *     return this.users.query({ active: true, role: 'admin' })
 *   }
 * }
 * ```
 *
 * @packageDocumentation
 */

// Types from @dotdo/types/database
export type {
  // Main collection interfaces
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
  // Legacy types (deprecated)
  CollectionFilter,
  CollectionFilterOperator,
  CollectionFieldFilter,
} from '@dotdo/types/database'

// Local type aliases (deprecated - use @dotdo/types/database directly)
export type {
  Collection,
  ReadCollection,
  WriteCollection,
  QueryOptions,
  // Filter operator interfaces (for type guards)
  EqOperator,
  NeOperator,
  GtOperator,
  GteOperator,
  LtOperator,
  LteOperator,
  InOperator,
  NinOperator,
  ExistsOperator,
  RegexOperator,
  FilterOperatorObject,
} from './types'

// Type guards
export {
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
  isContainsOperator,
  isFilterOperator,
} from './types'

// Filter utilities
export { compileFilter, validateFieldName, toSqlValue, validateRegexPattern, MAX_REGEX_PATTERN_LENGTH } from './filter'

// Validation utilities
export {
  MAX_LIMIT,
  validateDocumentId,
  validateDocument,
  validateQueryOptions,
  isValidNonNegativeInteger,
  isValidPositiveInteger,
} from './validation'

// Collection factory
export { createCollection, initCollectionsSchema } from './collection'

// Collections manager
export { Collections } from './manager'

// Memory implementation
export { MemoryCollection, createMemoryCollection } from './memory'

// DO mixin for typed collections
export { withCollections, type CollectionsProxy, type CollectionsDOInstance } from './do'
