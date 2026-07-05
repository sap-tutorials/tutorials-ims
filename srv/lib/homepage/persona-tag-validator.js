// srv/lib/homepage/persona-tag-validator.js
//
// (#763) Save-time validator for HomepageShelves.personaTags /
// personaHidden and HomepageForYouCandidates.personaTags / personaHidden.
// Source of truth is srv/lib/branch/profile-fields.js — no duplication.
// Design §5.3.

import { PROFILE_VOCAB } from '../branch/profile-fields.js';

// Flatten { field: [v1, v2] } into ['field:v1', 'field:v2'].
export const KNOWN_TAGS = Object.entries(PROFILE_VOCAB).flatMap(
  ([field, values]) => values.map((v) => `${field}:${v}`)
);
const KNOWN = new Set(KNOWN_TAGS);

export function validateTags(tags) {
  if (!Array.isArray(tags)) return { ok: false, invalid: [String(tags)] };
  const invalid = tags.filter((t) => !KNOWN.has(t));
  return invalid.length === 0 ? { ok: true } : { ok: false, invalid };
}
