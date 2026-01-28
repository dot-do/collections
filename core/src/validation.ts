/**
 * Validation utilities for collections
 *
 * Shared validation functions used by both SQLite and Memory collection implementations.
 */

import type { SyncQueryOptions } from './types'

/** Maximum allowed limit value to prevent excessive memory usage */
export const MAX_LIMIT = 10000

/**
 * Validate document ID for put() operations.
 * @throws Error if id is not a non-empty string
 */
export function validateDocumentId(id: unknown): asserts id is string {
  if (typeof id !== 'string' || id.length === 0) {
    throw new Error('Document ID must be a non-empty string')
  }
}

/**
 * Validate document for put() operations.
 * @throws Error if doc is not a non-null object
 */
export function validateDocument(doc: unknown): asserts doc is Record<string, unknown> {
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) {
    throw new Error('Document must be a non-null object')
  }
}

/**
 * Check if a value is a valid non-negative integer.
 * Rejects NaN, Infinity, negative values, and non-integers.
 */
export function isValidNonNegativeInteger(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    Number.isInteger(value) &&
    value >= 0
  )
}

/**
 * Check if a value is a valid positive integer.
 * Rejects NaN, Infinity, zero, negative values, and non-integers.
 */
export function isValidPositiveInteger(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    Number.isInteger(value) &&
    value > 0
  )
}

/**
 * Validate query options.
 * @throws Error if offset is used without limit
 * @throws Error if limit is not a positive integer or exceeds maximum
 * @throws Error if offset is not a non-negative integer
 */
export function validateQueryOptions(options?: SyncQueryOptions): void {
  if (!options) {
    return
  }

  // Validate limit
  if (options.limit !== undefined) {
    if (!isValidPositiveInteger(options.limit)) {
      throw new Error(
        `Invalid limit: must be a positive integer. Received: ${String(options.limit)}`
      )
    }
    if (options.limit > MAX_LIMIT) {
      throw new Error(
        `Invalid limit: must not exceed ${MAX_LIMIT}. Received: ${options.limit}`
      )
    }
  }

  // Validate offset
  if (options.offset !== undefined) {
    if (!isValidNonNegativeInteger(options.offset)) {
      throw new Error(
        `Invalid offset: must be a non-negative integer. Received: ${String(options.offset)}`
      )
    }
    if (options.limit === undefined) {
      throw new Error('offset requires limit to be specified')
    }
  }
}
