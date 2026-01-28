# Collections v2 Design Document

## Overview

This document outlines the design for the next major version of `@dotdo/collections`, adding support for:

1. **Automatic Storage Detection** - Auto-detect D1 vs DO SQLite from environment bindings
2. **D1 Database Support** - In addition to Durable Object SQLite
3. **Tables-Per-Collection** - Optional dedicated tables instead of shared `_collections` table
4. **Optional Timestamps** - Configurable `createdAt`/`updatedAt` fields
5. **Audit Fields** - `createdBy`/`updatedBy` with auth context
6. **Full-Text Search** - SQLite FTS5 integration
7. **JSON Path Indexes** - Custom indexes on document fields

---

## Table of Contents

- [1. Automatic Storage Detection](#1-automatic-storage-detection)
- [2. Schema Definition](#2-schema-definition)
- [3. Collection Options](#3-collection-options)
- [4. Tables-Per-Collection](#4-tables-per-collection)
- [5. Timestamps Configuration](#5-timestamps-configuration)
- [6. Audit Fields](#6-audit-fields)
- [7. Full-Text Search](#7-full-text-search)
- [8. JSON Path Indexes](#8-json-path-indexes)
- [9. Schema Management](#9-schema-management)
- [10. Migration Strategy](#10-migration-strategy)
- [11. API Reference](#11-api-reference)

---

## 1. Automatic Storage Detection

### Design Goal

Zero-configuration storage detection. The library automatically determines the best storage backend based on available environment bindings.

```typescript
import { Collections } from '@dotdo/collections'

// Automatic - detects D1 or DO bindings from environment
const db = new Collections()
const users = db.collection<User>('users')
```

### Environment Detection

Using Cloudflare's `cloudflare:workers` module to introspect bindings:

```typescript
import { env } from 'cloudflare:workers'

// Binding type detection
function detectBindingType(binding: unknown): 'd1' | 'do' | 'sql' | 'unknown' {
  if (!binding) return 'unknown'

  // D1Database has prepare(), batch(), exec(), dump()
  if (typeof binding === 'object' && 'prepare' in binding && 'batch' in binding) {
    return 'd1'
  }

  // DurableObjectNamespace has get(), idFromName(), idFromString()
  if (typeof binding === 'object' && 'idFromName' in binding && 'get' in binding) {
    return 'do'
  }

  // SqlStorage has exec() but not prepare()
  if (typeof binding === 'object' && 'exec' in binding && !('prepare' in binding)) {
    return 'sql'
  }

  return 'unknown'
}

// Auto-discover storage from env
function discoverStorage(): StorageConfig {
  // Priority 1: Explicit COLLECTIONS binding
  if (env.COLLECTIONS) {
    const type = detectBindingType(env.COLLECTIONS)
    if (type === 'd1') return { type: 'd1', binding: env.COLLECTIONS }
    if (type === 'do') return { type: 'do', binding: env.COLLECTIONS }
  }

  // Priority 2: Common D1 binding names
  for (const name of ['DB', 'DATABASE', 'D1']) {
    if (env[name] && detectBindingType(env[name]) === 'd1') {
      return { type: 'd1', binding: env[name] }
    }
  }

  // Priority 3: Any D1 binding
  for (const [key, value] of Object.entries(env)) {
    if (detectBindingType(value) === 'd1') {
      return { type: 'd1', binding: value, name: key }
    }
  }

  // Priority 4: Any DO binding (will use internal SqlStorage)
  for (const [key, value] of Object.entries(env)) {
    if (detectBindingType(value) === 'do') {
      return { type: 'do', binding: value, name: key }
    }
  }

  throw new Error('No D1 or Durable Object binding found in environment')
}
```

### Usage Patterns

#### Pattern 1: Fully Automatic (Recommended)

```typescript
import { Collections } from '@dotdo/collections'

// Auto-detects from environment
const db = new Collections()

// Define collections with options
const users = db.collection<User>('users', {
  indexes: [{ field: 'email', unique: true }]
})

const posts = db.collection<Post>('posts', {
  fts: { fields: ['title', 'content'] }
})

// Use collections
await users.put('user1', { name: 'Alice', email: 'alice@example.com' })
const user = await users.get('user1')
```

#### Pattern 2: Explicit Binding Name

```typescript
import { Collections } from '@dotdo/collections'

// Use specific binding by name
const db = new Collections({ binding: 'MY_DATABASE' })
```

#### Pattern 3: Explicit Binding Reference

```typescript
import { Collections } from '@dotdo/collections'

// Pass binding directly (works in any context)
const db = new Collections({ d1: env.DB })
// or
const db = new Collections({ do: env.COLLECTIONS })
// or inside a DO:
const db = new Collections({ sql: this.ctx.storage.sql })
```

#### Pattern 4: Inside Durable Object

```typescript
import { Collections } from '@dotdo/collections'

export class MyDO extends DurableObject {
  db: Collections

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    // Auto-detects SqlStorage from DO context
    this.db = new Collections({ sql: ctx.storage.sql })
  }

  async handleRequest() {
    const users = this.db.collection<User>('users')
    // Sync operations inside DO
    users.put('user1', { name: 'Alice' })
    return users.get('user1')
  }
}
```

### Unified API with Automatic Sync/Async

The API is always the same, but return types adapt to the storage backend:

```typescript
interface Collections {
  // Returns SyncCollection for DO/SqlStorage, AsyncCollection for D1
  collection<T>(name: string, options?: CollectionOptions): Collection<T>
}

// Type-safe based on how Collections was instantiated
const db = new Collections({ sql: ctx.storage.sql })
const users = db.collection<User>('users')
users.get('user1')  // Returns T | null (sync)

const db = new Collections({ d1: env.DB })
const users = db.collection<User>('users')
await users.get('user1')  // Returns Promise<T | null> (async)
```

### Configuration Interface

```typescript
interface CollectionsConfig {
  // Explicit binding references (mutually exclusive for default)
  d1?: D1Database
  do?: DurableObjectNamespace
  sql?: SqlStorage

  // Or reference by name (auto-detected from env)
  binding?: string

  // Global defaults for all collections
  defaults?: CollectionOptions

  // Auth context provider (for audit fields)
  context?: () => OperationContext
}

// Examples
new Collections()                              // Full auto-detect
new Collections({ binding: 'DB' })             // By binding name
new Collections({ d1: env.DB })                // Explicit D1
new Collections({ sql: ctx.storage.sql })      // Explicit SqlStorage
new Collections({
  d1: env.DB,
  defaults: { timestamps: true, audit: true },
  context: () => ({ userId: getCurrentUser() })
})
```

### Multiple Storage Backends

When you have multiple D1 databases or need both D1 and DO storage:

```typescript
import { Collections } from '@dotdo/collections'

// Register multiple storage backends
const db = new Collections({
  // Named storage backends
  storage: {
    // D1 databases
    primary: env.DB,           // Auto-detected as D1
    analytics: env.ANALYTICS,  // Another D1
    // Durable Object storage
    sessions: env.SESSIONS,    // Auto-detected as DO
  },
  // Default storage (optional - first one if not specified)
  default: 'primary',
})

// Collections use default storage
const users = db.collection<User>('users')

// Or specify storage explicitly
const events = db.collection<Event>('events', { storage: 'analytics' })
const sessions = db.collection<Session>('sessions', { storage: 'sessions' })
```

#### Shorthand for Single Storage

```typescript
// These are equivalent:
new Collections({ d1: env.DB })
new Collections({ storage: { default: env.DB } })

// Auto-detect is equivalent to:
new Collections()
new Collections({ storage: { default: discoverStorage() } })
```

#### Mixed D1 + DO Architecture

Common pattern: D1 for global data, DO for per-user/per-tenant data:

```typescript
// In a Worker
const db = new Collections({
  storage: {
    global: env.DB,        // D1 for shared data
    tenant: env.TENANTS,   // DO namespace for tenant isolation
  }
})

// Global collections (D1)
const plans = db.collection('plans', { storage: 'global' })
const features = db.collection('features', { storage: 'global' })

// Per-tenant collections (DO - need to specify tenant)
const tenantDb = db.forTenant(tenantId)  // Gets DO stub
const users = tenantDb.collection<User>('users')
const settings = tenantDb.collection<Settings>('settings')
```

#### DO Namespace Resolution

When using a DO binding, need to resolve to a specific instance:

```typescript
interface CollectionsConfig {
  storage?: {
    [name: string]: D1Database | DurableObjectNamespace | SqlStorage
  }

  // For DO namespaces, how to get the instance ID
  doResolver?: (namespace: DurableObjectNamespace, collectionName: string) => DurableObjectId
}

// Default resolver: one DO instance per collection
const defaultResolver = (ns: DurableObjectNamespace, name: string) =>
  ns.idFromName(name)

// Or: all collections in one DO
const singleInstanceResolver = (ns: DurableObjectNamespace) =>
  ns.idFromName('collections')

// Or: tenant-based
const tenantResolver = (ns: DurableObjectNamespace, name: string, ctx: Context) =>
  ns.idFromName(`${ctx.tenantId}:${name}`)
```

### Complete Configuration Example

```typescript
import { Collections } from '@dotdo/collections'
import { env } from 'cloudflare:workers'

const db = new Collections({
  // Multiple storage backends
  storage: {
    main: env.DB,           // D1 - primary database
    cache: env.CACHE_DB,    // D1 - fast cache database
    realtime: env.REALTIME, // DO - for live/realtime data
  },
  default: 'main',

  // Global defaults for all collections
  defaults: {
    timestamps: true,
    audit: true,
  },

  // Auth context provider
  context: () => ({
    userId: getCurrentUser()?.id,
    tenantId: getCurrentTenant()?.id,
  }),

  // DO instance resolution
  doResolver: (ns, collection, ctx) =>
    ns.idFromName(`${ctx.tenantId}:${collection}`),
})

// Usage
const users = db.collection<User>('users')  // Uses 'main' (D1)
const cache = db.collection<CacheEntry>('cache', { storage: 'cache' })
const presence = db.collection<Presence>('presence', { storage: 'realtime' })
```
```

### D1 vs DO SQLite Comparison

| Feature | DO SQLite | D1 |
|---------|-----------|-----|
| API | Synchronous | Asynchronous |
| Scope | Per-DO instance | Global database |
| Transactions | `sql.transaction()` | `db.batch()` |
| FTS5 | ✅ Supported | ✅ Supported |
| Generated Columns | ✅ Supported | ✅ Supported |
| Size Limit | 1GB per DO | 10GB per database |
| Pricing | Included in DO | Per-query billing |
| Auto-detection | Via `ctx.storage.sql` | Via env bindings |

### Implementation Architecture

```
core/src/
├── index.ts              # Main exports, Collections class
├── detect.ts             # Environment/binding detection
├── adapters/
│   ├── types.ts          # StorageAdapter interface
│   ├── sql-storage.ts    # DO SqlStorage adapter (sync)
│   └── d1.ts             # D1 adapter (async)
├── collection/
│   ├── sync.ts           # SyncCollection implementation
│   ├── async.ts          # AsyncCollection implementation
│   └── base.ts           # Shared logic
├── filter.ts             # Shared filter compiler
├── schema.ts             # Shared schema generation
└── types.ts              # Type definitions
```

### Storage Adapter Interface

```typescript
// Unified interface that both adapters implement
interface StorageAdapter {
  readonly type: 'sync' | 'async'

  // For sync (DO SqlStorage)
  execSync?<T>(sql: string, ...params: unknown[]): T[]

  // For async (D1)
  execAsync?<T>(sql: string, ...params: unknown[]): Promise<T[]>

  // Batch operations
  batchSync?(statements: string[]): void
  batchAsync?(statements: string[]): Promise<void>

  // Transaction support
  transaction?<T>(fn: () => T): T
  transactionAsync?<T>(fn: () => Promise<T>): Promise<T>
}

// SqlStorage adapter (sync)
class SqlStorageAdapter implements StorageAdapter {
  readonly type = 'sync' as const

  constructor(private sql: SqlStorage) {}

  execSync<T>(sql: string, ...params: unknown[]): T[] {
    return this.sql.exec<T>(sql, ...params).toArray()
  }

  batchSync(statements: string[]): void {
    for (const stmt of statements) {
      this.sql.exec(stmt)
    }
  }

  transaction<T>(fn: () => T): T {
    return this.sql.transaction(fn)
  }
}

// D1 adapter (async)
class D1Adapter implements StorageAdapter {
  readonly type = 'async' as const

  constructor(private db: D1Database) {}

  async execAsync<T>(sql: string, ...params: unknown[]): Promise<T[]> {
    const stmt = this.db.prepare(sql)
    if (params.length) stmt.bind(...params)
    const result = await stmt.all<T>()
    return result.results
  }

  async batchAsync(statements: string[]): Promise<void> {
    await this.db.batch(statements.map(s => this.db.prepare(s)))
  }

  async transactionAsync<T>(fn: () => Promise<T>): Promise<T> {
    // D1 doesn't have true transactions, use batch for atomicity
    return fn()
  }
}
```

---

## 2. Schema Definition

### IceType-Style Schema (Recommended)

Inspired by [icetype](https://github.com/dotdo-io/icetype), schemas use a simple string-based DSL with modifiers:

```typescript
import { Collections } from '@dotdo/collections'

const db = new Collections({
  schema: {
    users: {
      email: 'string!#',        // ! = required, # = indexed
      name: 'string',
      age: 'int?',              // ? = optional
      role: 'string = "user"',  // default value
      active: 'bool = true',
      profile: 'json?',

      // Relations
      posts: '<- posts.authorId',  // backward relation

      // Directives
      $index: [['email'], ['role', 'active']],  // compound indexes
      $fts: ['name'],           // full-text search
      $timestamps: true,        // createdAt, updatedAt
      $audit: true,             // createdBy, updatedBy
    },

    posts: {
      title: 'string!',
      content: 'text!',
      authorId: 'string!#',
      tags: 'json = []',
      status: 'string = "draft"',
      views: 'int = 0',

      // Relations
      author: '-> users',       // forward relation
      comments: '<- comments.postId',

      $index: [['authorId', 'status']],
      $fts: ['title', 'content'],
      $timestamps: true,
    },

    comments: {
      postId: 'string!#',
      authorId: 'string!#',
      content: 'text!',

      post: '-> posts',
      author: '-> users',

      $timestamps: true,
    },
  }
})
```

### Type Modifiers

| Modifier | Meaning | Example |
|----------|---------|---------|
| `!` | Required | `email: 'string!'` |
| `?` | Optional/nullable | `age: 'int?'` |
| `#` | Indexed | `email: 'string#'` |
| `!#` | Required + indexed | `email: 'string!#'` |
| `= value` | Default value | `role: 'string = "user"'` |

### Field Types

```typescript
// Primitives
string    // Text
text      // Long text (same as string, semantic)
int       // Integer
float     // Floating point
bool      // Boolean
json      // JSON object/array
uuid      // UUID string
timestamp // Unix timestamp (ms)

// With defaults
'string = "hello"'
'int = 0'
'bool = true'
'json = []'
'json = {}'
```

### Relations

Relations are stored in a separate `_rels` table for efficient querying.

#### Relation Syntax

```typescript
// Cardinality is explicit in the schema
author: '-> users'           // One-to-one: returns User | null
tags: '-> tags[]'            // Many-to-many: returns Tag[]
posts: '<- posts.authorId'   // One-to-many (reverse): returns Post[]
```

| Syntax | Cardinality | Return Type |
|--------|-------------|-------------|
| `'-> target'` | One-to-one | `T \| null` |
| `'-> target[]'` | One-to-many / Many-to-many | `T[]` |
| `'<- target.field'` | One-to-many (reverse) | `T[]` |
| `'<- target.field[]'` | Many-to-many (reverse) | `T[]` |

#### Setting Relations (Natural Interface)

Relations are set directly on the document - no separate `link()` method needed:

```typescript
// Set by ID
await db.posts.put('post1', {
  title: 'Hello World',
  author: 'user1',              // string ID for -> relation
  tags: ['tag1', 'tag2'],       // string[] IDs for ->[] relation
})

// Set by object (ID is extracted)
await db.posts.put('post1', {
  title: 'Hello World',
  author: { id: 'user1', name: 'Alice' },  // object with id
  tags: [{ id: 'tag1' }, { id: 'tag2' }],
})

// Clear a relation
await db.posts.put('post1', {
  title: 'Hello World',
  author: null,   // removes the relation
  tags: [],       // clears all tag relations
})
```

#### Reading Relations

**TBD: Pending spike for performance testing and TypeScript inference testing.**

Two candidate APIs under consideration:

```typescript
// Option A: Boolean flag
await db.posts.get('post1', { populate: true })

// Option B: Selective array
await db.posts.get('post1', { include: ['author', 'tags'] })
await db.posts.get('post1', { include: ['author'] })  // only author
```

For now, relations are always returned as IDs:

```typescript
const post = await db.posts.get('post1')
// { id: 'post1', title: 'Hello', author: 'user1', tags: ['tag1', 'tag2'] }
```

Manual loading can be done with separate queries:

```typescript
const post = await db.posts.get('post1')
const author = post?.author ? await db.users.get(post.author) : null
```

#### Type Inference from Cardinality

Relations are typed based on their cardinality in the schema:

```typescript
const db = new Collections({
  schema: {
    posts: {
      title: 'string!',
      author: '-> users',              // singular → string | null
      tags: '-> tags[]',               // array → string[]
      comments: '<- comments.postId',  // reverse → string[]
    }
  }
})

// Inferred type (relations as IDs):
type Post = {
  id: string
  title: string
  author: string | null     // singular relation = ID or null
  tags: string[]            // array relation = array of IDs
  comments: string[]        // reverse relation = array of IDs
}

const post = await db.posts.get('post1')
post.author   // string | null
post.tags     // string[]
post.comments // string[]
```

**TBD:** Type inference for populated relations (when `populate`/`include` API is finalized).

#### Relations Table Schema

```sql
CREATE TABLE _rels (
  source_collection TEXT NOT NULL,
  source_id TEXT NOT NULL,
  field TEXT NOT NULL,
  target_collection TEXT NOT NULL,
  target_id TEXT NOT NULL,
  position INT,  -- for ordered arrays (preserves order of tags, etc.)
  created_at INTEGER,
  PRIMARY KEY (source_collection, source_id, field, target_id)
);

CREATE INDEX _rels_target ON _rels(target_collection, target_id);
CREATE INDEX _rels_source_field ON _rels(source_collection, source_id, field);
```

#### Querying by Relations

```typescript
// Find posts by a specific author
const posts = await db.posts.find({ author: 'user1' })

// Find posts with a specific tag
const posts = await db.posts.find({ tags: { $contains: 'tag1' } })

// Find posts with any of these tags
const posts = await db.posts.find({ tags: { $containsAny: ['tag1', 'tag2'] } })

// Find users who have posts (reverse relation exists)
const authors = await db.users.find({ posts: { $exists: true } })

// Find users with more than 5 posts
const prolificAuthors = await db.users.find({ posts: { $size: { $gt: 5 } } })
```

### Directives

```typescript
{
  $index: [                    // Secondary indexes
    ['field1'],                // Single field
    ['field1', 'field2'],      // Compound index
  ],
  $unique: [['email']],        // Unique constraints
  $fts: ['title', 'content'],  // Full-text search fields
  $timestamps: true,           // Add createdAt, updatedAt
  $audit: true,                // Add createdBy, updatedBy
  $storage: 'dedicated',       // Use dedicated table (vs shared)
}
```

### Type Inference

Types are automatically inferred from the schema:

```typescript
const db = new Collections({
  schema: {
    users: {
      email: 'string!',
      name: 'string',
      age: 'int?',
    }
  }
})

// Inferred type:
// {
//   id: string
//   email: string
//   name: string | undefined
//   age: number | null
//   createdAt?: number
//   updatedAt?: number
// }

const user = await db.users.get('user1')
user?.email  // string
user?.age    // number | null
```

### No Migrations Needed

Since documents are stored as JSON, field changes don't require migrations:

```typescript
// v1: Just email and name
users: {
  email: 'string!',
  name: 'string',
}

// v2: Added role field - no migration needed!
users: {
  email: 'string!',
  name: 'string',
  role: 'string = "user"',  // New field, existing docs get default on read
}
```

**What DOES require updates:**
- Adding/removing indexes → `CREATE INDEX` / `DROP INDEX`
- Adding/removing FTS → Rebuild FTS table
- Changing from shared to dedicated table → Data migration

These are handled automatically on startup by diffing the schema.

### Ad-hoc Collections (No Schema)

Still supported for dynamic use cases:

```typescript
const db = new Collections()

// No predefined schema - accepts any document
const logs = db.collection<LogEntry>('logs')
await logs.put('log1', { level: 'info', message: 'Hello' })
```

---

## 3. Collection Options (Ad-hoc)

### Complete Options Interface

```typescript
interface CollectionOptions {
  /**
   * Storage mode for this collection
   * - 'shared': All documents in shared _collections table (default)
   * - 'dedicated': Collection gets its own table
   */
  storage?: 'shared' | 'dedicated'

  /**
   * Timestamp configuration
   * - true: Enable createdAt/updatedAt (default)
   * - false: Disable timestamps entirely
   * - object: Custom field names
   */
  timestamps?: boolean | {
    createdAt?: string | false  // Field name or false to disable
    updatedAt?: string | false  // Field name or false to disable
    type?: 'column' | 'json'    // Store as column or in JSON data
  }

  /**
   * Audit field configuration (requires context)
   * - true: Enable createdBy/updatedBy
   * - false: Disable audit fields (default)
   * - object: Custom field names
   */
  audit?: boolean | {
    createdBy?: string | false  // Field name, default 'createdBy'
    updatedBy?: string | false  // Field name, default 'updatedBy'
    type?: 'column' | 'json'    // Store as column or in JSON data
  }

  /**
   * Full-text search configuration (dedicated tables only)
   */
  fts?: {
    fields: string[]            // Fields to index for FTS
    tokenizer?: 'unicode61' | 'porter' | 'trigram'  // FTS5 tokenizer
  }

  /**
   * Custom indexes on JSON fields (dedicated tables only)
   */
  indexes?: Array<{
    field: string               // JSON path: 'email' or 'address.city'
    unique?: boolean            // Create unique index
    sparse?: boolean            // Only index non-null values
    collation?: 'BINARY' | 'NOCASE'  // Collation for string comparison
  }>

  /**
   * Schema versioning for migrations
   */
  version?: number
}
```

### Option Resolution

```typescript
// Defaults
const DEFAULT_OPTIONS: Required<CollectionOptions> = {
  storage: 'shared',
  timestamps: true,
  audit: false,
  fts: undefined,
  indexes: undefined,
  version: 1,
}

// Normalized options after resolution
interface ResolvedOptions {
  storage: 'shared' | 'dedicated'
  timestamps: {
    enabled: boolean
    createdAt: string | false
    updatedAt: string | false
    type: 'column' | 'json'
  }
  audit: {
    enabled: boolean
    createdBy: string | false
    updatedBy: string | false
    type: 'column' | 'json'
  }
  fts: { fields: string[]; tokenizer: string } | null
  indexes: Array<{ field: string; unique: boolean; sparse: boolean }> | null
  version: number
}

function resolveOptions(options?: CollectionOptions): ResolvedOptions {
  // ... normalize all options to consistent structure
}
```

---

## 4. Tables-Per-Collection

### Shared Table (Default)

Current behavior - all collections in one table:

```sql
CREATE TABLE _collections (
  collection TEXT NOT NULL,
  id TEXT NOT NULL,
  data TEXT NOT NULL,
  created_at INTEGER,
  updated_at INTEGER,
  created_by TEXT,
  updated_by TEXT,
  PRIMARY KEY (collection, id)
);

CREATE INDEX _collections_collection ON _collections(collection);
CREATE INDEX _collections_updated ON _collections(collection, updated_at);
```

**Pros:**
- Simple schema management
- Single initialization
- Works well for many small collections

**Cons:**
- No per-collection indexes
- FTS requires workarounds
- All collections share index overhead

### Dedicated Tables

Each collection gets its own table:

```sql
-- Table for 'users' collection
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  created_at INTEGER,
  updated_at INTEGER,
  created_by TEXT,
  updated_by TEXT
);

-- Custom indexes for this collection
CREATE UNIQUE INDEX users_email ON users(json_extract(data, '$.email'));
CREATE INDEX users_status ON users(json_extract(data, '$.status'));

-- FTS for this collection
CREATE VIRTUAL TABLE users_fts USING fts5(name, bio, content='users');
```

**Pros:**
- Per-collection indexes
- Native FTS5 support
- Better query optimization
- Cleaner schema

**Cons:**
- Dynamic table creation
- More complex migrations
- Table name validation needed

### Table Naming

```typescript
function getTableName(collectionName: string, options: ResolvedOptions): string {
  if (options.storage === 'shared') {
    return '_collections'
  }
  // Validate and sanitize collection name for use as table name
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(collectionName)) {
    throw new Error(`Invalid collection name for dedicated table: ${collectionName}`)
  }
  return collectionName
}
```

### Schema Generation

```typescript
function generateSchema(name: string, options: ResolvedOptions): string[] {
  const statements: string[] = []
  const table = getTableName(name, options)

  if (options.storage === 'dedicated') {
    // Dedicated table schema
    const columns = ['id TEXT PRIMARY KEY', 'data TEXT NOT NULL']

    if (options.timestamps.enabled) {
      if (options.timestamps.createdAt && options.timestamps.type === 'column') {
        columns.push('created_at INTEGER')
      }
      if (options.timestamps.updatedAt && options.timestamps.type === 'column') {
        columns.push('updated_at INTEGER')
      }
    }

    if (options.audit.enabled) {
      if (options.audit.createdBy && options.audit.type === 'column') {
        columns.push('created_by TEXT')
      }
      if (options.audit.updatedBy && options.audit.type === 'column') {
        columns.push('updated_by TEXT')
      }
    }

    statements.push(`CREATE TABLE IF NOT EXISTS ${table} (${columns.join(', ')})`)

    // Add indexes
    if (options.indexes) {
      for (const idx of options.indexes) {
        const indexName = `${table}_${idx.field.replace('.', '_')}`
        const unique = idx.unique ? 'UNIQUE ' : ''
        const jsonPath = `json_extract(data, '$.${idx.field}')`
        statements.push(
          `CREATE ${unique}INDEX IF NOT EXISTS ${indexName} ON ${table}(${jsonPath})`
        )
      }
    }

    // Add FTS
    if (options.fts) {
      statements.push(...generateFTSSchema(table, options.fts))
    }
  } else {
    // Shared table schema (existing)
    statements.push(`
      CREATE TABLE IF NOT EXISTS _collections (
        collection TEXT NOT NULL,
        id TEXT NOT NULL,
        data TEXT NOT NULL,
        created_at INTEGER,
        updated_at INTEGER,
        created_by TEXT,
        updated_by TEXT,
        PRIMARY KEY (collection, id)
      )
    `)
    statements.push(`CREATE INDEX IF NOT EXISTS _collections_collection ON _collections(collection)`)
    statements.push(`CREATE INDEX IF NOT EXISTS _collections_updated ON _collections(collection, updated_at)`)
  }

  return statements
}
```

---

## 5. Timestamps Configuration

### Options

```typescript
// Disable timestamps entirely
createCollection(sql, 'logs', { timestamps: false })

// Default (enabled with standard names)
createCollection(sql, 'users', { timestamps: true })
// Equivalent to:
createCollection(sql, 'users', {
  timestamps: { createdAt: 'createdAt', updatedAt: 'updatedAt', type: 'column' }
})

// Custom field names
createCollection(sql, 'posts', {
  timestamps: { createdAt: 'publishedAt', updatedAt: 'modifiedAt' }
})

// Only track creation time
createCollection(sql, 'events', {
  timestamps: { createdAt: 'timestamp', updatedAt: false }
})

// Store in JSON data instead of columns
createCollection(sql, 'items', {
  timestamps: { type: 'json' }
})
```

### Storage Types

**Column storage (default):**
```sql
-- Stored as table columns
INSERT INTO users (id, data, created_at, updated_at) VALUES (?, ?, ?, ?)
```

**JSON storage:**
```typescript
// Merged into document data
const docWithTimestamps = {
  ...doc,
  createdAt: Date.now(),
  updatedAt: Date.now(),
}
sql.exec('INSERT INTO users (id, data) VALUES (?, ?)', id, JSON.stringify(docWithTimestamps))
```

### Implementation

```typescript
function put(id: string, doc: T, context?: OperationContext): void {
  const now = Date.now()
  let data = { ...doc }
  const columns = ['id', 'data']
  const values: unknown[] = [id]

  // Handle timestamps
  if (options.timestamps.enabled) {
    if (options.timestamps.type === 'json') {
      // Store in JSON
      const existing = this.get(id)
      if (!existing && options.timestamps.createdAt) {
        data[options.timestamps.createdAt] = now
      }
      if (options.timestamps.updatedAt) {
        data[options.timestamps.updatedAt] = now
      }
    } else {
      // Store as columns
      if (options.timestamps.createdAt) columns.push('created_at')
      if (options.timestamps.updatedAt) columns.push('updated_at')
    }
  }

  values.push(JSON.stringify(data))

  if (options.timestamps.type === 'column') {
    if (options.timestamps.createdAt) values.push(now)
    if (options.timestamps.updatedAt) values.push(now)
  }

  // Generate INSERT ... ON CONFLICT
  // ...
}
```

### Querying with Timestamps

```typescript
// Sort by timestamps (works with both storage types)
users.find({}, { sort: '-updatedAt' })

// Filter by timestamps
users.find({ createdAt: { $gt: Date.now() - 86400000 } })  // Last 24h

// Include timestamps in results
interface UserWithMeta extends User {
  createdAt?: number
  updatedAt?: number
}
const users = createCollection<UserWithMeta>(sql, 'users')
```

---

## 6. Audit Fields

### Configuration

```typescript
// Enable with defaults
db.collection('documents', { audit: true })
// Creates createdBy, updatedBy columns

// Custom field names
db.collection('records', {
  audit: { createdBy: 'author', updatedBy: 'lastEditor' }
})

// Store in JSON
db.collection('items', {
  audit: { type: 'json' }
})
```

### Automatic Context via AsyncLocalStorage

The recommended approach uses AsyncLocalStorage for automatic context propagation:

```typescript
import { Collections, withUser } from '@dotdo/collections'

const db = new Collections({
  d1: env.DB,
  defaults: { audit: true }
})

// In your auth middleware
export async function handleRequest(request: Request) {
  const user = await authenticateRequest(request)

  // Wrap the request handler with user context
  return withUser(user, async () => {
    // All collection operations automatically get user context
    const docs = db.collection<Doc>('docs')

    await docs.put('doc1', { title: 'Hello' })
    // createdBy/updatedBy automatically set to user.id

    return new Response('OK')
  })
}
```

#### Implementation

```typescript
import { AsyncLocalStorage } from 'node:async_hooks'

interface UserContext {
  userId?: string
  tenantId?: string
  [key: string]: unknown
}

// Global context store
const contextStore = new AsyncLocalStorage<UserContext>()

// Run code with user context
export function withUser<T>(user: UserContext, fn: () => T): T {
  return contextStore.run(user, fn)
}

// Get current context (used internally by collections)
export function getCurrentContext(): UserContext {
  return contextStore.getStore() ?? {}
}

// Convenience for getting current user ID
export function getCurrentUserId(): string | undefined {
  return getCurrentContext().userId
}
```

#### Integration with Auth Providers

```typescript
// With oauth.do / auth.do
import { Collections, withUser } from '@dotdo/collections'
import { Auth } from 'auth.do'

const auth = new Auth()
const db = new Collections({ d1: env.DB, defaults: { audit: true } })

export default {
  async fetch(request: Request, env: Env) {
    // Authenticate
    const session = await auth.getSession(request)

    if (!session) {
      return new Response('Unauthorized', { status: 401 })
    }

    // Wrap with user context - all DB ops automatically audited
    return withUser({ userId: session.user.id }, () =>
      handleRequest(request, env)
    )
  }
}
```

#### Hono Middleware

```typescript
import { Hono } from 'hono'
import { withUser, getCurrentUserId } from '@dotdo/collections'

const app = new Hono()

// Auth middleware that sets up context
app.use('*', async (c, next) => {
  const user = await getUser(c.req)
  if (!user) return c.text('Unauthorized', 401)

  return withUser({ userId: user.id, tenantId: user.tenantId }, next)
})

// Routes automatically have audit context
app.post('/docs', async (c) => {
  const docs = db.collection('docs')
  const body = await c.req.json()

  await docs.put(body.id, body)  // Automatically sets createdBy/updatedBy
  return c.json({ success: true })
})
```

### Alternative: Explicit Context

For cases where AsyncLocalStorage isn't available or desired:

#### Approach 1: Factory-Level Context Provider

```typescript
const db = new Collections({
  d1: env.DB,
  context: () => ({
    userId: getCurrentUserId(),  // Your own context mechanism
    tenantId: getCurrentTenantId(),
  })
})
```

#### Approach 2: Operation-Level Context

```typescript
// Pass context per operation
await docs.put('doc1', { title: 'Hello' }, { userId: 'user123' })
await docs.putMany(items, { userId: 'user123' })
await docs.deleteMany(ids, { userId: 'user123' })
```

#### Approach 3: Scoped Collection

```typescript
// Create a scoped collection for a user session
const userDocs = docs.as({ userId: 'user123' })
await userDocs.put('doc1', { title: 'Hello' })  // Uses scoped context
```

### Implementation

```typescript
interface OperationContext {
  userId?: string
  [key: string]: unknown
}

interface CollectionOptionsWithContext extends CollectionOptions {
  context?: () => OperationContext
}

function createCollection<T>(
  sql: SqlStorage,
  name: string,
  options?: CollectionOptionsWithContext
): SyncCollection<T> {
  const getContext = options?.context ?? (() => ({}))

  return {
    put(id: string, doc: T, opContext?: OperationContext): void {
      const ctx = { ...getContext(), ...opContext }
      const now = Date.now()

      // Check if document exists for createdBy logic
      const existing = this.get(id)

      let createdBy = existing?._createdBy
      let updatedBy = ctx.userId

      if (!existing && options.audit.createdBy) {
        createdBy = ctx.userId
      }

      // ... include in INSERT/UPDATE
    },

    // Create a scoped copy with fixed context
    withContext(ctx: OperationContext): SyncCollection<T> {
      return createCollection(sql, name, {
        ...options,
        context: () => ({ ...getContext(), ...ctx })
      })
    }
  }
}
```

### Querying Audit Fields

```typescript
// Find documents created by a user
docs.find({ createdBy: 'user123' })

// Find documents modified by a user
docs.find({ updatedBy: 'user456' })

// Audit trail queries
docs.find({
  $or: [
    { createdBy: 'user123' },
    { updatedBy: 'user123' }
  ]
})
```

---

## 7. Full-Text Search

### Configuration

```typescript
const articles = createCollection<Article>(sql, 'articles', {
  storage: 'dedicated',  // Required for FTS
  fts: {
    fields: ['title', 'content', 'tags'],
    tokenizer: 'porter'  // English stemming
  }
})
```

### FTS5 Schema Generation

```typescript
function generateFTSSchema(table: string, fts: FTSOptions): string[] {
  const statements: string[] = []
  const ftsTable = `${table}_fts`

  // Create FTS5 virtual table
  // content='' means we manage content ourselves (external content)
  statements.push(`
    CREATE VIRTUAL TABLE IF NOT EXISTS ${ftsTable} USING fts5(
      ${fts.fields.join(', ')},
      content='${table}',
      content_rowid='rowid',
      tokenize='${fts.tokenizer || 'unicode61'}'
    )
  `)

  // Triggers to keep FTS in sync
  const fieldValues = fts.fields
    .map(f => `json_extract(NEW.data, '$.${f}')`)
    .join(', ')

  // After INSERT
  statements.push(`
    CREATE TRIGGER IF NOT EXISTS ${table}_fts_insert AFTER INSERT ON ${table} BEGIN
      INSERT INTO ${ftsTable}(rowid, ${fts.fields.join(', ')})
      VALUES (NEW.rowid, ${fieldValues});
    END
  `)

  // After UPDATE
  statements.push(`
    CREATE TRIGGER IF NOT EXISTS ${table}_fts_update AFTER UPDATE ON ${table} BEGIN
      UPDATE ${ftsTable} SET ${fts.fields.map(f =>
        `${f} = json_extract(NEW.data, '$.${f}')`
      ).join(', ')} WHERE rowid = NEW.rowid;
    END
  `)

  // After DELETE
  statements.push(`
    CREATE TRIGGER IF NOT EXISTS ${table}_fts_delete AFTER DELETE ON ${table} BEGIN
      DELETE FROM ${ftsTable} WHERE rowid = OLD.rowid;
    END
  `)

  return statements
}
```

### Search API

```typescript
interface SyncCollection<T> {
  // ... existing methods

  /**
   * Full-text search (requires FTS configuration)
   * @param query - FTS5 query string
   * @param options - Query options (limit, offset)
   * @returns Matching documents with relevance scores
   */
  search(query: string, options?: SearchOptions): SearchResult<T>[]
}

interface SearchOptions {
  limit?: number
  offset?: number
  highlight?: boolean  // Include highlighted snippets
  snippetLength?: number
}

interface SearchResult<T> {
  doc: T
  score: number        // BM25 relevance score
  highlights?: {       // Highlighted matches
    [field: string]: string
  }
}
```

### Search Implementation

```typescript
search(query: string, options?: SearchOptions): SearchResult<T>[] {
  if (!resolvedOptions.fts) {
    throw new Error('FTS not configured for this collection')
  }

  const ftsTable = `${tableName}_fts`
  const limit = options?.limit ?? 100
  const offset = options?.offset ?? 0

  let sql = `
    SELECT
      ${tableName}.id,
      ${tableName}.data,
      ${ftsTable}.rank as score
  `

  if (options?.highlight) {
    for (const field of resolvedOptions.fts.fields) {
      sql += `, highlight(${ftsTable}, ${resolvedOptions.fts.fields.indexOf(field)}, '<mark>', '</mark>') as hl_${field}`
    }
  }

  sql += `
    FROM ${ftsTable}
    JOIN ${tableName} ON ${tableName}.rowid = ${ftsTable}.rowid
    WHERE ${ftsTable} MATCH ?
    ORDER BY rank
    LIMIT ? OFFSET ?
  `

  const rows = this.sql.exec(sql, query, limit, offset).toArray()

  return rows.map(row => ({
    doc: { id: row.id, ...JSON.parse(row.data) },
    score: row.score,
    highlights: options?.highlight ? {
      ...Object.fromEntries(
        resolvedOptions.fts.fields.map(f => [f, row[`hl_${f}`]])
      )
    } : undefined
  }))
}
```

### MongoDB-Style $text Operator

```typescript
// Alternative: use $text in filters
articles.find({ $text: 'machine learning' })

// Combined with other filters
articles.find({
  $text: 'machine learning',
  status: 'published',
  createdAt: { $gt: lastWeek }
})
```

```typescript
// In filter compiler
function compileFilter(filter: Filter, params: unknown[]): string {
  const conditions: string[] = []

  for (const [key, value] of Object.entries(filter)) {
    if (key === '$text') {
      // FTS match
      conditions.push(`rowid IN (SELECT rowid FROM ${tableName}_fts WHERE ${tableName}_fts MATCH ?)`)
      params.push(value)
    } else {
      // ... existing filter logic
    }
  }

  return conditions.join(' AND ')
}
```

### FTS5 Query Syntax

Users can use FTS5 query syntax:

```typescript
// Simple term search
articles.search('typescript')

// Phrase search
articles.search('"machine learning"')

// Boolean operators
articles.search('typescript AND react')
articles.search('typescript OR javascript')
articles.search('typescript NOT angular')

// Field-specific search
articles.search('title:typescript content:tutorial')

// Prefix search
articles.search('type*')  // matches typescript, types, etc.

// NEAR operator
articles.search('NEAR(machine learning, 5)')  // within 5 words
```

---

## 8. JSON Path Indexes

### Configuration

```typescript
const users = createCollection<User>(sql, 'users', {
  storage: 'dedicated',
  indexes: [
    { field: 'email', unique: true },
    { field: 'status' },
    { field: 'profile.country' },
    { field: 'metadata.tier', sparse: true },
  ]
})
```

### Index Types

#### Expression Index (Simple)

```sql
CREATE INDEX users_email ON users(json_extract(data, '$.email'));
CREATE UNIQUE INDEX users_email ON users(json_extract(data, '$.email'));
```

**Pros:** Simple, no schema changes
**Cons:** Expression evaluated on every insert

#### Generated Column Index (Better Performance)

```sql
-- Add generated column
ALTER TABLE users ADD COLUMN _idx_email TEXT
  GENERATED ALWAYS AS (json_extract(data, '$.email')) STORED;

-- Index the column
CREATE UNIQUE INDEX users_email ON users(_idx_email);
```

**Pros:** Value stored, faster queries
**Cons:** Requires schema migration, storage overhead

### Implementation

```typescript
function generateIndexes(table: string, indexes: IndexConfig[]): string[] {
  const statements: string[] = []

  for (const idx of indexes) {
    const safeName = idx.field.replace(/\./g, '_')
    const indexName = `${table}_${safeName}`
    const jsonPath = `$.${idx.field}`

    // Use expression index (simpler, works everywhere)
    const unique = idx.unique ? 'UNIQUE ' : ''
    const expr = `json_extract(data, '${jsonPath}')`

    // For sparse indexes, add WHERE clause
    const where = idx.sparse
      ? ` WHERE json_extract(data, '${jsonPath}') IS NOT NULL`
      : ''

    statements.push(
      `CREATE ${unique}INDEX IF NOT EXISTS ${indexName} ON ${table}(${expr})${where}`
    )
  }

  return statements
}
```

### Query Optimization

The filter compiler can detect indexed fields:

```typescript
function compileFilter(filter: Filter, params: unknown[], options: ResolvedOptions): string {
  // Track which indexed fields are used for query planning hints
  const usedIndexes: string[] = []

  for (const [field, value] of Object.entries(filter)) {
    // Check if this field has an index
    const hasIndex = options.indexes?.some(idx => idx.field === field)
    if (hasIndex) {
      usedIndexes.push(field)
    }

    // Compile as usual
    // json_extract(data, '$.field') = ?
  }

  // SQLite will automatically use indexes on json_extract expressions
  // if they match the index definition exactly
}
```

### Compound Indexes

For queries on multiple fields:

```typescript
const orders = createCollection<Order>(sql, 'orders', {
  storage: 'dedicated',
  indexes: [
    { field: 'customerId' },
    { field: 'status' },
    // Compound index for common query pattern
    { fields: ['customerId', 'status'] },  // Future: compound index support
  ]
})
```

---

## 9. Schema Management

### Schema Versioning

```typescript
const users = createCollection<User>(sql, 'users', {
  storage: 'dedicated',
  version: 2,
  indexes: [
    { field: 'email', unique: true },
  ]
})
```

### Schema Metadata Table

```sql
CREATE TABLE IF NOT EXISTS _collection_meta (
  collection TEXT PRIMARY KEY,
  version INTEGER NOT NULL,
  options TEXT NOT NULL,  -- JSON of CollectionOptions
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
)
```

### Schema Initialization

```typescript
function initializeCollection(
  sql: SqlStorage,
  name: string,
  options: CollectionOptions
): void {
  const resolved = resolveOptions(options)

  // Check existing schema
  const existing = sql.exec<{ version: number; options: string }>(
    'SELECT version, options FROM _collection_meta WHERE collection = ?',
    name
  ).toArray()[0]

  if (existing) {
    if (existing.version !== resolved.version) {
      // Run migrations
      migrateSchema(sql, name, existing, resolved)
    }
  } else {
    // Create new schema
    const statements = generateSchema(name, resolved)
    for (const stmt of statements) {
      sql.exec(stmt)
    }

    // Record schema
    sql.exec(
      'INSERT INTO _collection_meta (collection, version, options, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
      name, resolved.version, JSON.stringify(options), Date.now(), Date.now()
    )
  }
}
```

### Schema Inspection

```typescript
interface Collections {
  // Get schema info for a collection
  schema(name: string): CollectionSchema | null

  // List all collections with their schemas
  listSchemas(): CollectionSchema[]
}

interface CollectionSchema {
  name: string
  version: number
  storage: 'shared' | 'dedicated'
  options: CollectionOptions
  indexes: string[]
  hasFTS: boolean
  documentCount: number
  sizeBytes: number
}
```

---

## 10. Migration Strategy

### Adding Indexes

```typescript
// v1: Basic collection
const users = createCollection<User>(sql, 'users', {
  storage: 'dedicated',
  version: 1,
})

// v2: Add email index
const users = createCollection<User>(sql, 'users', {
  storage: 'dedicated',
  version: 2,
  indexes: [
    { field: 'email', unique: true },
  ]
})
```

Migration automatically runs:
```sql
CREATE UNIQUE INDEX IF NOT EXISTS users_email ON users(json_extract(data, '$.email'))
```

### Adding FTS

```typescript
// v2: Add FTS
const articles = createCollection<Article>(sql, 'articles', {
  storage: 'dedicated',
  version: 2,
  fts: { fields: ['title', 'content'] }
})
```

Migration:
1. Create FTS virtual table
2. Create triggers
3. Populate FTS from existing data:
```sql
INSERT INTO articles_fts(rowid, title, content)
SELECT rowid, json_extract(data, '$.title'), json_extract(data, '$.content')
FROM articles
```

### Shared to Dedicated Migration

```typescript
// Migrate from shared to dedicated table
const users = createCollection<User>(sql, 'users', {
  storage: 'dedicated',  // Was 'shared'
  version: 2,
})
```

Migration:
```sql
-- Create dedicated table
CREATE TABLE users (id TEXT PRIMARY KEY, data TEXT NOT NULL, ...);

-- Copy data
INSERT INTO users (id, data, created_at, updated_at)
SELECT id, data, created_at, updated_at FROM _collections WHERE collection = 'users';

-- Remove from shared table
DELETE FROM _collections WHERE collection = 'users';
```

### Migration Hooks

```typescript
const users = createCollection<User>(sql, 'users', {
  version: 3,
  migrations: {
    2: (sql) => {
      // Custom migration logic for v1 -> v2
      sql.exec('UPDATE users SET data = ...')
    },
    3: (sql) => {
      // Custom migration logic for v2 -> v3
    }
  }
})
```

---

## 11. API Reference

### Collection Factory

```typescript
// DO SQLite (sync)
function createCollection<T extends Record<string, unknown>>(
  sql: SqlStorage,
  name: string,
  options?: CollectionOptions
): SyncCollection<T>

// D1 (async)
function createD1Collection<T extends Record<string, unknown>>(
  db: D1Database,
  name: string,
  options?: CollectionOptions
): AsyncCollection<T>
```

### SyncCollection Interface

```typescript
interface SyncCollection<T> {
  readonly name: string

  // Read operations
  get(id: string): T | null
  getMany(ids: string[]): Array<T | null>
  has(id: string): boolean
  count(filter?: Filter<T>): number
  keys(): string[]
  list(options?: QueryOptions): T[]
  find(filter?: Filter<T>, options?: QueryOptions): T[]

  // Write operations (relations set directly on doc)
  put(id: string, doc: T): void
  putMany(items: Array<{ id: string; doc: T }>): number
  delete(id: string): boolean
  deleteMany(ids: string[]): number
  clear(): number

  // FTS (when $fts configured)
  search(query: string, options?: SearchOptions): SearchResult<T>[]

  // Context scoping (for audit fields)
  as(context: OperationContext): SyncCollection<T>
}

interface QueryOptions {
  limit?: number
  offset?: number
  sort?: string | SortSpec[]
  // TBD: populate/include options pending spike
}
```

### AsyncCollection Interface

```typescript
interface AsyncCollection<T> {
  readonly name: string

  // Read operations (all return Promises)
  get(id: string): Promise<T | null>
  getMany(ids: string[]): Promise<Array<T | null>>
  has(id: string): Promise<boolean>
  count(filter?: Filter<T>): Promise<number>
  keys(): Promise<string[]>
  list(options?: QueryOptions): Promise<T[]>
  find(filter?: Filter<T>, options?: QueryOptions): Promise<T[]>

  // Write operations (relations set directly on doc)
  put(id: string, doc: T): Promise<void>
  putMany(items: Array<{ id: string; doc: T }>): Promise<BulkResult>
  delete(id: string): Promise<boolean>
  deleteMany(ids: string[]): Promise<BulkResult>
  clear(): Promise<BulkResult>

  // FTS (when $fts configured)
  search(query: string, options?: SearchOptions): Promise<SearchResult<T>[]>

  // Context scoping (for audit fields)
  as(context: OperationContext): AsyncCollection<T>
}
```

### Filter Types

```typescript
type Filter<T> = {
  [K in keyof T]?: T[K] | FilterOperator
} & {
  $and?: Filter<T>[]
  $or?: Filter<T>[]
  $not?: Filter<T>
  $text?: string  // FTS query
}

type FilterOperator =
  | { $eq: unknown }
  | { $ne: unknown }
  | { $gt: number }
  | { $gte: number }
  | { $lt: number }
  | { $lte: number }
  | { $in: unknown[] }
  | { $nin: unknown[] }
  | { $exists: boolean }
  | { $regex: string }
```

### Query Options

```typescript
interface QueryOptions {
  limit?: number
  offset?: number
  sort?: string | SortSpec[]
}

interface SortSpec {
  field: string
  order: 'asc' | 'desc'
}
```

---

## Implementation Phases

### Phase 1: Core Refactor
- [ ] Automatic storage detection (`import { env } from 'cloudflare:workers'`)
- [ ] Unified `Collections` class with pluggable adapters
- [ ] D1 adapter (async)
- [ ] SqlStorage adapter (sync - existing, refactored)
- [ ] Multiple named storage backends
- [ ] Tables-per-collection option

### Phase 2: Schema & Types
- [ ] IceType-style schema parser (`'string!#'`, `'int?'`, etc.)
- [ ] Type inference from schema strings
- [ ] Directive parsing (`$index`, `$fts`, `$timestamps`, `$audit`)
- [ ] Auto-diff for index/FTS changes on startup

### Phase 3: Relations
- [ ] `_rels` table for relationship storage
- [ ] Forward relations (`-> collection`)
- [ ] Backward relations (`<- collection.field`)
- [ ] `include` option for eager loading
- [ ] `.related()` method for explicit relation queries

### Phase 4: Indexing & Search
- [ ] JSON path indexes from `$index` directive
- [ ] Compound indexes
- [ ] FTS5 integration from `$fts` directive
- [ ] `search()` method with highlighting

### Phase 5: Audit & Context
- [ ] AsyncLocalStorage-based automatic context
- [ ] `withUser()` context wrapper
- [ ] `$audit` directive (createdBy/updatedBy)
- [ ] `$timestamps` directive (createdAt/updatedAt)
- [ ] `.as()` scoped collections

### Phase 6: Advanced Features
- [ ] Change hooks / notifications
- [ ] Soft deletes (`$softDelete`)
- [ ] Field-level encryption

---

## Quick Start (Target API)

```typescript
import { Collections, withUser } from '@dotdo/collections'

// 1. Define schema with icetype-style syntax
const db = new Collections({
  schema: {
    users: {
      email: 'string!#',           // required, indexed
      name: 'string',
      role: 'string = "user"',
      posts: '<- posts.author',    // reverse relation
      $fts: ['name'],
      $timestamps: true,
      $audit: true,
    },
    posts: {
      title: 'string!',
      content: 'text!',
      status: 'string = "draft"',
      author: '-> users',          // forward relation
      tags: '-> tags[]',           // many-to-many
      $fts: ['title', 'content'],
      $timestamps: true,
    },
    tags: {
      name: 'string!#',
      posts: '<- posts.tags',
    },
  }
})

// 2. Use in request handler with automatic audit context
export default {
  async fetch(request: Request) {
    const user = await authenticate(request)

    return withUser({ userId: user.id }, async () => {
      // Create a post with relations set naturally
      await db.posts.put('post1', {
        title: 'Hello World',
        content: 'My first post...',
        author: user.id,                    // relation by ID
        tags: ['typescript', 'tutorial'],   // array of tag IDs
      })

      // Relations returned as IDs
      const post = await db.posts.get('post1')
      // post.author = 'user123'
      // post.tags = ['typescript', 'tutorial']

      // Load related data manually (for now)
      const author = await db.users.get(post.author)

      // Full-text search
      const results = await db.posts.search('typescript tutorial')

      return Response.json({ post, author, results })
    })
  }
}
```

---

## Open Questions

1. **Relation Cascade**: Should deleting a document automatically handle related documents? Options:
   - `$onDelete: 'cascade'` - delete related docs
   - `$onDelete: 'set_null'` - set foreign key to null
   - `$onDelete: 'restrict'` - prevent delete if relations exist
   - Default: do nothing (leave orphaned relations in `_rels`)

2. **Soft Deletes**: Add `$softDelete` directive for `deletedAt`/`deletedBy`?

3. **Change Streams**: Should we add real-time change notifications (useful for sync/live queries)?

4. **Field Encryption**: Should we support field-level encryption for sensitive data (e.g., PII)?

5. **Cross-Storage Relations**: If you have both D1 and DO storage, should we support relations across them?

## TBD: Pending Spike

**Relation Population API** - Need performance testing and TypeScript inference testing before finalizing:
- Option A: `{ populate: true }` - boolean flag
- Option B: `{ include: ['author', 'tags'] }` - selective array
- For now: relations returned as IDs, manual loading via separate queries

## Resolved Decisions

- **Relation Setting**: Natural - set directly on document as ID or object, no separate `link()` method
- **Data Storage**: JSON in `data` column - no migrations needed for field changes
- **Schema Syntax**: IceType-style strings (`'string!#'`, `'-> users'`, etc.)

---

## Design Decisions Summary

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Storage Detection | Auto via `cloudflare:workers` | Zero-config, "just works" |
| Multiple Backends | Named storage map | Support D1 + DO + multiple DBs |
| Schema Definition | IceType-style strings (`'string!#'`) | Concise, readable, type-inferred |
| Data Storage | JSON in `data` column | No migrations for field changes |
| Relations | Separate `_rels` table | Efficient bi-directional queries |
| Sync vs Async | Separate interfaces | Keep DO sync for performance |
| Audit Context | AsyncLocalStorage | Automatic, no manual threading |
| Timestamps/Audit | Directives (`$timestamps`, `$audit`) | Opt-in per collection |
| FTS | SQLite FTS5 | Native, fast, well-supported |
| Indexes | Expression indexes on JSON | Auto-created from `$index` directive |
| Migrations | Only for indexes/FTS | Schema diff on startup |

---

## References

- [SQLite FTS5 Documentation](https://www.sqlite.org/fts5.html)
- [SQLite JSON Functions](https://www.sqlite.org/json1.html)
- [SQLite Generated Columns](https://www.sqlite.org/gencol.html)
- [Cloudflare D1 Documentation](https://developers.cloudflare.com/d1/)
- [Cloudflare Durable Objects SQLite](https://developers.cloudflare.com/durable-objects/api/sql-storage/)
- [Cloudflare Workers Environment](https://developers.cloudflare.com/workers/runtime-apis/bindings/)
- [AsyncLocalStorage](https://nodejs.org/api/async_context.html#class-asynclocalstorage)
