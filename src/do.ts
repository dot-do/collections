/**
 * CollectionsDO - Managed Collections Durable Object
 *
 * Provides user-specific document collections with:
 * - Authentication via AUTH service binding
 * - Per-user DO namespaces
 * - Custom subdomains at *.collections.do
 * - Workers RPC for direct method calls from other workers
 */

import { DurableObject, WorkerEntrypoint } from 'cloudflare:workers'
import { Hono } from 'hono'
import type { Context } from 'hono'
import { cors } from 'hono/cors'
import { createCollection, initCollectionsSchema, MAX_LIMIT } from '@dotdo/collections'
import type { SyncCollection } from '@dotdo/collections/types'
import type { AuthUser } from './types'

// Maximum request body size (1MB)
const MAX_BODY_SIZE = 1024 * 1024

export interface Env {
  COLLECTIONS: DurableObjectNamespace<CollectionsDO>
  AUTH: Fetcher  // Service binding to auth worker
  OAUTH: Fetcher // Service binding to oauth worker
  MCP: Fetcher   // Service binding to mcp worker
}

/**
 * Type-safe Hono context for Collections routes
 */
type CollectionsContext = Context<{
  Bindings: Env
  Variables: { user: AuthUser | null; newCookies?: string[] }
}>

/**
 * Managed Collections Durable Object
 */
export class CollectionsDO extends DurableObject<Env> {
  private sql: SqlStorage
  private collections = new Map<string, SyncCollection<Record<string, unknown>>>()
  private _doName: string | null = null

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    this.sql = ctx.storage.sql
    try {
      initCollectionsSchema(this.sql)
      // Create metadata table for DO identity
      this.sql.exec(`CREATE TABLE IF NOT EXISTS _do_metadata (key TEXT PRIMARY KEY, value TEXT)`)
      // Load stored DO name
      const row = this.sql.exec<{ value: string }>(`SELECT value FROM _do_metadata WHERE key = 'doName'`).toArray()[0]
      if (row) this._doName = row.value
    } catch (e) {
      console.error('Failed to initialize schema:', e)
    }
  }

  private getCollection<T extends Record<string, unknown>>(name: string): SyncCollection<T> {
    let col = this.collections.get(name)
    if (!col) {
      col = createCollection<T>(this.sql, name)
      this.collections.set(name, col as SyncCollection<Record<string, unknown>>)
    }
    return col as SyncCollection<T>
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // RPC Methods - Direct access without HTTP overhead
  // ═══════════════════════════════════════════════════════════════════════════

  /** Get or set the DO's name for identification */
  setName(name: string): void {
    if (!this._doName) {
      this._doName = name
      this.sql.exec(`INSERT OR REPLACE INTO _do_metadata (key, value) VALUES ('doName', ?)`, name)
    }
  }

  getName(): string | null {
    return this._doName
  }

  /** Get DO info including all collections */
  getInfo(): { doName: string | null; collections: string[] } {
    const rows = this.sql
      .exec<{ collection: string }>('SELECT DISTINCT collection FROM _collections ORDER BY collection')
      .toArray()
    return {
      doName: this._doName,
      collections: rows.map(r => r.collection),
    }
  }

  /** Get a document */
  getDoc(collection: string, id: string): Record<string, unknown> | null {
    return this.getCollection(collection).get(id) || null
  }

  /** Put a document */
  putDoc(collection: string, id: string, doc: Record<string, unknown>): Record<string, unknown> {
    this.getCollection(collection).put(id, doc)
    return { id, ...doc }
  }

  /** Delete a document */
  deleteDoc(collection: string, id: string): boolean {
    return this.getCollection(collection).delete(id)
  }

  /** List documents in a collection */
  listDocs(collection: string, options?: { limit?: number; offset?: number }): Record<string, unknown>[] {
    return this.getCollection(collection).list(options || {})
  }

  /** Find documents with filter */
  findDocs(collection: string, filter?: Record<string, unknown>, options?: { limit?: number; offset?: number }): Record<string, unknown>[] {
    return this.getCollection(collection).find(filter, options)
  }

  /** Count documents */
  countDocs(collection: string, filter?: Record<string, unknown>): number {
    return this.getCollection(collection).count(filter)
  }

  /** Clear a collection */
  clearCollection(collection: string): number {
    return this.getCollection(collection).clear()
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // HTTP fetch handler (for backwards compatibility / direct browser access)
  // ═══════════════════════════════════════════════════════════════════════════

  /** Default pagination limit when not specified */
  private static readonly DEFAULT_LIMIT = 100

  /**
   * Validate pagination query parameters from URL search params
   * Returns validated { limit, offset } or a 400 error Response
   */
  private validatePagination(url: URL): { limit: number; offset: number } | Response {
    const limitStr = url.searchParams.get('limit')
    const offsetStr = url.searchParams.get('offset')

    const limit = limitStr ? parseInt(limitStr, 10) : CollectionsDO.DEFAULT_LIMIT
    const offset = offsetStr ? parseInt(offsetStr, 10) : 0

    if (isNaN(limit) || limit < 1 || limit > MAX_LIMIT) {
      return Response.json({ error: `limit must be a positive integer between 1 and ${MAX_LIMIT}` }, { status: 400 })
    }

    if (isNaN(offset) || offset < 0) {
      return Response.json({ error: 'offset must be a non-negative integer' }, { status: 400 })
    }

    return { limit, offset }
  }

  /**
   * Parse JSON body from request with error handling
   * Returns parsed body, 413 for too large, or 400 for invalid JSON
   */
  private async parseJsonBody<T>(request: Request): Promise<T | Response> {
    const contentLength = parseInt(request.headers.get('content-length') || '0', 10)
    if (contentLength > MAX_BODY_SIZE) {
      return Response.json({ error: 'Request body too large' }, { status: 413 })
    }
    try {
      return await request.json() as T
    } catch {
      return Response.json({ error: 'Invalid JSON body' }, { status: 400 })
    }
  }

  /**
   * Validate pagination parameters from request body
   * Returns validated { limit, offset } or a 400 error Response
   */
  private validateBodyPagination(limit?: unknown, offset?: unknown): { limit?: number; offset?: number } | Response {
    const options: { limit?: number; offset?: number } = {}

    if (limit !== undefined) {
      if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
        return Response.json({ error: `limit must be a positive integer between 1 and ${MAX_LIMIT}` }, { status: 400 })
      }
      options.limit = limit
    }

    if (offset !== undefined) {
      if (typeof offset !== 'number' || !Number.isInteger(offset) || offset < 0) {
        return Response.json({ error: 'offset must be a non-negative integer' }, { status: 400 })
      }
      options.offset = offset
    }

    return options
  }

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    const path = url.pathname
    const method = request.method
    const namespace = request.headers.get('X-Namespace') || 'unknown'
    const doName = request.headers.get('X-DO-Name')
    // Use explicit base URL if provided, otherwise build from namespace
    const baseUrl = request.headers.get('X-Base-Url') || `https://${namespace}.collections.do`

    // Save DO name if provided and not yet set
    if (doName && !this._doName) {
      this.setName(doName)
    }

    // Route: GET /
    if (path === '/' && method === 'GET') {
      const info = this.getInfo()
      return Response.json({
        $id: baseUrl,
        doName: info.doName,
        namespace,
        collections: info.collections.map(name => ({ $id: `${baseUrl}/${name}`, name })),
      })
    }

    // Route: GET /:collection
    const collectionMatch = path.match(/^\/([^/]+)$/)
    if (collectionMatch && method === 'GET') {
      const collection = collectionMatch[1]!

      // Validate pagination parameters
      const pagination = this.validatePagination(url)
      if (pagination instanceof Response) return pagination
      const { limit, offset } = pagination

      const docs = this.listDocs(collection, { limit, offset })
      return Response.json({
        $id: `${baseUrl}/${collection}`,
        collection,
        count: this.countDocs(collection),
        // Ensure each doc has 'id' field - extract from doc or use the id property
        docs: docs.map(doc => {
          const docId = (doc as { id?: string }).id
          return { $id: `${baseUrl}/${collection}/${docId}`, ...doc }
        }),
      })
    }

    // Route: GET /:collection/:id
    const docMatch = path.match(/^\/([^/]+)\/([^/]+)$/)
    if (docMatch && method === 'GET') {
      const [, collection, id] = docMatch
      const doc = this.getDoc(collection!, id!)
      if (!doc) return Response.json({ error: 'Not found' }, { status: 404 })
      return Response.json({ $id: `${baseUrl}/${collection}/${id}`, id, ...doc })
    }

    // Route: PUT /:collection/:id
    if (docMatch && method === 'PUT') {
      const [, collection, id] = docMatch
      const parsed = await this.parseJsonBody<Record<string, unknown>>(request)
      if (parsed instanceof Response) return parsed
      const doc = parsed
      if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
        return Response.json({ error: 'Body must be a JSON object' }, { status: 400 })
      }
      const result = this.putDoc(collection!, id!, doc)
      return Response.json(result, { status: 201 })
    }

    // Route: DELETE /:collection/:id
    if (docMatch && method === 'DELETE') {
      const [, collection, id] = docMatch
      const deleted = this.deleteDoc(collection!, id!)
      if (!deleted) return Response.json({ error: 'Not found' }, { status: 404 })
      return Response.json({ deleted: true })
    }

    // Route: PATCH /:collection/:id
    if (docMatch && method === 'PATCH') {
      const [, collection, id] = docMatch
      const parsed = await this.parseJsonBody<Record<string, unknown>>(request)
      if (parsed instanceof Response) return parsed
      const patch = parsed
      if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
        return Response.json({ error: 'Body must be a JSON object' }, { status: 400 })
      }
      // Fetch existing document
      const existing = this.getDoc(collection!, id!)
      if (!existing) return Response.json({ error: 'Not found' }, { status: 404 })
      // Shallow merge: existing fields + patch fields
      const merged = { ...existing, ...patch }
      // Save the merged document
      this.putDoc(collection!, id!, merged)
      return Response.json({ $id: `${baseUrl}/${collection}/${id}`, id, ...merged })
    }

    // Route: POST /:collection/query
    const queryMatch = path.match(/^\/([^/]+)\/query$/)
    if (queryMatch && method === 'POST') {
      const collection = queryMatch[1]!
      const parsed = await this.parseJsonBody<{ filter?: Record<string, unknown>; limit?: unknown; offset?: unknown }>(request)
      if (parsed instanceof Response) return parsed
      const body = parsed

      // Validate body pagination parameters
      const bodyPagination = this.validateBodyPagination(body.limit, body.offset)
      if (bodyPagination instanceof Response) return bodyPagination

      const docs = this.findDocs(collection, body.filter, bodyPagination)
      return Response.json({ collection, count: docs.length, docs })
    }

    // Route: DELETE /:collection
    if (collectionMatch && method === 'DELETE') {
      const collection = collectionMatch[1]!
      const cleared = this.clearCollection(collection)
      return Response.json({ cleared })
    }

    return Response.json({ error: 'Not found' }, { status: 404 })
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Helper functions
// ═══════════════════════════════════════════════════════════════════════════

// Base62 alphabet: 0-9, A-Z, a-z
const BASE62_ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'

/**
 * Encode a hex string to base62
 */
function hexToBase62(hex: string): string {
  // Convert hex to BigInt
  const num = BigInt('0x' + hex)
  if (num === 0n) return '0'

  let result = ''
  let n = num
  while (n > 0n) {
    result = BASE62_ALPHABET[Number(n % 62n)] + result
    n = n / 62n
  }
  return result
}

/**
 * Decode a base62 string to hex
 */
function base62ToHex(base62: string): string {
  let num = 0n
  for (const char of base62) {
    const idx = BASE62_ALPHABET.indexOf(char)
    if (idx === -1) throw new Error(`Invalid base62 character: ${char}`)
    num = num * 62n + BigInt(idx)
  }
  // Convert to hex, pad to 64 chars
  return num.toString(16).padStart(64, '0')
}

/**
 * Check if string is valid base62 (43 chars, alphanumeric)
 */
function isBase62Id(str: string): boolean {
  return /^[0-9A-Za-z]{42,44}$/.test(str)
}

function getCookieDomain(host: string): string | undefined {
  const hostname = host.split(':')[0] || ''
  if (hostname === 'localhost' || /^\d+\.\d+\.\d+\.\d+$/.test(hostname)) return undefined
  const parts = hostname.split('.')
  return parts.length >= 2 ? '.' + parts.slice(-2).join('.') : undefined
}

function getNamespaceFromHost(host: string): string | null {
  const hostname = host.split(':')[0] || ''
  const rootDomain = getCookieDomain(host)
  if (rootDomain && hostname.endsWith(rootDomain)) {
    const subdomain = hostname.slice(0, -rootDomain.length)
    if (subdomain && subdomain !== 'www') return subdomain
  }
  return null
}

// ═══════════════════════════════════════════════════════════════════════════
// API Key Cache - Import from separate module for testability
// ═══════════════════════════════════════════════════════════════════════════

import {
  apiKeyCache,
  API_KEY_CACHE_TTL,
  hashApiKey,
  setApiKeyCacheEntry,
  cleanupExpiredEntries,
} from './cache'

// ═══════════════════════════════════════════════════════════════════════════
// Worker entry point
// ═══════════════════════════════════════════════════════════════════════════

const app = new Hono<{ Bindings: Env; Variables: { user: AuthUser | null; newCookies?: string[] } }>()

app.use('*', cors())

// Health check endpoint - no authentication required
app.get('/health', (c) => c.json({ status: 'ok' }))

// Helper to extract cookie value
function getCookie(cookies: string | null | undefined, name: string): string | null {
  if (!cookies) return null
  const match = cookies.match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`))
  return match ? match[1]! : null
}

// Helper to check if a token looks like a valid JWT
function isValidJwtFormat(token: string | null): boolean {
  if (!token) return false
  const parts = token.split('.')
  return parts.length === 3 && parts.every(p => p.length > 0)
}

// Auth middleware - uses AUTH service binding with silent refresh
// Also supports API key auth via Authorization: Bearer header
app.use('/*', async (c, next) => {
  const path = c.req.path

  // Skip auth for auth/OAuth/MCP routes and health check
  const publicPaths = ['/health', '/login', '/logout', '/callback', '/authorize', '/token', '/introspect', '/revoke', '/register']
  const wellKnownPaths = ['/.well-known/oauth-authorization-server', '/.well-known/oauth-protected-resource', '/.well-known/jwks.json', '/.well-known/openid-configuration']
  if (publicPaths.includes(path) || wellKnownPaths.includes(path) || path.startsWith('/mcp')) {
    return next()
  }

  // Check for API key in Authorization header (Bearer token starting with sk_)
  const authHeader = c.req.header('Authorization')
  if (authHeader?.startsWith('Bearer sk_')) {
    const apiKey = authHeader.slice(7) // Remove 'Bearer '

    // Clean up expired entries (do this probabilistically, not every request)
    if (Math.random() < 0.01) {
      // 1% of requests trigger cleanup
      cleanupExpiredEntries()
    }

    // Hash the API key for cache lookup
    const keyHash = await hashApiKey(apiKey)

    // Check cache first
    const cached = apiKeyCache.get(keyHash)
    if (cached && cached.expiresAt > Date.now()) {
      // Cache hit - use cached user
      c.set('user', cached.user)
      return next()
    }

    // Cache miss - validate via oauth.do
    const validateResponse = await c.env.OAUTH.fetch(new Request('https://oauth.do/validate-api-key', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ value: apiKey }),
    }))

    if (validateResponse.ok) {
      const validation = await validateResponse.json() as {
        valid: boolean
        id?: string
        name?: string
        organization_id?: string
        permissions?: string[]
        error?: string
      }

      if (validation.valid) {
        // API key is valid - build user object
        const user: AuthUser = {
          id: validation.id || `api:${apiKey.slice(0, 16)}`,
          name: validation.name || 'API Key User',
          roles: ['api'],
          permissions: validation.permissions || [],
          ...(validation.organization_id && { org: validation.organization_id }),
        }

        // Cache the validated key
        setApiKeyCacheEntry(keyHash, {
          user,
          expiresAt: Date.now() + API_KEY_CACHE_TTL,
        })

        c.set('user', user)
        return next()
      }
    }

    // API key validation failed - remove from cache if present
    apiKeyCache.delete(keyHash)
    return c.json({ error: 'Invalid API key' }, 401)
  }

  // Check for JWT in Authorization header (Bearer token that's NOT an API key)
  if (authHeader?.startsWith('Bearer ') && !authHeader.startsWith('Bearer sk_')) {
    const token = authHeader.slice(7) // Remove 'Bearer '

    // Validate JWT looks correct
    if (isValidJwtFormat(token)) {
      // Verify JWT via AUTH service (lightweight, handles JWKS caching)
      const response = await c.env.AUTH.fetch(new Request('https://auth/user', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          request: {
            url: c.req.url,
            headers: { 'Authorization': authHeader },
          },
        }),
      }))

      if (response.ok) {
        const { user } = await response.json() as { user: AuthUser | null }

        if (user) {
          c.set('user', user)
          return next()
        }
      }
    }

    // JWT validation failed
    return c.json({ error: 'Invalid token' }, 401)
  }

  // Check for invalid auth cookie and clear it
  const cookies = c.req.header('Cookie')
  const authCookie = getCookie(cookies, 'auth')
  if (authCookie && !isValidJwtFormat(authCookie)) {
    console.error('Invalid auth cookie detected, clearing:', authCookie?.substring(0, 20))
    // Clear the invalid cookie and redirect to login
    const domain = getCookieDomain(c.req.header('host') || '')
    const cookieBase = ['HttpOnly', 'Secure', 'SameSite=Lax', 'Max-Age=0', 'Path=/']
    if (domain) cookieBase.push(`Domain=${domain}`)

    const accept = c.req.header('Accept') || ''
    if (accept.includes('text/html')) {
      const headers = new Headers({ 'Location': `/login?returnTo=${encodeURIComponent(c.req.url)}` })
      headers.append('Set-Cookie', ['auth=', ...cookieBase].join('; '))
      headers.append('Set-Cookie', ['refresh=', ...cookieBase].join('; '))
      return new Response(null, { status: 302, headers })
    }
    // For API requests, just clear cookie and return 401
    const headers = new Headers({ 'Content-Type': 'application/json' })
    headers.append('Set-Cookie', ['auth=', ...cookieBase].join('; '))
    headers.append('Set-Cookie', ['refresh=', ...cookieBase].join('; '))
    return new Response(JSON.stringify({ error: 'Invalid token, please re-authenticate' }), { status: 401, headers })
  }

  // Call AUTH service to verify JWT
  const response = await c.env.AUTH.fetch(new Request('https://auth/user', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      request: {
        url: c.req.url,
        headers: Object.fromEntries(c.req.raw.headers.entries()),
      },
    }),
  }))

  const { user } = await response.json() as { user: AuthUser | null }

  if (user) {
    c.set('user', user)
    return next()
  }

  // JWT verification failed - try silent refresh with refresh token
  const refreshToken = getCookie(cookies, 'refresh')

  if (refreshToken) {
    try {
      // Call token endpoint with refresh_token grant
      const refreshResponse = await c.env.OAUTH.fetch(new Request('https://oauth.do/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: refreshToken,
          client_id: 'first-party',
        }).toString(),
      }))

      if (refreshResponse.ok) {
        const tokens = await refreshResponse.json() as {
          access_token: string
          refresh_token?: string
          expires_in: number
        }

        // Verify the new token
        const verifyResponse = await c.env.AUTH.fetch(new Request('https://auth/user', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            request: {
              url: c.req.url,
              headers: { ...Object.fromEntries(c.req.raw.headers.entries()), 'Cookie': `auth=${tokens.access_token}` },
            },
          }),
        }))

        const { user: refreshedUser } = await verifyResponse.json() as { user: AuthUser | null }

        if (refreshedUser) {
          c.set('user', refreshedUser)

          // Set new tokens in cookie via response header
          const domain = getCookieDomain(c.req.header('host') || '')
          const cookieBase = ['HttpOnly', 'Secure', 'SameSite=Lax', 'Path=/']
          if (domain) cookieBase.push(`Domain=${domain}`)

          // Cookie max-age of 365 days is intentional per product decision
          // to provide persistent sessions for improved user experience
          const newCookies = [
            [`auth=${tokens.access_token}`, `Max-Age=${365 * 24 * 60 * 60}`, ...cookieBase].join('; '),
          ]
          if (tokens.refresh_token) {
            newCookies.push([`refresh=${tokens.refresh_token}`, `Max-Age=${365 * 24 * 60 * 60}`, ...cookieBase].join('; '))
          }

          // Store cookies to set in response
          c.set('newCookies', newCookies)

          return next()
        }
      }
    } catch (e) {
      console.error('Silent refresh failed:', e)
    }
  }

  // Not authenticated and refresh failed
  const accept = c.req.header('Accept') || ''
  if (accept.includes('text/html')) {
    return c.redirect(`/login?returnTo=${encodeURIComponent(c.req.url)}`)
  }
  return c.json({ error: 'Authentication required' }, 401)
})

// Middleware to set refreshed cookies on response
app.use('/*', async (c, next) => {
  await next()

  // If we refreshed tokens, add Set-Cookie headers to response
  const newCookies = c.get('newCookies')
  if (newCookies && newCookies.length > 0) {
    const response = c.res
    newCookies.forEach(cookie => response.headers.append('Set-Cookie', cookie))
  }
})

// ═══════════════════════════════════════════════════════════════════════════
// MCP OAuth 2.1 endpoints - proxy to OAuth worker with dynamic issuer
// ═══════════════════════════════════════════════════════════════════════════

function getIssuer(c: CollectionsContext): string {
  const host = c.req.header('host') || 'collections.do'
  const protocol = c.req.header('x-forwarded-proto') || 'https'
  return `${protocol}://${host.split(':')[0]}`
}

// OAuth 2.1 Authorization Server Metadata (RFC 8414)
app.get('/.well-known/oauth-authorization-server', async (c) => {
  const issuer = getIssuer(c)
  return c.env.OAUTH.fetch(new Request('https://oauth.do/.well-known/oauth-authorization-server', {
    headers: { 'X-Issuer': issuer },
  }))
})

// OAuth Protected Resource Metadata
app.get('/.well-known/oauth-protected-resource', async (c) => {
  const issuer = getIssuer(c)
  return c.env.OAUTH.fetch(new Request('https://oauth.do/.well-known/oauth-protected-resource', {
    headers: { 'X-Issuer': issuer },
  }))
})

// JWKS endpoint for JWT verification
app.get('/.well-known/jwks.json', async (c) => {
  return c.env.OAUTH.fetch(new Request('https://oauth.do/.well-known/jwks.json'))
})

// OpenID Connect discovery (alias)
app.get('/.well-known/openid-configuration', async (c) => {
  const issuer = getIssuer(c)
  return c.env.OAUTH.fetch(new Request('https://oauth.do/.well-known/oauth-authorization-server', {
    headers: { 'X-Issuer': issuer },
  }))
})

// Authorization endpoint
app.get('/authorize', async (c) => {
  const issuer = getIssuer(c)
  const url = new URL(c.req.url)
  const oauthUrl = new URL('/authorize' + url.search, 'https://oauth.do')

  return c.env.OAUTH.fetch(new Request(oauthUrl.toString(), {
    headers: {
      'X-Issuer': issuer,
      'Accept': c.req.header('Accept') || '*/*',
    },
    redirect: 'manual',
  }))
})

// Token endpoint
app.post('/token', async (c) => {
  const issuer = getIssuer(c)
  const body = await c.req.text()

  return c.env.OAUTH.fetch(new Request('https://oauth.do/token', {
    method: 'POST',
    headers: {
      'X-Issuer': issuer,
      'Content-Type': c.req.header('Content-Type') || 'application/x-www-form-urlencoded',
    },
    body,
  }))
})

// Token introspection endpoint (RFC 7662)
app.post('/introspect', async (c) => {
  return c.env.OAUTH.fetch(c.req.raw)
})

// Token revocation endpoint (RFC 7009)
app.post('/revoke', async (c) => {
  return c.env.OAUTH.fetch(c.req.raw)
})

// Dynamic client registration endpoint (RFC 7591)
app.post('/register', async (c) => {
  return c.env.OAUTH.fetch(c.req.raw)
})

// ═══════════════════════════════════════════════════════════════════════════
// MCP endpoint - proxy to MCP worker with dynamic issuer
// ═══════════════════════════════════════════════════════════════════════════

// MCP HTTP endpoint for Model Context Protocol (JSON-RPC over HTTP)
app.all('/mcp', async (c) => {
  const issuer = getIssuer(c)
  const url = new URL(c.req.url)

  const mcpUrl = new URL('/mcp' + url.search, 'https://mcp.do')

  // Forward the request to mcp.do with issuer header
  return c.env.MCP.fetch(new Request(mcpUrl.toString(), {
    method: c.req.method,
    headers: new Headers([
      ...c.req.raw.headers.entries(),
      ['X-Issuer', issuer],
      ['X-Forwarded-Host', url.host],
    ]),
    body: c.req.raw.body,
  }))
})

// ═══════════════════════════════════════════════════════════════════════════
// Auth routes - proxy to OAuth worker
// ═══════════════════════════════════════════════════════════════════════════

app.get('/login', async (c) => {
  const url = new URL(c.req.url)
  const issuer = getIssuer(c)
  const oauthUrl = new URL('/login', 'https://oauth.do')

  // Get the returnTo destination - default to root, never /login itself
  let returnTo = c.req.query('returnTo') || '/'
  if (returnTo === '/login' || returnTo.startsWith('/login?')) {
    returnTo = '/'
  }

  // Build the full returnTo URL for oauth.do
  const returnToUrl = new URL(returnTo, url.origin)
  oauthUrl.searchParams.set('returnTo', returnToUrl.toString())

  // Use redirect: 'manual' to prevent following redirects within service binding
  return c.env.OAUTH.fetch(new Request(oauthUrl.toString(), {
    headers: {
      'X-Issuer': issuer,
      'Accept': c.req.header('Accept') || '*/*',
    },
    redirect: 'manual',
  }))
})

app.get('/logout', (c) => {
  const domain = getCookieDomain(c.req.header('host') || '')
  const cookieBase = ['HttpOnly', 'Secure', 'SameSite=Lax', 'Max-Age=0', 'Path=/']
  if (domain) cookieBase.push(`Domain=${domain}`)

  // Clear both auth and refresh cookies
  const headers = new Headers({ 'Location': c.req.query('returnTo') || '/' })
  headers.append('Set-Cookie', ['auth=', ...cookieBase].join('; '))
  headers.append('Set-Cookie', ['refresh=', ...cookieBase].join('; '))

  return new Response(null, { status: 302, headers })
})

app.get('/callback', async (c) => {
  const code = c.req.query('code')
  const returnTo = c.req.query('returnTo') || '/'
  const error = c.req.query('error')

  if (error) return c.json({ error, error_description: c.req.query('error_description') }, 400)
  if (!code) return c.json({ error: 'invalid_request', error_description: 'Missing code' }, 400)

  const response = await c.env.OAUTH.fetch(new Request('https://oauth.do/exchange', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code }),
  }))

  if (!response.ok) {
    const err = await response.json() as { error: string }
    return c.json(err, response.status as 400)
  }

  const data = await response.json() as {
    access_token?: string
    token?: string  // oauth.do returns 'token' not 'access_token'
    refresh_token?: string
    error?: string
    error_description?: string
  }

  // Check for error response
  if (data.error) {
    console.error('oauth.do/exchange error:', data.error, data.error_description)
    return c.json({ error: data.error, error_description: data.error_description }, 400)
  }

  // oauth.do returns 'token', standard OAuth returns 'access_token' - accept both
  const access_token = data.access_token || data.token
  if (!access_token || !access_token.includes('.') || access_token.split('.').length !== 3) {
    console.error('Invalid access_token from oauth.do/exchange:', access_token?.substring(0, 50))
    return c.json({ error: 'invalid_token', error_description: 'Invalid access token received' }, 500)
  }

  const refresh_token = data.refresh_token

  // Build cookies - access token and refresh token separately
  const domain = getCookieDomain(c.req.header('host') || '')
  const cookieBase = ['HttpOnly', 'Secure', 'SameSite=Lax', 'Path=/']
  if (domain) cookieBase.push(`Domain=${domain}`)

  // Cookie max-age of 365 days is intentional per product decision
  // to provide persistent sessions for improved user experience
  const cookies = [
    [`auth=${access_token}`, `Max-Age=${365 * 24 * 60 * 60}`, ...cookieBase].join('; '),
  ]
  if (refresh_token) {
    cookies.push([`refresh=${refresh_token}`, `Max-Age=${365 * 24 * 60 * 60}`, ...cookieBase].join('; '))
  }

  // Return redirect with Set-Cookie headers
  const headers = new Headers({ 'Location': returnTo })
  cookies.forEach(cookie => headers.append('Set-Cookie', cookie))

  return new Response(null, { status: 302, headers })
})

// ═══════════════════════════════════════════════════════════════════════════
// API routes
// ═══════════════════════════════════════════════════════════════════════════

app.get('/', async (c) => {
  const namespace = getNamespaceFromHost(c.req.header('host') || '')
  if (namespace) {
    return forwardToNamespace(c, namespace, '/')
  }

  // Root domain - show user's namespaces
  const user = c.var.user
  if (!user) {
    return c.json({
      name: 'collections.do',
      description: 'Managed document collections service',
      login: '/login',
    })
  }

  // Build namespace URLs
  const host = c.req.header('host') || 'collections.do'
  const protocol = c.req.header('x-forwarded-proto') || 'https'
  const rootDomain = getCookieDomain(host) || `.${host}`
  const baseUrl = `${protocol}://${host}`

  // Get DO stubs
  const indexDoName = `index:${user.id}`
  const indexStub = c.env.COLLECTIONS.get(c.env.COLLECTIONS.idFromName(indexDoName))

  const defaultDoName = `${user.id}:default`
  const defaultDoId = c.env.COLLECTIONS.idFromName(defaultDoName)
  const defaultStub = c.env.COLLECTIONS.get(defaultDoId)

  // Fetch in PARALLEL
  const [namespaceDocs, defaultInfo] = await Promise.all([
    indexStub.listDocs('_namespaces') as Promise<Array<{ id: string; namespace?: string }>>,
    defaultStub.getInfo(),
  ])

  const namespaces = namespaceDocs.map((d: { id: string }) => d.id).filter(Boolean)

  return c.json({
    name: 'collections.do',
    user: { id: user.id, email: user.email, name: user.name },
    namespaces: namespaces.map(ns => ({
      name: ns,
      url: `${protocol}://${ns}${rootDomain}`,
    })),
    defaultNamespace: {
      doName: defaultDoName,
      doId: defaultDoId.toString(),
      url: `${protocol}://default${rootDomain}`,
      collections: defaultInfo.collections.map(name => ({
        name,
        url: `${protocol}://default${rootDomain}/${name}`,
      })),
    },
  })
})

app.get('/me', (c) => {
  const user = c.var.user!
  return c.json({
    user: { id: user.id, email: user.email, name: user.name, image: user.image },
  })
})

// Direct DO access by object ID: /_do/:objectId or /_do/:objectId/:collection...
// Accepts both hex (64 chars) and base62 (42-44 chars) formats
app.all('/_do/:objectId/*', async (c) => {
  const objectIdParam = c.req.param('objectId')

  const hexId = parseObjectId(objectIdParam)
  if (!hexId) {
    return c.json({ error: 'Invalid object ID - must be 64 hex chars or 42-44 base62 chars' }, 400)
  }

  const doId = c.env.COLLECTIONS.idFromString(hexId)
  const stub = c.env.COLLECTIONS.get(doId)

  // Get the path after /_do/:objectId
  const fullPath = new URL(c.req.url).pathname
  const path = fullPath.replace(`/_do/${objectIdParam}`, '') || '/'

  const reqUrl = new URL(c.req.url)
  const url = new URL(path, c.req.url)
  url.search = reqUrl.search

  // Build the proper base URL using base62 for shorter URLs
  const protocol = c.req.header('x-forwarded-proto') || 'https'
  const host = c.req.header('host') || 'collections.do'
  const base62Id = hexToBase62(hexId)
  const baseUrl = `${protocol}://${host}/_do/${base62Id}`

  return stub.fetch(new Request(url.toString(), {
    method: c.req.method,
    headers: new Headers([
      ...c.req.raw.headers.entries(),
      ['X-Namespace', `do:${base62Id.slice(0, 8)}...`],
      ['X-DO-Name', `objectId:${hexId}`],
      ['X-Base-Url', baseUrl],
    ]),
    body: c.req.raw.body,
  }))
})

app.all('/*', (c) => {
  const namespace = getNamespaceFromHost(c.req.header('host') || '')
  if (!namespace) return c.json({ error: 'Not found' }, 404)
  return forwardToNamespace(c, namespace, new URL(c.req.url).pathname)
})

/**
 * Check if a string is a valid DO object ID (64 hex chars)
 */
function isHexObjectId(str: string): boolean {
  return /^[0-9a-f]{64}$/i.test(str)
}

/**
 * Parse an object ID (hex or base62) and return the hex form
 */
function parseObjectId(str: string): string | null {
  if (isHexObjectId(str)) return str.toLowerCase()
  if (isBase62Id(str)) {
    try {
      const hex = base62ToHex(str)
      if (isHexObjectId(hex)) return hex
    } catch {
      return null
    }
  }
  return null
}

async function forwardToNamespace(
  c: CollectionsContext,
  namespace: string,
  path: string
): Promise<Response> {
  const user = c.var.user!

  let doId
  let doName: string
  let baseUrl: string

  const protocol = c.req.header('x-forwarded-proto') || 'https'
  const host = c.req.header('host') || 'collections.do'

  // If namespace looks like an object ID (hex or base62), access directly
  const hexId = parseObjectId(namespace)
  if (hexId) {
    doId = c.env.COLLECTIONS.idFromString(hexId)
    doName = `objectId:${hexId}`
    const base62Id = hexToBase62(hexId)
    baseUrl = `${protocol}://${host}/_do/${base62Id}`
  } else {
    doName = `${user.id}:${namespace}`
    doId = c.env.COLLECTIONS.idFromName(doName)
    baseUrl = `${protocol}://${namespace}.collections.do`
  }

  const stub = c.env.COLLECTIONS.get(doId)

  const url = new URL(path, c.req.url)
  url.search = new URL(c.req.url).search

  return stub.fetch(new Request(url.toString(), {
    method: c.req.method,
    headers: new Headers([
      ...c.req.raw.headers.entries(),
      ['X-Namespace', namespace],
      ['X-DO-Name', doName],
      ['X-Base-Url', baseUrl],
    ]),
    body: c.req.raw.body,
  }))
}

// ═══════════════════════════════════════════════════════════════════════════
// Worker entry point with RPC support
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Collections Worker with RPC support
 *
 * Exposes collection methods via Workers RPC for direct calls from other workers.
 * Also handles HTTP requests via the Hono app.
 */
export default class CollectionsWorker extends WorkerEntrypoint<Env> {
  /**
   * HTTP fetch handler - delegates to Hono app
   */
  override async fetch(request: Request): Promise<Response> {
    return app.fetch(request, this.env)
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // RPC Methods - Callable by other workers via service binding
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Get the DO stub for a user's namespace
   * Each user + namespace combination gets its own DO/database
   */
  private getStub(userId: string, namespace: string = 'default'): DurableObjectStub<CollectionsDO> {
    const doName = `${userId}:${namespace}`
    const doId = this.env.COLLECTIONS.idFromName(doName)
    const stub = this.env.COLLECTIONS.get(doId)
    // Set the DO's name on first access
    stub.setName(doName)
    return stub
  }

  /**
   * Get the user's index DO (tracks all their namespaces)
   */
  private getIndexStub(userId: string): DurableObjectStub<CollectionsDO> {
    const doName = `index:${userId}`
    const doId = this.env.COLLECTIONS.idFromName(doName)
    const stub = this.env.COLLECTIONS.get(doId)
    stub.setName(doName)
    return stub
  }

  /**
   * Record a namespace in the user's index
   */
  private async recordNamespace(userId: string, namespace: string): Promise<void> {
    const stub = this.getIndexStub(userId)
    await stub.putDoc('_namespaces', namespace, { namespace, updatedAt: Date.now() })
  }

  /**
   * List all namespaces for a user
   */
  async listNamespaces(userId: string): Promise<string[]> {
    const stub = this.getIndexStub(userId)
    const docs = await stub.listDocs('_namespaces') as Array<{ id: string; namespace?: string }>
    return docs.map((d: { id: string }) => d.id)
  }

  /**
   * Get a document from a collection via RPC
   * @param userId - The authenticated user's ID
   */
  async get(userId: string, collection: string, id: string, namespace: string = 'default'): Promise<Record<string, unknown> | null> {
    const stub = this.getStub(userId, namespace)
    return stub.getDoc(collection, id)
  }

  /**
   * Put a document in a collection via RPC
   * @param userId - The authenticated user's ID
   */
  async put(userId: string, collection: string, id: string, doc: Record<string, unknown>, namespace: string = 'default'): Promise<Record<string, unknown>> {
    const stub = this.getStub(userId, namespace)
    const result = await stub.putDoc(collection, id, doc)
    // Record this namespace in the user's index
    await this.recordNamespace(userId, namespace)
    return result
  }

  /**
   * Delete a document from a collection via RPC
   * @param userId - The authenticated user's ID
   */
  async delete(userId: string, collection: string, id: string, namespace: string = 'default'): Promise<boolean> {
    const stub = this.getStub(userId, namespace)
    return stub.deleteDoc(collection, id)
  }

  /**
   * List documents in a collection via RPC
   * @param userId - The authenticated user's ID
   */
  async list(userId: string, collection: string, options?: { limit?: number; offset?: number }, namespace: string = 'default'): Promise<Record<string, unknown>[]> {
    const stub = this.getStub(userId, namespace)
    return stub.listDocs(collection, options)
  }

  /**
   * Find documents in a collection via RPC
   * @param userId - The authenticated user's ID
   */
  async find(userId: string, collection: string, filter?: Record<string, unknown>, options?: { limit?: number; offset?: number }, namespace: string = 'default'): Promise<Record<string, unknown>[]> {
    const stub = this.getStub(userId, namespace)
    return stub.findDocs(collection, filter, options)
  }

  /**
   * Count documents in a collection via RPC
   * @param userId - The authenticated user's ID
   */
  async count(userId: string, collection: string, filter?: Record<string, unknown>, namespace: string = 'default'): Promise<number> {
    const stub = this.getStub(userId, namespace)
    return stub.countDocs(collection, filter)
  }
}
