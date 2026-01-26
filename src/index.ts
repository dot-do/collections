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
 *     return this.users.find({ active: true, role: 'admin' })
 *   }
 * }
 * ```
 *
 * @packageDocumentation
 */

// Types
export type {
  FilterOperator,
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
  Filter,
  QueryOptions,
  ReadCollection,
  WriteCollection,
  Collection,
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
  isFilterOperator,
} from './types'

// Filter utilities
export { compileFilter, validateFieldName, escapeSql, toSqlValue } from './filter'

// Collection factory
export { createCollection, initCollectionsSchema } from './collection'

// Collections manager
export { Collections } from './manager'

// Memory implementation
export { MemoryCollection, createMemoryCollection } from './memory'

// DO mixin for typed collections
export { withCollections, type CollectionsProxy, type CollectionsDOInstance } from './do'
