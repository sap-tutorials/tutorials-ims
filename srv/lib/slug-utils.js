// Shared slug derivation helpers for admin-managed entities (Missions, Groups).
//
// Contract: produce slugs matching the same shape content-store.js validates
// for tutorials — /^[a-z0-9][a-z0-9-]*$/ — so a Group/Mission slug can be
// safely composed into URLs like /tutorials/group-<slug> or used as a HANA
// primary-key fragment.

const FALLBACK_SLUG = 'item';

// Common transliterations NFKD won't handle on its own (German eszett, AE/OE
// ligatures, etc.). Keep the list short — over-transliterating produces
// surprising slugs.
const TRANSLITERATIONS = [
  [/ß/g, 'ss'],
  [/æ/g, 'ae'],
  [/œ/g, 'oe'],
  [/ø/g, 'o'],
  [/ð/g, 'd'],
  [/þ/g, 'th'],
];

export function slugify(input) {
  if (input === null || input === undefined) return FALLBACK_SLUG;
  let s = String(input).toLowerCase();
  for (const [re, repl] of TRANSLITERATIONS) s = s.replace(re, repl);
  const stripped = s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')   // strip combining diacritics
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!stripped) return FALLBACK_SLUG;
  return stripped.slice(0, 200);
}

// Resolve slug collisions by appending -2, -3, ... until unique.
//
// `existing` is a Set of slugs already taken (caller's responsibility to
// pass the right scope — e.g. all Group slugs when deriving for a new Group).
// `selfSlug` is the entity's current slug (if any) — passed so an UPDATE that
// doesn't change the title doesn't pointlessly bump itself.
export function ensureUniqueSlug(base, existing, selfSlug = null) {
  if (selfSlug && base === selfSlug) return base;
  if (!existing.has(base)) return base;
  let n = 2;
  while (existing.has(`${base}-${n}`)) n++;
  return `${base}-${n}`;
}
