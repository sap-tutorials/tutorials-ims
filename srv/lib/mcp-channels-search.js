// srv/lib/mcp-channels-search.js
//
// MCP curated tool handler (Tier 2): search the public external-channels
// catalog — SAP and community YouTube channels, blogs, podcasts, and feeds.
// Mirrors mcp-events-search.js: anonymous surface, every caller-controlled
// input validated/clamped, and the whole thing fails open (returns []) so a DB
// hiccup never 500s an MCP client.
//
// Projection + filtering mirror the public /build/channels feed
// (srv/server.js): isPublished=true, then exclude effective linkStatus
// 'BROKEN' (override wins). Curated/internal columns (sourceId, notes, aliases,
// contentHash, ingestBatch, audit) are never surfaced.

import cds from '@sap/cds';

const LOG = cds.log('mcp-channels-search');

const VALID_OWNER_SCOPES = new Set(['sap', 'community', 'all']);

/** Array columns are native arrays on SQLite and JSON NCLOB strings on HANA. */
function parseArr(v) {
  if (Array.isArray(v)) return v;
  if (typeof v === 'string' && v) {
    try {
      const parsed = JSON.parse(v);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

/** Map a Channels row to the MCP `search_channels` wire shape. */
export function mapChannelRow(r) {
  return {
    name:        r.name || '',
    url:         r.url || '',
    purpose:     r.purpose || '',
    category:    r.category || '',
    subcategory: r.subcategory || '',
    platform:    r.platform || '',
    isSapOwned:  r.isSapOwned === true,
    ownerType:   r.ownerType || '',
    ownerName:   r.ownerName || '',
    status:      r.status || '',
    focusAreas:  parseArr(r.focusAreas),
    tags:        parseArr(r.tags),
    slug:        r.slug || '',
  };
}

/**
 * MCP curated tool handler: search the public Channels catalog.
 *
 * Facets mirror the /channels directory island (filter.ts): category and
 * platform are exact-match; ownerScope selects SAP-owned / community / all;
 * query is a case-insensitive substring match across name, purpose, and tags.
 * The tags match runs in JS because `tags` is a JSON array column (LIKE is not
 * cross-dialect safe over it), matching how /build/channels filters in JS.
 */
export async function handleSearchChannels(req) {
  const d = req.data ?? {};
  const query = typeof d.query === 'string' ? d.query.trim().toLowerCase() : '';
  const category = typeof d.category === 'string' ? d.category.trim() : '';
  const platform = typeof d.platform === 'string' ? d.platform.trim() : '';
  let ownerScope = typeof d.ownerScope === 'string' ? d.ownerScope.trim().toLowerCase() : 'all';
  if (!VALID_OWNER_SCOPES.has(ownerScope)) ownerScope = 'all';
  const limit = Math.min(Math.max(Number(d.limit) || 20, 1), 50);

  try {
    const { Channels } = cds.entities('com.sap.developers.ims');

    // isPublished seed lets every subsequent predicate chain with `.and`
    // uniformly. Works on SQLite + HANA.
    let q = SELECT.from(Channels)
      .columns('name', 'url', 'purpose', 'category', 'subcategory', 'platform',
               'isSapOwned', 'ownerType', 'ownerName', 'status',
               'focusAreas', 'tags', 'slug', 'linkStatus', 'linkStatusOverride')
      .where`isPublished = ${true}`;

    if (category) q = q.and`category = ${category}`;
    if (platform) q = q.and`platform = ${platform}`;
    if (ownerScope === 'sap') {
      q = q.and`isSapOwned = ${true}`;
    } else if (ownerScope === 'community') {
      q = q.and`(isSapOwned = ${false} or isSapOwned is null)`;
    }

    q = q.orderBy('category', 'name');

    const rows = await cds.db.run(q);

    let mapped = (rows ?? [])
      // Exclude BROKEN links (override wins), mirroring /build/channels.
      .filter((r) => (r.linkStatusOverride || r.linkStatus) !== 'BROKEN')
      .map(mapChannelRow);

    if (query) {
      mapped = mapped.filter((c) =>
        c.name.toLowerCase().includes(query) ||
        c.purpose.toLowerCase().includes(query) ||
        c.tags.some((t) => String(t).toLowerCase().includes(query)));
    }

    return mapped.slice(0, limit);
  } catch (err) {
    LOG.warn('search_channels failed:', err.message);
    return [];
  }
}
