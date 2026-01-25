/**
 * Collection Factory
 *
 * Create a collection bound to a SQL storage
 */

import type { Collection, Filter, QueryOptions } from './types'
import { compileFilter, validateFieldName } from './filter'

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
 * @param name - The collection name
 * @returns A Collection interface for the specified collection
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
  name: string
): Collection<T> {
  // Initialize schema once per SqlStorage instance
  if (!initializedStorages.has(sql)) {
    initCollectionsSchema(sql)
    initializedStorages.add(sql)
  }

  return {
    get(id: string): T | null {
      const rows = sql
        .exec<{ data: string }>(`SELECT data FROM _collections WHERE collection = ? AND id = ?`, name, id)
        .toArray()
      return rows.length > 0 ? JSON.parse(rows[0].data) : null
    },

    put(id: string, doc: T): void {
      const data = JSON.stringify(doc)
      const now = Date.now()
      sql.exec(
        `INSERT INTO _collections (collection, id, data, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(collection, id) DO UPDATE SET data = ?, updated_at = ?`,
        name,
        id,
        data,
        now,
        now,
        data,
        now
      )
    },

    delete(id: string): boolean {
      const result = sql.exec(`DELETE FROM _collections WHERE collection = ? AND id = ?`, name, id)
      return result.rowsWritten > 0
    },

    has(id: string): boolean {
      const rows = sql
        .exec<{ c: number }>(`SELECT 1 as c FROM _collections WHERE collection = ? AND id = ?`, name, id)
        .toArray()
      return rows.length > 0
    },

    find(filter?: Filter<T>, options?: QueryOptions): T[] {
      const params: unknown[] = [name]
      let whereClause = 'collection = ?'

      if (filter && Object.keys(filter).length > 0) {
        whereClause += ' AND ' + compileFilter(filter, params)
      }

      let query = `SELECT data FROM _collections WHERE ${whereClause}`

      // Sort
      if (options?.sort) {
        const desc = options.sort.startsWith('-')
        const field = desc ? options.sort.slice(1) : options.sort
        // Validate sort field to prevent SQL injection
        const safeField = validateFieldName(field)
        query += ` ORDER BY json_extract(data, '$.${safeField}') ${desc ? 'DESC' : 'ASC'}`
      } else {
        query += ' ORDER BY updated_at DESC'
      }

      // Pagination
      if (options?.limit) {
        query += ` LIMIT ${Number(options.limit)}`
      }
      if (options?.offset) {
        query += ` OFFSET ${Number(options.offset)}`
      }

      const rows = sql.exec<{ data: string }>(query, ...params).toArray()
      return rows.map((row) => JSON.parse(row.data))
    },

    count(filter?: Filter<T>): number {
      const params: unknown[] = [name]
      let whereClause = 'collection = ?'

      if (filter && Object.keys(filter).length > 0) {
        whereClause += ' AND ' + compileFilter(filter, params)
      }

      const rows = sql
        .exec<{ c: number }>(`SELECT COUNT(*) as c FROM _collections WHERE ${whereClause}`, ...params)
        .toArray()
      return rows[0]?.c ?? 0
    },

    list(options?: QueryOptions): T[] {
      return this.find(undefined, options)
    },

    keys(): string[] {
      const rows = sql
        .exec<{ id: string }>(`SELECT id FROM _collections WHERE collection = ? ORDER BY id`, name)
        .toArray()
      return rows.map((row) => row.id)
    },

    clear(): number {
      const result = sql.exec(`DELETE FROM _collections WHERE collection = ?`, name)
      return result.rowsWritten
    },
  }
}
