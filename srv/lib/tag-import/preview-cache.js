// SCALING CAVEAT: This cache is in-memory and scoped to a single srv instance.
// If tutorials-srv is ever scaled to >1 instance, commitTagImport will return 410
// (preview expired) on any call routed to a different instance. Move this to a
// HANA-backed table or a shared Redis if/when horizontal scaling lands.

export class PreviewCache {
  constructor({ ttlMs = 5 * 60 * 1000, maxEntries = 20 } = {}) {
    this._ttlMs = ttlMs;
    this._maxEntries = maxEntries;
    this._store = new Map();
  }

  set(token, value) {
    if (this._store.size >= this._maxEntries) {
      const oldest = this._store.keys().next().value;
      this._store.delete(oldest);
    }
    this._store.set(token, { value, expiresAt: Date.now() + this._ttlMs });
  }

  get(token) {
    const entry = this._store.get(token);
    if (!entry) return undefined;
    if (entry.expiresAt <= Date.now()) {
      this._store.delete(token);
      return undefined;
    }
    return entry.value;
  }

  size() {
    return this._store.size;
  }
}

export const sharedCache = new PreviewCache();
