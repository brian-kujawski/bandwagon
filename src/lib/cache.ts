/**
 * A small in-process cache with per-entry expiry.
 *
 * Saves repeat API calls within a process. The shows themselves also go into
 * the local co-bill store (db.ts), which is what recommendations read.
 */
export class TtlCache<V> {
  private entries = new Map<string, { value: V; expires: number }>();
  // Plain fields rather than constructor parameter properties: scripts run
  // this file through Node's type stripping, which doesn't support those.
  private ttlMs: number;
  private maxEntries: number;

  constructor(ttlMs: number, maxEntries = 500) {
    this.ttlMs = ttlMs;
    this.maxEntries = maxEntries;
  }

  get(key: string): V | undefined {
    const hit = this.entries.get(key);
    if (!hit) return undefined;
    if (hit.expires <= Date.now()) {
      this.entries.delete(key);
      return undefined;
    }
    return hit.value;
  }

  set(key: string, value: V): void {
    if (this.entries.size >= this.maxEntries) {
      // Map keeps insertion order, so the first key is the oldest.
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
    this.entries.set(key, { value, expires: Date.now() + this.ttlMs });
  }

  async getOrLoad(key: string, load: () => Promise<V>): Promise<V> {
    const hit = this.get(key);
    if (hit !== undefined) return hit;
    const value = await load();
    this.set(key, value);
    return value;
  }
}
