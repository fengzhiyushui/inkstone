// Per-client, bounded memory cache. Cache hints never authorize sharing across
// servers or credentials; even public/server scope stays in this client only.
export const CAPABILITY_CACHE_LIMITS = Object.freeze({
  maxEntries: 64, maxBytes: 2 * 1024 * 1024, maxTtlMs: 5 * 60 * 1000
});

export function createCapabilityCache({ now = Date.now, ...limits } = {}) {
  const cfg = { ...CAPABILITY_CACHE_LIMITS, ...limits };
  const entries = new Map();
  let bytes = 0;

  function remove(key) {
    const entry = entries.get(key);
    if (entry) { bytes -= entry.bytes; entries.delete(key); }
  }

  function prune() {
    for (const [key, entry] of entries) if (entry.expiresAt <= now()) remove(key);
  }

  function get(key) {
    prune();
    const entry = entries.get(key);
    if (!entry) return null;
    entries.delete(key);
    entries.set(key, entry);
    return JSON.parse(entry.json);
  }

  function set(key, value, { ttlMs, cacheScope } = {}) {
    remove(key);
    prune();
    if (!Number.isFinite(ttlMs) || ttlMs <= 0 || cacheScope === "none" || cacheScope === "request") return;
    if (cacheScope != null && typeof cacheScope !== "string") return;
    const json = JSON.stringify(value);
    const size = Buffer.byteLength(json, "utf8");
    if (size > cfg.maxBytes) return;
    while (entries.size && (entries.size >= cfg.maxEntries || bytes + size > cfg.maxBytes)) remove(entries.keys().next().value);
    entries.set(key, { json, bytes: size, expiresAt: now() + Math.min(ttlMs, cfg.maxTtlMs) });
    bytes += size;
  }

  function clear() { entries.clear(); bytes = 0; }
  function size() { prune(); return entries.size; }
  return { get, set, clear, size };
}
