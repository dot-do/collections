/**
 * Collection Factory
 *
 * Create a collection bound to a SQL storage
 */

import type { SyncCollection, Filter, SyncQueryOptions } from './types'
import { compileFilter, validateFieldName } from './filter'

// ============================================================================
// Input Validation
// ============================================================================

/**
 * Validate document ID for put() operations.
 * @throws Error if id is not a non-empty string
 */
function validateDocumentId(id: unknown): asserts id is string {
  if (typeof id !== 'string' || id.length === 0) {
    throw new Error('Document ID must be a non-empty string')
  }
}

/**
 * Validate document for put() operations.
 * @throws Error if doc is not a non-null object
 */
function validateDocument(doc: unknown): asserts doc is Record<string, unknown> {
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) {
    throw new Error('Document must be a non-null object')
  }
}

/**
 * Validate query options.
 * @throws Error if offset is used without limit
 */
function validateQueryOptions(options?: SyncQueryOptions): void {
  if (options?.offset !== undefined && options?.limit === undefined) {
    throw new Error('offset requires limit to be specified')
  }
}

// ============================================================================
// SQL Schema
// ============================================================================

/**
 * Initialize the collections schema.
 * Each statement must be executed separately since SqlStorage.exec()
 * may not support multiple statements in a single call.
 */
export function initCollectionsSchema(sql: SqlStorage): void {
  sql.exec(`
    CREATE TABLE IF NOT EXISTS _collections (
      collection TEXT NOT NULL,
      id TEXT NOT NULL,
      data TEXT NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
      PRIMARY KEY (collection, id)
    )
  `)
  sql.exec(`CREATE INDEX IF NOT EXISTS _collections_collection ON _collections(collection)`)
  sql.exec(`CREATE INDEX IF NOT EXISTS _collections_updated ON _collections(collection, updated_at)`)
}

// ============================================================================
// Collection Factory
// ============================================================================

/**
 * Track which SqlStorage instances have been initialized.
 * We use a WeakSet to avoid memory leaks - when a SqlStorage is GC'd,
 * it's automatically removed from this set.
 */
const initializedStorages = new WeakSet<SqlStorage>()

/**
 * Create a collection bound to a SQL storage
 *
 * @param sql - The SqlStorage instance
 * @param collectionName - The collection name
 * @returns A SyncCollection interface for the specified collection
 *
 * @example
 * ```typescript
 * const users = createCollection<User>(sql, 'users')
 * users.put('user1', { name: 'Alice', email: 'alice@example.com' })
 * const user = users.get('user1')
 * ```
 */
export function createCollection<T extends Record<string, unknown> = Record<string, unknown>>(
  sql: SqlStorage,
  collectionName: string
): SyncCollection<T> {
  // Initialize schema once per SqlStorage instance
  if (!initializedStorages.has(sql)) {
    initCollectionsSchema(sql)
    initializedStorages.add(sql)
  }

  return {
    // Collection name property
    get name(): string {
      return collectionName
    },

    get(id: string): T | null {
      const rows = sql
        .exec<{ data: string }>(`SELECT data FROM _collections WHERE collection = ? AND id = ?`, collectionName, id)
        .toArray()
      const firstRow = rows[0]
      return rows.length > 0 && firstRow ? JSON.parse(firstRow.data) : null
    },

    getMany(ids: string[]): Array<T | null> {
      if (ids.length === 0) {
        return []
      }
      // Fetch all documents in a single query
      const placeholders = ids.map(() => '?').join(', ')
      const rows = sql
        .exec<{ id: string; data: string }>(
          `SELECT id, data FROM _collections WHERE collection = ? AND id IN (${placeholders})`,
          collectionName,
          ...ids
        )
        .toArray()

      // Create a map for O(1) lookup
      const dataMap = new Map<string, T>()
      for (const row of rows) {
        dataMap.set(row.id, JSON.parse(row.data))
      }

      // Return in the same order as input IDs (null for missing)
      return ids.map((id) => dataMap.get(id) ?? null)
    },

    put(id: string, doc: T): void {
      validateDocumentId(id)
      validateDocument(doc)
      const data = JSON.stringify(doc)
      const now = Date.now()
      sql.exec(
        `INSERT INTO _collections (collection, id, data, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(collection, id) DO UPDATE SET data = ?, updated_at = ?`,
        collectionName,
        id,
        data,
        now,
        now,
        data,
        now
      )
    },

    delete(id: string): boolean {
      const result = sql.exec(`DELETE FROM _collections WHERE collection = ? AND id = ?`, collectionName, id)
      return result.rowsWritten > 0
    },

    has(id: string): boolean {
      const rows = sql
        .exec<{ c: number }>(`SELECT 1 as c FROM _collections WHERE collection = ? AND id = ?`, collectionName, id)
        .toArray()
      return rows.length > 0
    },

    find(filter?: Filter<T>, options?: SyncQueryOptions): T[] {
      validateQueryOptions(options)
      const params: unknown[] = [collectionName]
      let whereClause = 'collection = ?'

      if (filter && Object.keys(filter).length > 0) {
        whereClause += ' AND ' + compileFilter(filter, params)
      }

      let queryStr = `SELECT data FROM _collections WHERE ${whereClause}`

      // Sort
      if (options?.sort) {
        const desc = options.sort.startsWith('-')
        const field = desc ? options.sort.slice(1) : options.sort
        // Validate sort field to prevent SQL injection
        const safeField = validateFieldName(field)
        queryStr += ` ORDER BY json_extract(data, '$.${safeField}') ${desc ? 'DESC' : 'ASC'}`
      } else {
        queryStr += ' ORDER BY updated_at DESC'
      }

      // Pagination
      if (options?.limit) {
        queryStr += ` LIMIT ${Number(options.limit)}`
      }
      if (options?.offset) {
        queryStr += ` OFFSET ${Number(options.offset)}`
      }

      const rows = sql.exec<{ data: string }>(queryStr, ...params).toArray()
      return rows.map((row) => JSON.parse(row.data))
    },

    count(filter?: Filter<T>): number {
      const params: unknown[] = [collectionName]
      let whereClause = 'collection = ?'

      if (filter && Object.keys(filter).length > 0) {
        whereClause += ' AND ' + compileFilter(filter, params)
      }

      const rows = sql
        .exec<{ c: number }>(`SELECT COUNT(*) as c FROM _collections WHERE ${whereClause}`, ...params)
        .toArray()
      return rows[0]?.c ?? 0
    },

    list(options?: SyncQueryOptions): T[] {
      return this.find(undefined, options)
    },

    keys(): string[] {
      const rows = sql
        .exec<{ id: string }>(`SELECT id FROM _collections WHERE collection = ? ORDER BY id`, collectionName)
        .toArray()
      return rows.map((row) => row.id)
    },

    clear(): number {
      const result = sql.exec(`DELETE FROM _collections WHERE collection = ?`, collectionName)
      return result.rowsWritten
    },

    putMany(items: Array<{ id: string; doc: T }>): number {
      if (items.length === 0) {
        return 0
      }

      const now = Date.now()
      let count = 0

      for (const { id, doc } of items) {
        validateDocumentId(id)
        validateDocument(doc)
        const data = JSON.stringify(doc)
        sql.exec(
          `INSERT INTO _collections (collection, id, data, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(collection, id) DO UPDATE SET data = ?, updated_at = ?`,
          collectionName,
          id,
          data,
          now,
          now,
          data,
          now
        )
        count++
      }

      return count
    },

    deleteMany(ids: string[]): number {
      if (ids.length === 0) {
        return 0
      }

      // Build placeholders for IN clause
      const placeholders = ids.map(() => '?').join(', ')
      const result = sql.exec(
        `DELETE FROM _collections WHERE collection = ? AND id IN (${placeholders})`,
        collectionName,
        ...ids
      )
      return result.rowsWritten
    },
  }
}
