//
// (#763) Static persona → verb-order map. Not admin-editable in v1 —
// verb order is a strong design choice. Design §7.1.
// (#1029) MODEL slotted between INTEGRATE and OPERATE in base order.
// Per-role tilts extended by inserting 'model' at a sensible position
// for each persona — architects lean on it heavily, sysadmins less so.

export const BASE_ORDER = Object.freeze(
  ['learn', 'build', 'integrate', 'model', 'operate', 'ai', 'connect']
);

const ROLE_TILT = Object.freeze({
  developer: ['build', 'learn', 'integrate', 'ai', 'model', 'operate', 'connect'],
  architect: ['integrate', 'model', 'build', 'operate', 'learn', 'ai', 'connect'],
  sysadmin:  ['operate', 'integrate', 'build', 'model', 'connect', 'learn', 'ai'],
  student:   ['learn', 'build', 'ai', 'integrate', 'model', 'connect', 'operate'],
});

function heaviestUnique(counts) {
  if (!counts) return null;
  let best = null, bestCount = -Infinity, tie = false;
  for (const [verb, n] of Object.entries(counts)) {
    if (n > bestCount) { best = verb; bestCount = n; tie = false; }
    else if (n === bestCount) { tie = true; }
  }
  if (bestCount <= 0 || tie) return null;
  return best;
}

export function computeVerbOrder(profile, tagCountsPerVerb) {
  const p = profile || {};
  const order = ROLE_TILT[p.role] ? [...ROLE_TILT[p.role]] : [...BASE_ORDER];

  const heavy = heaviestUnique(tagCountsPerVerb);
  if (heavy) {
    const idx = order.indexOf(heavy);
    if (idx >= 2) {
      // Swap with the neighbor above.
      [order[idx - 1], order[idx]] = [order[idx], order[idx - 1]];
    }
  }
  return order;
}
