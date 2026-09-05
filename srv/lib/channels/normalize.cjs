'use strict';
const crypto = require('node:crypto');

// Strip trailing "[cite: N]" style markers (and any trailing whitespace).
function cleanCitations(text) {
  if (!text) return text;
  return String(text).split('[cite')[0].replace(/\s+$/, '');
}

const OWNER_TYPE_MAP = {
  'sap official': 'SAP_Official',
  'sap developer advocate': 'SAP_Developer_Advocate',
  'sap executive': 'SAP_Executive',
  'community member': 'Community_Member',
  'community organization': 'Community_Organization',
  'user group': 'User_Group',
  'third-party training': 'Third_party_Training',
  'third-party media': 'Third_party_Media',
  'third-party platform': 'Third_party_Platform',
};
function normalizeOwnerType(raw) {
  if (!raw) return null;
  return OWNER_TYPE_MAP[String(raw).trim().toLowerCase()] ?? null;
}

// Map free-text status → enum, carrying any parenthetical / qualifier as a note.
function normalizeStatus(raw) {
  if (!raw) return { status: 'Active', note: null };
  const s = String(raw).trim();
  const lower = s.toLowerCase();
  if (lower.startsWith('entering eol') || lower === 'eol') return { status: 'EOL', note: s === 'EOL' ? null : s };
  if (lower.startsWith('active')) {
    const m = s.match(/\((.+)\)/);
    return { status: 'Active', note: m ? m[1].trim() : null };
  }
  if (lower.startsWith('archiv')) return { status: 'Archived', note: null };
  if (lower.startsWith('closed')) return { status: 'Closed', note: null };
  if (lower.startsWith('discontinu')) return { status: 'Discontinued', note: null };
  return { status: 'Active', note: s };
}

// Coerce an approximate count ("~1.4K", "3,200", "1.7K", 806) to an integer.
// The research dataset gives GitHub-star counts as human-readable approximations;
// the Channels.githubStars/subscribers columns are Integer. Returns null when
// there is nothing parseable.
function parseApproxCount(raw) {
  if (raw == null) return null;
  if (typeof raw === 'number') return Number.isFinite(raw) ? Math.round(raw) : null;
  const s = String(raw).trim().replace(/^~/, '').replace(/,/g, '');
  const m = s.match(/^([0-9]*\.?[0-9]+)\s*([kKmMbB]?)$/);
  if (!m) return null;
  const mult = { '': 1, k: 1e3, m: 1e6, b: 1e9 }[m[2].toLowerCase()];
  return Math.round(parseFloat(m[1]) * mult);
}

// Hash only the source (dataset-owned) fields, order-independent.
function computeContentHash(sourceFields) {
  const canonical = JSON.stringify(sourceFields, Object.keys(sourceFields).sort());
  return crypto.createHash('sha256').update(canonical).digest('hex');
}

// Converts a channel name to a kebab-case URL slug.
// Lowercases, collapses all non-alphanumeric runs to a single '-', trims ends.
function toKebabSlug(name) {
  return String(name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// Returns a unique kebab slug. Appends -2, -3, … on collision.
// When seenSlugs is undefined (single-channel mode), dedup is skipped.
function generateSlug(name, seenSlugs) {
  const base = toKebabSlug(name);
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

function normalizeChannel(raw, ingestBatch, seenSlugs) {
  const { status, note } = normalizeStatus(raw.status);
  const purpose = cleanCitations(raw.purpose);
  const notesParts = [cleanCitations(raw.notes), note].filter(Boolean);
  const feedUrl = raw.feed ? String(raw.feed).trim() : null;
  const source = {
    name: raw.name, url: raw.url,
    relatedUrls: raw.related_urls ?? [],
    aliases: raw.aliases ?? [],
    purpose, notes: notesParts.join(' — ') || null,
    ownerName: raw.owner ?? raw.owner_name ?? null,
    ownerType: normalizeOwnerType(raw.owner_type),
    isSapOwned: raw.isSapOwned === true,
    category: raw.category ?? null,
    subcategory: raw.subcategory ?? null,
    platform: raw.platform ?? null,
    status,
    focusAreas: raw.focus_areas ?? [],
    tags: raw.tags ?? [],
    updateFrequency: raw.update_frequency ?? null,
    githubStars: parseApproxCount(raw.github_stars),
    subscribers: parseApproxCount(raw.subscribers),
    feedUrl,
  };
  // slug is generated from name — not part of the content hash (dedup suffix must
  // not trigger a content-hash mismatch on re-ingest of an unchanged record).
  const slug = generateSlug(raw.name, seenSlugs);
  return { sourceId: raw.id, ...source, contentHash: computeContentHash(source), ingestBatch, slug };
}

module.exports = { cleanCitations, normalizeOwnerType, normalizeStatus, parseApproxCount, computeContentHash, toKebabSlug, generateSlug, normalizeChannel };
