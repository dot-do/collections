#!/usr/bin/env node
/**
 * collections.do CLI
 *
 * Command-line interface for the collections.do managed service.
 *
 * @example
 * ```bash
 * # Get user info
 * collections.do me
 *
 * # List collections in a namespace
 * collections.do list myapp
 *
 * # Get a document
 * collections.do get myapp users user1
 *
 * # Put a document
 * collections.do put myapp users user1 '{"name": "Alice"}'
 *
 * # Query a collection
 * collections.do query myapp users '{"status": "active"}'
 * ```
 */

import { Collections } from './client'

const args = process.argv.slice(2)
const command = args[0]

function printUsage() {
  console.log(`
collections.do - Managed Document Collections CLI

Usage:
  collections.do <command> [options]

Commands:
  me                                       Get user info and default namespace
  list <namespace>                         List all collections in a namespace
  get <namespace> <collection> <id>        Get a document by ID
  put <namespace> <collection> <id> <json> Create/update a document
  delete <namespace> <collection> <id>     Delete a document
  query <namespace> <collection> [filter]  Query a collection
  clear <namespace> <collection>           Clear all documents in a collection

Options:
  --url <url>      Base URL (default: https://collections.do)
  --token <token>  OAuth token for authentication
  --help           Show this help message

Environment Variables:
  COLLECTIONS_URL    Base URL
  COLLECTIONS_TOKEN  OAuth token

Namespace Access:
  Namespaces are accessed via subdomains: https://<namespace>.collections.do
  For example: https://myapp.collections.do/users/user1

Examples:
  collections.do me
  collections.do list myapp
  collections.do get myapp users user1
  collections.do put myapp users user1 '{"name": "Alice", "email": "alice@example.com"}'
  collections.do query myapp users '{"status": "active"}'
`)
}

function getArg(flag: string): string | undefined {
  const index = args.indexOf(flag)
  if (index !== -1 && args[index + 1]) {
    return args[index + 1]
  }
  return undefined
}

async function main() {
  if (!command || command === '--help' || command === '-h') {
    printUsage()
    process.exit(0)
  }

  const baseUrl = getArg('--url') || process.env['COLLECTIONS_URL'] || 'https://collections.do'
  const token = getArg('--token') || process.env['COLLECTIONS_TOKEN']

  if (!token && command !== 'me') {
    console.error('Error: Authentication token required. Set COLLECTIONS_TOKEN or use --token')
    process.exit(1)
  }

  const client = new Collections({ baseUrl, ...(token && { token }) })

  try {
    switch (command) {
      case 'me': {
        const me = await client.me()
        console.log('User:', me.user)
        break
      }

      case 'list': {
        const [, namespace] = args
        if (!namespace) {
          console.error('Usage: collections.do list <namespace>')
          process.exit(1)
        }
        const collections = await client.namespace(namespace).listCollections()
        console.log('Collections:')
        for (const name of collections) {
          console.log(`  - ${name}`)
        }
        break
      }

      case 'get': {
        const [, namespace, collection, id] = args
        if (!namespace || !collection || !id) {
          console.error('Usage: collections.do get <namespace> <collection> <id>')
          process.exit(1)
        }
        const doc = await client.namespace(namespace).collection(collection).get(id)
        if (doc) {
          console.log(JSON.stringify(doc, null, 2))
        } else {
          console.error('Document not found')
          process.exit(1)
        }
        break
      }

      case 'put': {
        const [, namespace, collection, id, json] = args
        if (!namespace || !collection || !id || !json) {
          console.error('Usage: collections.do put <namespace> <collection> <id> <json>')
          process.exit(1)
        }
        const doc = JSON.parse(json)
        await client.namespace(namespace).collection(collection).put(id, doc)
        console.log('Document saved')
        break
      }

      case 'delete': {
        const [, namespace, collection, id] = args
        if (!namespace || !collection || !id) {
          console.error('Usage: collections.do delete <namespace> <collection> <id>')
          process.exit(1)
        }
        const deleted = await client.namespace(namespace).collection(collection).delete(id)
        if (deleted) {
          console.log('Document deleted')
        } else {
          console.error('Document not found')
          process.exit(1)
        }
        break
      }

      case 'query': {
        const [, namespace, collection, filterJson] = args
        if (!namespace || !collection) {
          console.error('Usage: collections.do query <namespace> <collection> [filter]')
          process.exit(1)
        }
        const filter = filterJson ? JSON.parse(filterJson) : undefined
        const docs = await client.namespace(namespace).collection(collection).find(filter)
        console.log(JSON.stringify(docs, null, 2))
        break
      }

      case 'clear': {
        const [, namespace, collection] = args
        if (!namespace || !collection) {
          console.error('Usage: collections.do clear <namespace> <collection>')
          process.exit(1)
        }
        const result = await client.namespace(namespace).collection(collection).clear()
        console.log(`Cleared ${result.count} documents`)
        break
      }

      default:
        console.error(`Unknown command: ${command}`)
        printUsage()
        process.exit(1)
    }
  } catch (error) {
    console.error('Error:', error instanceof Error ? error.message : error)
    process.exit(1)
  }
}

main()
