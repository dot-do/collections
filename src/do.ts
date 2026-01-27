/**
 * CollectionsDO - Managed Collections Durable Object
 *
 * Provides user-specific document collections with:
 * - Authentication via AUTH service binding
 * - Per-user DO namespaces
 * - Custom subdomains at *.collections.do
 */

import { DurableObject } from 'cloudflare:workers'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { createCollection, initCollectionsSchema } from '@dotdo/collections'
import type { SyncCollection } from '@dotdo/collections/types'

/**
 * User from auth service
 */
interface AuthUser {
  id: string
  email?: string
  name?: string
  image?: string
  org?: string
  roles?: string[]
  permissions?: string[]
}

export interface Env {
  COLLECTIONS: DurableObjectNamespace<CollectionsDO>
  AUTH: Fetcher  // Service binding to auth worker
  OAUTH: Fetcher // Service binding to oauth worker
}

/**
 * Managed Collections Durable Object
 */
export class CollectionsDO extends DurableObject<Env> {
  private sql: SqlStorage
  private app: Hono
  private collections = new Map<string, SyncCollection<Record<string, unknown>>>()

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    this.sql = ctx.storage.sql
    try {
      initCollectionsSchema(this.sql)
    } catch (e) {
      console.error('Failed to initialize schema:', e)
    }
    this.app = this.createApp()
  }

  private getCollection<T extends Record<string, unknown>>(name: string): SyncCollection<T> {
    let col = this.collections.get(name)
    if (!col) {
      col = createCollection<T>(this.sql, name)
      this.collections.set(name, col as SyncCollection<Record<string, unknown>>)
    }
    return col as SyncCollection<T>
  }

  private createApp(): Hono {
    const app = new Hono()

    app.get('/', (c) => {
      const namespace = c.req.header('X-Namespace') || 'unknown'
      const baseUrl = `https://${namespace}.collections.do`

      const rows = this.sql
        .exec<{ collection: string }>('SELECT DISTINCT collection FROM _collections ORDER BY collection')
        .toArray()

      return c.json({
        $id: baseUrl,
        namespace,
        collections: rows.map((r) => ({ $id: `${baseUrl}/${r.collection}`, name: r.collection })),
      })
    })

    app.get('/:collection', (c) => {
      const namespace = c.req.header('X-Namespace') || 'unknown'
      const baseUrl = `https://${namespace}.collections.do`
      const name = c.req.param('collection')
      const col = this.getCollection(name)
      const limit = parseInt(c.req.query('limit') || '100')
      const offset = parseInt(c.req.query('offset') || '0')
      const docs = col.list({ limit, offset })

      return c.json({
        $id: `${baseUrl}/${name}`,
        collection: name,
        count: col.count(),
        docs: docs.map((doc: Record<string, unknown>) => ({ $id: `${baseUrl}/${name}/${doc['id']}`, ...doc })),
      })
    })

    app.get('/:collection/:id', (c) => {
      const namespace = c.req.header('X-Namespace') || 'unknown'
      const baseUrl = `https://${namespace}.collections.do`
      const name = c.req.param('collection')
      const id = c.req.param('id')
      const doc = this.getCollection(name).get(id)
      if (!doc) return c.json({ error: 'Not found' }, 404)
      return c.json({ $id: `${baseUrl}/${name}/${id}`, id, ...doc })
    })

    app.put('/:collection/:id', async (c) => {
      const name = c.req.param('collection')
      const id = c.req.param('id')
      const doc = await c.req.json()
      this.getCollection(name).put(id, doc)
      return c.json({ id, ...doc }, 201)
    })

    app.delete('/:collection/:id', (c) => {
      const name = c.req.param('collection')
      const id = c.req.param('id')
      const deleted = this.getCollection(name).delete(id)
      if (!deleted) return c.json({ error: 'Not found' }, 404)
      return c.json({ deleted: true })
    })

    app.post('/:collection/query', async (c) => {
      const name = c.req.param('collection')
      const { filter, limit, offset, sort } = await c.req.json()
      const docs = this.getCollection(name).find(filter, { limit, offset, sort })
      return c.json({ collection: name, count: docs.length, docs })
    })

    app.delete('/:collection', (c) => {
      const name = c.req.param('collection')
      return c.json({ cleared: this.getCollection(name).clear() })
    })

    return app
  }

  override async fetch(request: Request): Promise<Response> {
    return this.app.fetch(request)
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Helper functions
// ═══════════════════════════════════════════════════════════════════════════

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
// Worker entry point
// ═══════════════════════════════════════════════════════════════════════════

const app = new Hono<{ Bindings: Env; Variables: { user: AuthUser | null } }>()

app.use('*', cors())

// Auth middleware - uses AUTH service binding
app.use('/*', async (c, next) => {
  const path = c.req.path
  const namespace = getNamespaceFromHost(c.req.header('host') || '')

  // Skip auth for auth/OAuth routes (always) and root info (main domain only)
  const publicPaths = ['/login', '/logout', '/callback', '/authorize', '/token', '/introspect', '/revoke']
  const wellKnownPaths = ['/.well-known/oauth-authorization-server', '/.well-known/oauth-protected-resource', '/.well-known/jwks.json', '/.well-known/openid-configuration']
  if (publicPaths.includes(path) || wellKnownPaths.includes(path)) {
    return next()
  }
  if (!namespace && path === '/') {
    return next()
  }

  // Call AUTH service to get user
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

  // Not authenticated
  const accept = c.req.header('Accept') || ''
  if (accept.includes('text/html')) {
    return c.redirect(`/login?returnTo=${encodeURIComponent(c.req.url)}`)
  }
  return c.json({ error: 'Authentication required' }, 401)
})

// ═══════════════════════════════════════════════════════════════════════════
// MCP OAuth 2.1 endpoints - proxy to OAuth worker with dynamic issuer
// ═══════════════════════════════════════════════════════════════════════════

function getIssuer(c: any): string {
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
  const body = await c.req.text()

  return c.env.OAUTH.fetch(new Request('https://oauth.do/introspect', {
    method: 'POST',
    headers: {
      'Content-Type': c.req.header('Content-Type') || 'application/x-www-form-urlencoded',
    },
    body,
  }))
})

// Token revocation endpoint (RFC 7009)
app.post('/revoke', async (c) => {
  const body = await c.req.text()

  return c.env.OAUTH.fetch(new Request('https://oauth.do/revoke', {
    method: 'POST',
    headers: {
      'Content-Type': c.req.header('Content-Type') || 'application/x-www-form-urlencoded',
    },
    body,
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
  const cookieParts = [
    'auth=',
    'HttpOnly',
    'Secure',
    'SameSite=Lax',
    'Max-Age=0',
    'Path=/',
  ]
  if (domain) cookieParts.push(`Domain=${domain}`)

  return new Response(null, {
    status: 302,
    headers: {
      'Location': c.req.query('returnTo') || '/',
      'Set-Cookie': cookieParts.join('; '),
    },
  })
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

  const { token } = await response.json() as { token: string }

  // Build cookie string manually to ensure it's included in redirect
  const domain = getCookieDomain(c.req.header('host') || '')
  const cookieParts = [
    `auth=${token}`,
    'HttpOnly',
    'Secure',
    'SameSite=Lax',
    `Max-Age=${7 * 24 * 60 * 60}`,
    'Path=/',
  ]
  if (domain) cookieParts.push(`Domain=${domain}`)

  // Return redirect with Set-Cookie header
  return new Response(null, {
    status: 302,
    headers: {
      'Location': returnTo,
      'Set-Cookie': cookieParts.join('; '),
    },
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// API routes
// ═══════════════════════════════════════════════════════════════════════════

app.get('/', (c) => {
  const namespace = getNamespaceFromHost(c.req.header('host') || '')
  if (namespace) {
    return forwardToNamespace(c, namespace, '/')
  }
  return c.json({
    name: 'collections.do',
    description: 'Managed document collections service',
    endpoints: {
      '/': 'API info',
      '/me': 'Your user info',
      '/:namespace.collections.do/:collection': 'Collection operations',
    },
  })
})

app.get('/me', (c) => {
  const user = c.var.user!
  return c.json({
    user: { id: user.id, email: user.email, name: user.name, image: user.image },
  })
})

app.all('/*', (c) => {
  const namespace = getNamespaceFromHost(c.req.header('host') || '')
  if (!namespace) return c.json({ error: 'Not found' }, 404)
  return forwardToNamespace(c, namespace, new URL(c.req.url).pathname)
})

async function forwardToNamespace(c: any, namespace: string, path: string): Promise<Response> {
  const user = c.var.user!
  const doId = c.env.COLLECTIONS.idFromName(`${user.id}:${namespace}`)
  const stub = c.env.COLLECTIONS.get(doId)

  const url = new URL(path, c.req.url)
  url.search = new URL(c.req.url).search

  return stub.fetch(new Request(url.toString(), {
    method: c.req.method,
    headers: new Headers([...c.req.raw.headers.entries(), ['X-Namespace', namespace]]),
    body: c.req.raw.body,
  }))
}

export default app
