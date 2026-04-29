const _store = new Map();

export function cached(key, ttlMs, fn) {
  const entry = _store.get(key);
  if (entry && Date.now() < entry.expires) return entry.value;

  const value = fn();
  if (value && typeof value.then === 'function') {
    return value.then(result => {
      _store.set(key, { value: result, expires: Date.now() + ttlMs });
      return result;
    });
  }
  _store.set(key, { value, expires: Date.now() + ttlMs });
  return value;
}

export function invalidate(keyPrefix) {
  for (const key of _store.keys()) {
    if (key.startsWith(keyPrefix)) _store.delete(key);
  }
}
