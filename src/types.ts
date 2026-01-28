/**
 * Type exports for collections.do
 *
 * Re-exports all types from @dotdo/collections for convenience.
 */

export type {
  // Collection interfaces
  SyncCollection,
  AsyncCollection,
  SyncReadCollection,
  SyncWriteCollection,
  AsyncReadCollection,
  AsyncWriteCollection,
  Collection,
  ReadCollection,
  WriteCollection,
  // Filter types
  Filter,
  FilterOperator,
  FilterValue,
  // Query options
  SyncQueryOptions,
  AsyncQueryOptions,
  QueryOptions,
  // Bulk operations
  BulkResult,
  BulkResultError,
  // Legacy types (deprecated)
  CollectionFilter,
  CollectionFilterOperator,
  CollectionFieldFilter,
  // Operator types
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
} from '@dotdo/collections/types'

// Re-export type guards
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
} from '@dotdo/collections/types'
