/**
 * Filter Compilation
 *
 * Compile MongoDB-style filters to SQL WHERE clauses
 */

import type { Filter } from './types'

// ============================================================================
// Field Name Validation
// ============================================================================

/**
 * Valid field name pattern: alphanumeric, underscores, and dots for nested paths
 */
const VALID_FIELD_PATTERN = /^[\w.]+$/

/**
 * Validate and escape a field name for use in SQL
 * Prevents SQL injection in field names
 *
 * @throws Error if field name contains invalid characters
 */
export function validateFieldName(field: string): string {
  if (!VALID_FIELD_PATTERN.test(field)) {
    throw new Error(
      `Invalid field name: "${field}". Field names must only contain alphanumeric characters, underscores, and dots.`
    )
  }
  return field
}

// ============================================================================
// SQL Value Escaping
// ============================================================================

/**
 * Escape a string value for safe use in SQL
 * This is a defense-in-depth measure - parameterized queries should be the primary protection
 *
 * @param value - The value to escape
 * @returns The escaped string
 */
export function escapeSql(value: string): string {
  // Replace single quotes with two single quotes (SQL standard escape)
  return value.replace(/'/g, "''")
}

/**
 * Convert a value to its SQL-safe representation for parameterized queries
 * Handles boolean conversion since SQLite JSON stores booleans as 1/0
 */
export function toSqlValue(value: unknown): unknown {
  if (typeof value === 'boolean') {
    return value ? 1 : 0
  }
  return value
}

// ============================================================================
// Filter Compiler
// ============================================================================

/**
 * Compile a MongoDB-style filter to SQL WHERE clause
 *
 * @param filter - The filter object
 * @param params - Array to push parameter values into
 * @returns SQL WHERE clause string
 */
export function compileFilter<T>(filter: Filter<T>, params: unknown[]): string {
  const conditions: string[] = []

  for (const [key, value] of Object.entries(filter)) {
    if (key === '$and' && Array.isArray(value)) {
      const subConditions = value.map((f) => compileFilter(f, params))
      if (subConditions.length > 0) {
        conditions.push(`(${subConditions.join(' AND ')})`)
      }
    } else if (key === '$or' && Array.isArray(value)) {
      const subConditions = value.map((f) => compileFilter(f, params))
      if (subConditions.length > 0) {
        conditions.push(`(${subConditions.join(' OR ')})`)
      }
    } else if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      // Validate field name to prevent SQL injection
      const safeField = validateFieldName(key)
      const op = value as Record<string, unknown>

      // Check for filter operators
      if ('$eq' in op) {
        params.push(toSqlValue(op['$eq']))
        conditions.push(`json_extract(data, '$.${safeField}') = ?`)
      } else if ('$ne' in op) {
        params.push(toSqlValue(op['$ne']))
        conditions.push(`json_extract(data, '$.${safeField}') != ?`)
      } else if ('$gt' in op) {
        params.push(op['$gt'])
        conditions.push(`CAST(json_extract(data, '$.${safeField}') AS REAL) > ?`)
      } else if ('$gte' in op) {
        params.push(op['$gte'])
        conditions.push(`CAST(json_extract(data, '$.${safeField}') AS REAL) >= ?`)
      } else if ('$lt' in op) {
        params.push(op['$lt'])
        conditions.push(`CAST(json_extract(data, '$.${safeField}') AS REAL) < ?`)
      } else if ('$lte' in op) {
        params.push(op['$lte'])
        conditions.push(`CAST(json_extract(data, '$.${safeField}') AS REAL) <= ?`)
      } else if ('$in' in op && Array.isArray(op['$in'])) {
        const inValues = (op['$in'] as unknown[]).map((v) => toSqlValue(v))
        if (inValues.length === 0) {
          // Empty $in array: no values can match, always false
          conditions.push('1=0')
        } else {
          const placeholders = inValues.map(() => '?').join(', ')
          params.push(...inValues)
          conditions.push(`json_extract(data, '$.${safeField}') IN (${placeholders})`)
        }
      } else if ('$nin' in op && Array.isArray(op['$nin'])) {
        const ninValues = (op['$nin'] as unknown[]).map((v) => toSqlValue(v))
        if (ninValues.length === 0) {
          // Empty $nin array: all values are "not in" empty set, always true
          conditions.push('1=1')
        } else {
          const placeholders = ninValues.map(() => '?').join(', ')
          params.push(...ninValues)
          conditions.push(`json_extract(data, '$.${safeField}') NOT IN (${placeholders})`)
        }
      } else if ('$exists' in op) {
        if (op['$exists']) {
          conditions.push(`json_extract(data, '$.${safeField}') IS NOT NULL`)
        } else {
          conditions.push(`json_extract(data, '$.${safeField}') IS NULL`)
        }
      } else if ('$regex' in op) {
        params.push(op['$regex'])
        conditions.push(`json_extract(data, '$.${safeField}') REGEXP ?`)
      } else {
        // Plain object value - exact match
        params.push(JSON.stringify(value))
        conditions.push(`json_extract(data, '$.${safeField}') = json(?)`)
      }
    } else {
      // Simple equality - validate field name and handle booleans
      const safeField = validateFieldName(key)
      params.push(toSqlValue(value))
      conditions.push(`json_extract(data, '$.${safeField}') = ?`)
    }
  }

  return conditions.length > 0 ? conditions.join(' AND ') : '1=1'
}
