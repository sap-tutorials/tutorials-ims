// srv/lib/servable-slugs.js
//
// #2631 — shared content-presence gate for anonymous MCP tutorial search.
//
// Soft-deleting a tutorial flips Tutorials.status to INACTIVE (the row and its
// embeddings are kept — see srv/admin-service.js), and a slug can also fall out
// of the latest content publish without any status change. In both cases the
// website serve path 404s because there is no servable BLOB, but the search
// surfaces trusted only the metadata (the Tutorials row / SearchableItems view)
// and still returned a /tutorials/<slug> link that now 404s (the Joule Desktop
// "broken link" bug). ContentCurrent is the single source of truth the serve
// path uses: one row per slug that currently has servable HTML.
//
// filterServableSlugs() takes the candidate slugs and returns the subset that
// still has a ContentCurrent row, so both search tools can drop the rest.
//
// Dual dialect (mirrors srv/lib/semantic-search.js):
//   - HANA: raw db.run with quoted-uppercase identifiers.
//   - SQLite (unit tests): raw db.run against the lowercase table.
// The IN list is chunked (same HANA bound-param packet concern as the tag
// filters in srv/search-service.js). Fail-open: on ANY error we return every
// input slug, so a backfill gap or DB hiccup never blanks search results — the
// same fail-open contract the semantic-search module already follows.

import cds from '@sap/cds';

const LOG = cds.log('servable-slugs');

const HANA_TABLE = 'COM_SAP_DEVELOPERS_IMS_CONTENTCURRENT';
const SQLITE_TABLE = 'com_sap_developers_ims_ContentCurrent';
// Keep each IN list well under any HANA bound-param packet limit.
const CHUNK = 500;

function isHana(db) {
  return db?.kind === 'hana' || db?.options?.kind === 'hana' || db?.constructor?.name === 'HANAService';
}

/**
 * Return the subset of `slugs` that currently has servable content in
 * ContentCurrent, as a Set (lowercased, matching how both callers compare).
 *
 * @param {object} db     cds.db (or a compatible { run, kind }).
 * @param {string[]} slugs Candidate slugs (any case; compared case-insensitively).
 * @returns {Promise<Set<string>>} Present slugs. On error, ALL input slugs (fail-open).
 */
export async function filterServableSlugs(db, slugs) {
  const list = [...new Set((slugs || []).map((s) => (s || '').toLowerCase()).filter(Boolean))];
  if (!list.length) return new Set();

  try {
    const table = isHana(db) ? `"${HANA_TABLE}"` : SQLITE_TABLE;
    const col = isHana(db) ? '"SLUG"' : 'slug';
    const present = new Set();
    for (let i = 0; i < list.length; i += CHUNK) {
      const chunk = list.slice(i, i + CHUNK);
      const placeholders = chunk.map(() => '?').join(',');
      const sql = `SELECT ${col} AS "slug" FROM ${table} WHERE LOWER(${col}) IN (${placeholders})`;
      const rows = await db.run(sql, chunk);
      for (const r of rows || []) {
        const s = (r.slug ?? r.SLUG ?? '').toLowerCase();
        if (s) present.add(s);
      }
    }
    return present;
  } catch (err) {
    LOG.warn('content-presence check failed; failing open (keeping all slugs):', err.message);
    return new Set(list);
  }
}
