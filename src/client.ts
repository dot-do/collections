/**
 * Collections.do Client SDK
 *
 * Client for accessing the collections.do managed service.
 *
 * @example
 * ```typescript
 * import { Collections } from 'collections.do/client'
 *
 * const collections = new Collections({
 *   baseUrl: 'https://collections.do',
 *   token: 'your-oauth-token', // from oauth.do
 * })
 *
 * // Get user info
 * const me = await collections.me()
 *
 * // Access a namespace and collection
 * const ns = collections.namespace('myapp')
 * const users = ns.collection<User>('users')
 *
 * await users.put('user1', { name: 'Alice' })
 * const user = await users.get('user1')
 * const allUsers = await users.list()
 * ```
 */

import type { AsyncCollection, Filter, AsyncQueryOptions, BulkResult } from '@dotdo/collections/types'

export interface CollectionsConfig {
  /** Base URL of the collections.do service (e.g., https://collections.do) */
  baseUrl?: string
  /** OAuth token for authentication */
  token?: string
  /** Custom fetch function (for testing or custom transports) */
  fetch?: typeof fetch
}

/**
 * Build the namespace URL from base URL and namespace name
 * e.g., https://collections.do + myapp -> https://myapp.collections.do
 */
function buildNamespaceUrl(baseUrl: string, namespace: string): string {
  const url = new URL(baseUrl)
  // Insert namespace as subdomain
  url.hostname = `${namespace}.${url.hostname}`
  return url.origin
}

export interface UserInfo {
  id: string
  email?: string
  name?: string
}

export interface MeResponse {
  user: UserInfo
  defaultNamespace: string
  namespaceUrl: string
}

/**
 * Remote collection client implementing AsyncCollection interface
 */
class RemoteCollection<T extends Record<string, unknown>> implements AsyncCollection<T> {
  private namespaceUrl: string

  constructor(
    public readonly name: string,
    private baseUrl: string,
    private namespace: string,
    private headers: Record<string, string>,
    private fetchFn: typeof fetch
  ) {
    // Build subdomain-based URL: https://myapp.collections.do
    this.namespaceUrl = buildNamespaceUrl(baseUrl, namespace)
  }

  private async request<R>(path: string, options: RequestInit = {}): Promise<R> {
    const url = `${this.namespaceUrl}/${this.name}${path}`
    const response = await this.fetchFn(url, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        ...this.headers,
        ...options.headers,
      },
    })
    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: response.statusText }))
      throw new Error((error as { error: string }).error || 'Request failed')
    }
    return response.json() as Promise<R>
  }

  async get(id: string): Promise<T | null> {
    try {
      const result = await this.request<{ doc: T }>(`/${id}`)
      return result.doc
    } catch {
      return null
    }
  }

  async getMany(ids: string[]): Promise<Array<T | null>> {
    return Promise.all(ids.map((id) => this.get(id)))
  }

  async has(id: string): Promise<boolean> {
    const doc = await this.get(id)
    return doc !== null
  }

  async count(filter?: Filter<T>): Promise<number> {
    if (filter) {
      const result = await this.request<{ count: number }>('/query', {
        method: 'POST',
        body: JSON.stringify({ filter, limit: 0 }),
      })
      return result.count
    }
    const result = await this.request<{ count: number }>('')
    return result.count
  }

  async list(options?: AsyncQueryOptions): Promise<T[]> {
    const params = new URLSearchParams()
    if (options?.limit) params.set('limit', String(options.limit))
    if (options?.offset) params.set('offset', String(options.offset))
    if (options?.sort) {
      const sortStr =
        typeof options.sort === 'string'
          ? options.sort
          : options.sort.map((s) => `${s.order === 'desc' ? '-' : ''}${s.field}`).join(',')
      params.set('sort', sortStr)
    }
    const query = params.toString() ? `?${params}` : ''
    const result = await this.request<{ docs: T[] }>(query)
    return result.docs
  }

  async keys(): Promise<string[]> {
    const result = await this.request<{ docs: Array<{ id: string }> }>('?limit=10000')
    return result.docs.map((d) => d.id)
  }

  async find(filter?: Filter<T>, options?: AsyncQueryOptions): Promise<T[]> {
    const result = await this.request<{ docs: T[] }>('/query', {
      method: 'POST',
      body: JSON.stringify({ filter, ...options }),
    })
    return result.docs
  }

  async query(filter: Filter<T>, options?: AsyncQueryOptions): Promise<T[]> {
    return this.find(filter, options)
  }

  async put(id: string, doc: T): Promise<void> {
    await this.request(`/${id}`, {
      method: 'PUT',
      body: JSON.stringify(doc),
    })
  }

  async putMany(items: Array<{ id: string; doc: T }>): Promise<BulkResult> {
    const result = await this.request<{ count: number }>('/bulk', {
      method: 'POST',
      body: JSON.stringify({ items }),
    })
    return { count: result.count, success: true }
  }

  async delete(id: string): Promise<boolean> {
    try {
      await this.request(`/${id}`, { method: 'DELETE' })
      return true
    } catch {
      return false
    }
  }

  async deleteMany(ids: string[]): Promise<BulkResult> {
    const results = await Promise.all(ids.map((id) => this.delete(id)))
    const count = results.filter(Boolean).length
    return { count, success: true }
  }

  async clear(): Promise<BulkResult> {
    const result = await this.request<{ cleared: number }>('', { method: 'DELETE' })
    return { count: result.cleared, success: true }
  }
}

/**
 * Namespace client for accessing collections within a namespace
 */
class Namespace {
  private namespaceUrl: string

  constructor(
    public readonly name: string,
    private baseUrl: string,
    private headers: Record<string, string>,
    private fetchFn: typeof fetch
  ) {
    // Build subdomain-based URL: https://myapp.collections.do
    this.namespaceUrl = buildNamespaceUrl(baseUrl, name)
  }

  /**
   * Get a typed collection by name
   */
  collection<T extends Record<string, unknown> = Record<string, unknown>>(name: string): AsyncCollection<T> {
    return new RemoteCollection<T>(name, this.baseUrl, this.name, this.headers, this.fetchFn)
  }

  /**
   * List all collections in this namespace
   */
  async listCollections(): Promise<string[]> {
    const response = await this.fetchFn(this.namespaceUrl, { headers: this.headers })
    const result = (await response.json()) as { collections: string[] }
    return result.collections
  }
}

/**
 * Collections.do Client
 *
 * Provides access to the managed collections service.
 */
export class Collections {
  private baseUrl: string
  private headers: Record<string, string>
  private fetchFn: typeof fetch

  constructor(config: CollectionsConfig = {}) {
    this.baseUrl = (config.baseUrl || 'https://collections.do').replace(/\/$/, '')
    this.headers = config.token ? { Authorization: `Bearer ${config.token}` } : {}
    this.fetchFn = config.fetch || globalThis.fetch.bind(globalThis)
  }

  /**
   * Get current user info and default namespace
   */
  async me(): Promise<MeResponse> {
    const url = `${this.baseUrl}/me`
    const response = await this.fetchFn(url, { headers: this.headers })
    if (!response.ok) {
      throw new Error('Authentication required')
    }
    return response.json() as Promise<MeResponse>
  }

  /**
   * Get a namespace by name
   *
   * @param name - The namespace name (defaults to user's default namespace)
   */
  namespace(name: string): Namespace {
    return new Namespace(name, this.baseUrl, this.headers, this.fetchFn)
  }

  /**
   * Shortcut to get a collection in the default namespace
   * You should call me() first to get your default namespace
   */
  collection<T extends Record<string, unknown> = Record<string, unknown>>(
    namespace: string,
    collection: string
  ): AsyncCollection<T> {
    return this.namespace(namespace).collection<T>(collection)
  }
}

export default Collections
