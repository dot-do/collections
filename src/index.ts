/**
 * collections.do - Managed Document Collections Service
 *
 * A managed service for MongoDB-style document collections on Cloudflare Durable Objects.
 * Provides user-specific collections with authentication via oauth.do.
 *
 * @example Client usage
 * ```typescript
 * import { Collections } from 'collections.do/client'
 *
 * const collections = new Collections({
 *   baseUrl: 'https://collections.do',
 *   token: 'your-oauth-token', // from oauth.do
 * })
 *
 * // Access a namespace and collection
 * // Namespace is accessed via subdomain: https://myapp.collections.do
 * const users = collections.namespace('myapp').collection<User>('users')
 * await users.put('user1', { name: 'Alice', email: 'alice@example.com' })
 * const user = await users.get('user1')
 * ```
 *
 * ## API Endpoints
 *
 * Root domain (collections.do):
 * - `GET /` - API info (public)
 * - `GET /me` - Your user info and namespaces (authenticated)
 *
 * Namespace subdomain (<namespace>.collections.do):
 * - `GET /` - List collections in namespace
 * - `GET /:collection` - List documents
 * - `GET /:collection/:id` - Get document
 * - `PUT /:collection/:id` - Create/update document
 * - `DELETE /:collection/:id` - Delete document
 * - `POST /:collection/query` - Query with filter
 * - `POST /:collection/bulk` - Bulk operations
 * - `DELETE /:collection` - Clear collection
 *
 * @packageDocumentation
 */

export { CollectionsDO } from './do'
export type { Env } from './do'

// Re-export core types for convenience
export type {
  SyncCollection,
  AsyncCollection,
  SyncReadCollection,
  SyncWriteCollection,
  AsyncReadCollection,
  AsyncWriteCollection,
  Filter,
  SyncQueryOptions,
  AsyncQueryOptions,
} from '@dotdo/collections/types'
