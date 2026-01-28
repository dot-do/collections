/**
 * API Key Cache Utilities
 *
 * Provides cache management for API key validation with size limits
 * to prevent unbounded memory growth.
 */

/**
 * User from auth service
 */
export interface AuthUser {
  id: string
  email?: string
  name?: string
  image?: string
  org?: string
  roles?: string[]
  permissions?: string[]
}

export interface CachedApiKey {
  user: AuthUser
  expiresAt: number
}

// API key validation cache with automatic cleanup
// Expired entries are cleaned up probabilistically (1% of requests)
// to avoid memory leaks while minimizing overhead
export const apiKeyCache: Map<string, CachedApiKey> = new Map()
export const MAX_CACHE_SIZE = 10000
export const API_KEY_CACHE_TTL = 5 * 60 * 1000 // 5 minutes

/**
 * Hash an API key for cache lookup
 * Uses a simple but fast hash - security comes from HTTPS and short TTL
 */
export async function hashApiKey(apiKey: string): Promise<string> {
  const encoder = new TextEncoder()
  const data = encoder.encode(apiKey)
  const hashBuffer = await crypto.subtle.digest('SHA-256', data)
  const hashArray = Array.from(new Uint8Array(hashBuffer))
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('')
}

/**
 * Set an API key cache entry, evicting oldest entries if cache is full
 * Map maintains insertion order, so we delete from the beginning
 */
export function setApiKeyCacheEntry(keyHash: string, entry: CachedApiKey): void {
  // If key already exists, delete it first to update its position (LRU-like behavior)
  if (apiKeyCache.has(keyHash)) {
    apiKeyCache.delete(keyHash)
  }

  // Evict oldest entries if cache is at capacity
  while (apiKeyCache.size >= MAX_CACHE_SIZE) {
    const oldestKey = apiKeyCache.keys().next().value
    if (oldestKey) {
      apiKeyCache.delete(oldestKey)
    }
  }

  apiKeyCache.set(keyHash, entry)
}

/**
 * Clean up expired cache entries
 * Called probabilistically to avoid overhead on every request
 */
export function cleanupExpiredEntries(): void {
  const now = Date.now()
  for (const [key, value] of apiKeyCache.entries()) {
    if (value.expiresAt <= now) {
      apiKeyCache.delete(key)
    }
  }
}
