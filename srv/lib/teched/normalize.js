// srv/lib/teched/normalize.js
//
// Pure transforms for the TechEd RainFocus ingest (issue #2312, Unit F).
// ESM (package.json "type":"module"). Imported directly by vitest unit tests
// and via dynamic import() from scripts/seed-teched.cjs.
//
// Contract mirrors srv/lib/channels/normalize.cjs:
//   - computeContentHash hashes SOURCE-owned fields ONLY, order-independent.
//   - generateSlug produces a kebab-case slug with -2/-3 collision suffixes.
//   - slug is assigned ONCE (first time a sourceId is seen) and reused verbatim
//     on re-ingest, so it is deliberately NOT part of the content hash.
import crypto from 'node:crypto';
import { slugify } from '../slug-utils.js';

// Hash only the source (RainFocus-owned) fields, order-independent.
// Arrays are sorted before hashing so speaker-order churn upstream does not
// flip the hash. Undefined/null are normalized so shape changes don't churn.
//
// NB: we deliberately do NOT reuse srv/lib/channels/normalize.cjs
// computeContentHash — that one sorts object KEYS but not ARRAY ELEMENTS and
// doesn't fold undefined→null, so it would churn on speakerSourceIds reorder
// (exactly what TechEd sessions need to be stable against).
export function computeContentHash(sourceFields) {
  const normalized = {};
  for (const k of Object.keys(sourceFields)) {
    let v = sourceFields[k];
    if (Array.isArray(v)) v = [...v].map((x) => (x == null ? '' : String(x))).sort();
    else if (v === undefined) v = null;
    normalized[k] = v;
  }
  const canonical = JSON.stringify(normalized, Object.keys(normalized).sort());
  return crypto.createHash('sha256').update(canonical).digest('hex');
}

// Converts a name/code to a kebab-case URL slug. Delegates to the shared
// slugify (NFKD + eszett/ligature transliteration + 200-char cap) so accented
// TechEd titles / speaker names ("José Müller") produce clean ASCII slugs.
// slugify returns 'item' for empty/undefined input.
export function toKebabSlug(value) {
  const s = slugify(value);
  return s === 'item' ? '' : s;
}

// Returns a unique kebab slug. Appends -2, -3, … on collision.
// When seenSlugs is undefined (single-record mode), dedup is skipped.
export function generateSlug(value, seenSlugs) {
  const base = toKebabSlug(value) || 'item';
  if (!seenSlugs || !seenSlugs.has(base)) {
    if (seenSlugs) seenSlugs.add(base);
    return base;
  }
  let n = 2;
  while (seenSlugs.has(`${base}-${n}`)) n++;
  const slug = `${base}-${n}`;
  seenSlugs.add(slug);
  return slug;
}

function assignSlug(seed, seenSlugs, existingSlug) {
  return existingSlug || generateSlug(seed, seenSlugs);
}

// raw session (fetcher output shape) → upsert row.
// speakerSourceIds / trackSourceId are carried through for link resolution in
// the seed; they are part of the content hash but not TechEdSessions columns.
export function normalizeSession(raw, seenSlugs, existingSlug) {
  const speakerSourceIds = Array.isArray(raw.speakerSourceIds)
    ? raw.speakerSourceIds.filter(Boolean).map(String)
    : [];
  const source = {
    venue: raw.venue ?? null,
    sessionCode: raw.sessionCode ?? null,
    title: raw.title ?? null,
    abstract: raw.abstract ?? null,
    scheduledStart: raw.scheduledStart ?? null,
    scheduledEnd: raw.scheduledEnd ?? null,
    room: raw.room ?? null,
    youtubeUrl: raw.youtubeUrl ?? null,
    url: raw.url ?? null,
    trackSourceId: raw.trackSourceId ?? null,
    speakerSourceIds,
  };
  const slug = assignSlug(raw.sessionCode || raw.title, seenSlugs, existingSlug);
  return {
    sourceId: String(raw.sourceId),
    ...source,
    contentHash: computeContentHash(source),
    slug,
  };
}

export function normalizeSpeaker(raw, seenSlugs, existingSlug) {
  const source = {
    name: raw.name ?? null,
    title: raw.title ?? null,
    company: raw.company ?? null,
    bio: raw.bio ?? null,
    photoUrl: raw.photoUrl ?? null,
  };
  const slug = assignSlug(raw.name || raw.sourceId, seenSlugs, existingSlug);
  return { sourceId: String(raw.sourceId), ...source, contentHash: computeContentHash(source), slug };
}

export function normalizeTrack(raw, seenSlugs, existingSlug) {
  const source = {
    name: raw.name ?? null,
    venue: raw.venue ?? null,
    description: raw.description ?? null,
  };
  const slug = assignSlug(raw.name || raw.sourceId, seenSlugs, existingSlug);
  return { sourceId: String(raw.sourceId), ...source, contentHash: computeContentHash(source), slug };
}
