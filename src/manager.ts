/**
 * Collections Manager
 *
 * Manage multiple collections with a single SqlStorage instance
 */

import type { Collection } from './types'
import { createCollection, initCollectionsSchema } from './collection'

/**
 * Manage multiple collections
 *
 * @example
 * ```typescript
 * const collections = new Collections(ctx.storage.sql)
 *
 * const users = collections.collection<User>('users')
 * const products = collections.collection<Product>('products')
 *
 * // Get all collection names
 * const names = collections.names()
 *
 * // Get stats for all collections
 * const stats = collections.stats()
 *
 * // Drop a collection
 * collections.drop('temp')
 * ```
 */
export class Collections {
  private sql: SqlStorage
  private cache = new Map<string, Collection<any>>()
  private schemaInitialized = false

  constructor(sql: SqlStorage) {
    this.sql = sql
  }

  /**
   * Ensure schema is initialized
   */
  private ensureSchema(): void {
    if (!this.schemaInitialized) {
      initCollectionsSchema(this.sql)
      this.schemaInitialized = true
    }
  }

  /**
   * Get or create a collection
   *
   * @param name - The collection name
   * @returns A Collection interface for the specified collection
   */
  collection<T extends Record<string, unknown> = Record<string, unknown>>(name: string): Collection<T> {
    let col = this.cache.get(name)
    if (!col) {
      col = createCollection<T>(this.sql, name)
      this.cache.set(name, col)
    }
    return col as Collection<T>
  }

  /**
   * List all collection names
   *
   * @returns Array of collection names
   */
  names(): string[] {
    this.ensureSchema()
    const rows = this.sql
      .exec<{ collection: string }>(`SELECT DISTINCT collection FROM _collections ORDER BY collection`)
      .toArray()
    return rows.map((row) => row.collection)
  }

  /**
   * Drop a collection
   *
   * @param name - The collection name to drop
   * @returns Number of documents deleted
   */
  drop(name: string): number {
    this.cache.delete(name)
    this.ensureSchema()
    const result = this.sql.exec(`DELETE FROM _collections WHERE collection = ?`, name)
    return result.rowsWritten
  }

  /**
   * Get stats for all collections
   *
   * @returns Array of collection statistics
   */
  stats(): Array<{ name: string; count: number; size: number }> {
    this.ensureSchema()
    const rows = this.sql
      .exec<{ collection: string; count: number; size: number }>(
        `SELECT collection, COUNT(*) as count, SUM(LENGTH(data)) as size
         FROM _collections GROUP BY collection ORDER BY collection`
      )
      .toArray()
    return rows.map((row) => ({
      name: row.collection,
      count: row.count,
      size: row.size,
    }))
  }
}
