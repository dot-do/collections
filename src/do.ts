/**
 * CollectionsDO - Mixin for DOs with typed collections
 *
 * Provides zero-config typed collections via schema definition.
 *
 * @example
 * ```typescript
 * import { DurableObject } from 'cloudflare:workers'
 * import { withCollections } from '@dotdo/collections'
 *
 * interface Schema {
 *   entries: DORegistryEntry
 *   users: User
 * }
 *
 * // Option 1: Factory function
 * const CollectionsDO = withCollections<Schema>(DurableObject)
 *
 * class MyDO extends CollectionsDO {
 *   async fetch() {
 *     // Direct access - fully typed!
 *     this.entries.put('id', entry)
 *     this.collections.users.find({ active: true })
 *   }
 * }
 *
 * // Option 2: Inline
 * class MyDO extends withCollections<Schema>(DurableObject) {
 *   async fetch() {
 *     this.entries.put('id', entry)
 *   }
 * }
 * ```
 */

import type { Collection } from './types'
import { createCollection, initCollectionsSchema } from './collection'

/**
 * Type helper: Maps schema to Collection types
 */
export type CollectionsProxy<Schema> = {
  [K in keyof Schema]: Collection<Schema[K] & Record<string, unknown>>
}

/**
 * Interface for objects that have a ctx with storage.sql
 */
interface HasSqlStorage {
  ctx: {
    storage: {
      sql: SqlStorage
    }
  }
}

/**
 * Create a CollectionsDO base class with typed collections
 *
 * @example
 * ```typescript
 * import { DurableObject } from 'cloudflare:workers'
 * import { withCollections } from '@dotdo/collections'
 *
 * interface Schema {
 *   entries: DORegistryEntry
 *   users: User
 * }
 *
 * class MyDO extends withCollections<Schema>(DurableObject) {
 *   async fetch() {
 *     this.entries.put('id', entry)  // Direct access!
 *     this.collections.users.find({ active: true })
 *   }
 * }
 * ```
 */
export function withCollections<
  Schema extends Record<string, Record<string, unknown>> = Record<string, Record<string, unknown>>
>() {
  // Private state stored per-instance via WeakMap
  const instanceCache = new WeakMap<
    object,
    {
      collections: Map<string, Collection<Record<string, unknown>>>
      initialized: boolean
    }
  >()

  function getState(instance: object) {
    let state = instanceCache.get(instance)
    if (!state) {
      state = { collections: new Map(), initialized: false }
      instanceCache.set(instance, state)
    }
    return state
  }

  function getCollection<T extends Record<string, unknown>>(
    instance: HasSqlStorage,
    name: string
  ): Collection<T> {
    const state = getState(instance)
    let col = state.collections.get(name)
    if (!col) {
      if (!state.initialized) {
        initCollectionsSchema(instance.ctx.storage.sql)
        state.initialized = true
      }
      col = createCollection<T>(instance.ctx.storage.sql, name)
      state.collections.set(name, col)
    }
    return col as Collection<T>
  }

  return function <T extends new (...args: any[]) => HasSqlStorage>(Base: T) {
    const Extended = class extends Base {
      /**
       * Access collections by name
       */
      get collections(): CollectionsProxy<Schema> {
        const self = this
        return new Proxy({} as CollectionsProxy<Schema>, {
          get(_target, prop: string) {
            return getCollection(self, prop)
          },
        })
      }

      constructor(...args: any[]) {
        super(...args)

        // Return a Proxy for direct this.collectionName access
        return new Proxy(this, {
          get(target, prop: string | symbol, receiver) {
            // Handle symbols and private properties normally
            if (typeof prop === 'symbol' || prop.startsWith('_')) {
              return Reflect.get(target, prop, receiver)
            }

            // Check if property exists on instance or prototype
            if (prop in target) {
              return Reflect.get(target, prop, receiver)
            }

            // Treat unknown string properties as collection names
            return getCollection(target, prop)
          },
        })
      }
    }

    return Extended as T & {
      new (...args: any[]): InstanceType<T> & CollectionsProxy<Schema> & {
        collections: CollectionsProxy<Schema>
      }
    }
  }
}

/**
 * Type helper for typing DO instances with collections
 */
export type CollectionsDOInstance<
  Schema extends Record<string, Record<string, unknown>>,
  Base = object
> = Base & CollectionsProxy<Schema> & {
  collections: CollectionsProxy<Schema>
}
