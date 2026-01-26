# @dotdo/collections

MongoDB-style document store on Durable Object SQLite.

## Features

- Named collections (like MongoDB)
- CRUD operations: get, put, delete, has
- MongoDB-style filter queries ($eq, $ne, $gt, $gte, $lt, $lte, $in, $nin, $exists, $regex, $and, $or)
- Query options: limit, offset, sort
- Type-safe with full TypeScript support
- SQL injection protection for field names
- In-memory implementation for testing

## Installation

```bash
pnpm add @dotdo/collections
```

## Usage

### Inside a Durable Object

```typescript
import { createCollection, Collections } from '@dotdo/collections'

interface User {
  name: string
  email: string
  age: number
  active: boolean
}

export class MyDO extends DurableObject {
  users = createCollection<User>(this.ctx.storage.sql, 'users')

  async createUser(id: string, data: User) {
    this.users.put(id, data)
  }

  async getUser(id: string) {
    return this.users.get(id)
  }

  async getActiveUsers() {
    return this.users.find({ active: true })
  }

  async getAdultUsers() {
    return this.users.find({ age: { $gte: 18 } })
  }
}
```

### Collections Manager

For managing multiple collections:

```typescript
import { Collections } from '@dotdo/collections'

export class MyDO extends DurableObject {
  collections = new Collections(this.ctx.storage.sql)

  async example() {
    const users = this.collections.collection<User>('users')
    const products = this.collections.collection<Product>('products')

    // Get all collection names
    const names = this.collections.names()

    // Get stats for all collections
    const stats = this.collections.stats()

    // Drop a collection
    this.collections.drop('temp')
  }
}
```

### In-Memory Collection for Testing

```typescript
import { createMemoryCollection, MemoryCollection } from '@dotdo/collections'

// Using factory function
const users = createMemoryCollection<User>()

// Or using class directly
const products = new MemoryCollection<Product>()

// Same API as SQL-backed collections
users.put('user1', { name: 'Alice', email: 'alice@example.com', age: 30, active: true })
const user = users.get('user1')
```

## API

### Collection Interface

```typescript
interface Collection<T> {
  // Read operations
  get(id: string): T | null
  has(id: string): boolean
  find(filter?: Filter<T>, options?: QueryOptions): T[]
  count(filter?: Filter<T>): number
  list(options?: QueryOptions): T[]
  keys(): string[]

  // Write operations
  put(id: string, doc: T): void
  delete(id: string): boolean
  clear(): number
  putMany(docs: Array<{ id: string; doc: T }>): number  // Bulk insert/update
  deleteMany(ids: string[]): number  // Bulk delete
}
```

### Bulk Operations

```typescript
// Insert or update multiple documents at once
const count = users.putMany([
  { id: 'user1', doc: { name: 'Alice', email: 'alice@example.com', age: 30, active: true } },
  { id: 'user2', doc: { name: 'Bob', email: 'bob@example.com', age: 25, active: true } },
  { id: 'user3', doc: { name: 'Charlie', email: 'charlie@example.com', age: 35, active: false } },
])
console.log(`Inserted ${count} documents`)  // 3

// Delete multiple documents by ID
const deleted = users.deleteMany(['user1', 'user3'])
console.log(`Deleted ${deleted} documents`)  // 2
```

### Filter Operators

```typescript
// Equality
{ field: value }                  // Implicit equality
{ field: { $eq: value } }         // Explicit equality
{ field: { $ne: value } }         // Not equal

// Comparison (numeric)
{ field: { $gt: number } }        // Greater than
{ field: { $gte: number } }       // Greater than or equal
{ field: { $lt: number } }        // Less than
{ field: { $lte: number } }       // Less than or equal

// Array membership
{ field: { $in: [values] } }      // In array
{ field: { $nin: [values] } }     // Not in array

// Existence
{ field: { $exists: boolean } }   // Field exists/doesn't exist

// Pattern matching
{ field: { $regex: 'pattern' } }  // Regex match

// Logical operators
{ $and: [filter1, filter2] }      // All conditions must match
{ $or: [filter1, filter2] }       // Any condition must match
```

### Query Options

```typescript
interface QueryOptions {
  limit?: number    // Maximum results
  offset?: number   // Skip N results
  sort?: string     // Sort field (prefix with - for descending)
}

// Examples
collection.find({ active: true }, { limit: 10 })
collection.find({}, { sort: 'name' })           // Ascending
collection.find({}, { sort: '-createdAt' })     // Descending
collection.find({}, { limit: 10, offset: 20 })  // Pagination
```

### Type Guards

```typescript
import {
  isFilterOperator,
  isEqOperator,
  isNeOperator,
  isGtOperator,
  isGteOperator,
  isLtOperator,
  isLteOperator,
  isInOperator,
  isNinOperator,
  isExistsOperator,
  isRegexOperator,
} from '@dotdo/collections'

if (isFilterOperator(value)) {
  // value is a FilterOperator
}
```

### Utility Functions

```typescript
import { validateFieldName, escapeSql } from '@dotdo/collections'

// Validate field names (throws on invalid)
validateFieldName('user.name')  // OK
validateFieldName("'; DROP TABLE")  // Throws!

// Escape SQL values
escapeSql("O'Brien")  // "O''Brien"
```

## Security

The library includes SQL injection protection:

- Field names are validated against `/^[\w.]+$/` pattern
- All values are passed as parameterized queries
- The `escapeSql` function provides additional escaping for string values

## License

MIT
