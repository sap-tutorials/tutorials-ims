// ESM module — the project's package.json has "type": "module" so the
// native Node loader (which CAP runtime uses) treats this as ESM.

const MAX_SLUG_LEN = 64;
const FALLBACK_SLUG = 'advocate';
const COMBINING_MARKS = /[̀-ͯ]/g;

function normalize(s) {
  return (s || '')
    .normalize('NFD')
    .replace(COMBINING_MARKS, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function deriveSlug(firstName, lastName) {
  const fn = normalize(firstName);
  const ln = normalize(lastName);
  let slug = [fn, ln].filter(Boolean).join('-');
  if (!slug) slug = FALLBACK_SLUG;
  if (slug.length > MAX_SLUG_LEN) {
    slug = slug.slice(0, MAX_SLUG_LEN).replace(/-+$/, '');
  }
  return slug;
}

export function suffixOnCollision(base, takenSet) {
  if (!takenSet.has(base)) return base;
  let n = 2;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const suffix = '-' + n;
    const room = MAX_SLUG_LEN - suffix.length;
    const candidate = base.length > room
      ? base.slice(0, room).replace(/-+$/, '') + suffix
      : base + suffix;
    if (!takenSet.has(candidate)) return candidate;
    n += 1;
  }
}
