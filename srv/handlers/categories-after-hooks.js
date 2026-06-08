// srv/handlers/categories-after-hooks.js
//
// Fire-and-forget categorization after CRUD on Missions/Groups/Tutorials.
// INSERT → classify immediately (1s smear so the after-handler returns fast).
// UPDATE → reclassify only if title/description/primaryTag changed,
//          debounced 5s per item to collapse draft-activation PATCH storms.

import cds from '@sap/cds';
import { classifyAndPersist } from '../lib/category-classifier.js';

const LOG = cds.log('categories-after-hooks');
const DEBOUNCE_MS = 5000;
const RECLASSIFY_FIELDS = new Set(['title', 'description', 'primaryTag']);

export function decideOnUpdate(diff) {
  if (!diff || typeof diff !== 'object') return 'skip';
  for (const k of Object.keys(diff)) {
    if (RECLASSIFY_FIELDS.has(k)) return 'reclassify';
  }
  return 'skip';
}

export function makeDebouncedDispatcher({ delayMs = DEBOUNCE_MS, run }) {
  const timers = new Map(); // key: `${kind}:${id}` → timeoutId
  return function dispatch(kind, id) {
    const key = `${kind}:${id}`;
    const prev = timers.get(key);
    if (prev) clearTimeout(prev);
    const t = setTimeout(() => { timers.delete(key); run(kind, id); }, delayMs);
    timers.set(key, t);
  };
}

const dispatcher = makeDebouncedDispatcher({
  run: (kind, id) => {
    classifyAndPersist(kind, id).catch(e =>
      LOG.warn(`after-hook classify failed for ${kind}/${id}: ${e.message}`)
    );
  },
});

export function register(srv) {
  // INSERT — classify immediately on next tick.
  for (const [entity, kind] of [['Missions', 'mission'], ['Groups', 'group'], ['Tutorials', 'tutorial']]) {
    srv.after('CREATE', entity, async (data) => {
      const id = data?.ID;
      if (!id) return;
      setImmediate(() => {
        classifyAndPersist(kind, id).catch(e =>
          LOG.warn(`INSERT classify failed for ${kind}/${id}: ${e.message}`)
        );
      });
    });
    srv.after('UPDATE', entity, async (data, req) => {
      const id = data?.ID || req.data?.ID;
      if (!id) return;
      let diff = null;
      try { diff = await req.diff?.(); } catch { /* swallow */ }
      if (decideOnUpdate(diff) === 'reclassify') dispatcher(kind, id);
    });
  }
}
