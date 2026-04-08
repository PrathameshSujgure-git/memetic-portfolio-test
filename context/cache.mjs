// Simple in-memory cache with TTL for GitHub file reads
const cache = new Map();
const TTL = 5 * 60 * 1000; // 5 minutes

export function getCache(key) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > TTL) {
    cache.delete(key);
    return null;
  }
  return entry.value;
}

export function setCache(key, value) {
  if (value === null) {
    cache.delete(key);
    return;
  }
  cache.set(key, { value, ts: Date.now() });
}

export function clearCache() {
  cache.clear();
}

export function cacheStats() {
  return { entries: cache.size };
}
