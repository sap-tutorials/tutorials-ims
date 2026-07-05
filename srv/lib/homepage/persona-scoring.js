//
// (#763) Deterministic persona scoring — no randomness, stable ties.
// Design §7.2.

function anyTagMatchesProfile(tags, profile) {
  if (!Array.isArray(tags) || tags.length === 0) return false;
  for (const t of tags) {
    const idx = t.indexOf(':');
    if (idx <= 0) continue;
    const field = t.slice(0, idx);
    const value = t.slice(idx + 1);
    if (profile[field] && profile[field] === value) return true;
  }
  return false;
}

export function matches(entry, profile) {
  return anyTagMatchesProfile(entry?.personaTags, profile || {});
}

export function isHidden(entry, profile) {
  return anyTagMatchesProfile(entry?.personaHidden, profile || {});
}

export function scoreEntry(entry, profile) {
  if (!matches(entry, profile)) return 0;
  return Number.isFinite(entry?.personaWeight) ? entry.personaWeight : 0;
}

function compareRanked(a, b) {
  if (b._score !== a._score) return b._score - a._score;
  const sa = a.sortOrder ?? 100;
  const sb = b.sortOrder ?? 100;
  if (sa !== sb) return sa - sb;
  return String(a.title ?? '').localeCompare(String(b.title ?? ''));
}

export function rankShelves(entries, profile) {
  const p = profile || {};
  return entries
    .filter((e) => !isHidden(e, p))
    .map((e) => ({ ...e, _score: scoreEntry(e, p) }))
    .sort(compareRanked)
    .map(({ _score, ...rest }) => rest);
}

export function rankForYou(entries, profile, { min, max }) {
  const p = profile || {};
  const kept = entries
    .filter((e) => !isHidden(e, p) && matches(e, p))
    .map((e) => ({ ...e, _score: scoreEntry(e, p) }))
    .sort(compareRanked);
  if (kept.length < min) return [];
  return kept.slice(0, max).map(({ _score, ...rest }) => rest);
}
