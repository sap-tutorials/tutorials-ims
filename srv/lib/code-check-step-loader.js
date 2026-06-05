// srv/lib/code-check-step-loader.js
// Loads published tutorial content from HANA / SQLite ContentFiles,
// decompresses it, strips HTML tags, and returns plain text for the
// code-check LLM prompt.
//
// Step-level granularity is a TODO for Phase 4 — for the spike, the full
// tutorial body is returned and capped at PLAIN_TEXT_CAP chars.
//
// Returns null on any error so the dispatcher's safeCall handles it gracefully.

import cds from '@sap/cds';
import { gunzipSync } from 'node:zlib';
import { Readable } from 'node:stream';

const LOG = cds.log('code-check');

/** Hard cap on plain-text length returned to the LLM (chars). */
const PLAIN_TEXT_CAP = 3000;

const NAMESPACE = 'com.sap.developers.ims';

// ---------------------------------------------------------------------------
// Internal helpers (mirrors content-store.js patterns)
// ---------------------------------------------------------------------------

/** Convert stream / Buffer / raw data to a Buffer. */
async function toBuffer(data) {
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof Readable) {
    const chunks = [];
    for await (const chunk of data) chunks.push(chunk);
    return Buffer.concat(chunks);
  }
  return Buffer.from(data);
}

/** Derive the HANA table name from the namespace. */
function hanaTableName() {
  return `${NAMESPACE.replace(/\./g, '_').toUpperCase()}_CONTENTFILES`;
}

/** Get the current ACTIVE manifest version. Returns null if none. */
async function getActiveVersion() {
  const { ContentManifest } = cds.entities(NAMESPACE);
  const [row] = await SELECT.from(ContentManifest)
    .where({ status: 'ACTIVE' })
    .columns('version');
  return row?.version ?? null;
}

/** Strip HTML tags and collapse whitespace to a single plain-text string. */
function stripHtml(html) {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// ---------------------------------------------------------------------------
// defaultLoadStepText
// ---------------------------------------------------------------------------

/**
 * Load the published tutorial content for `slug` from ContentFiles,
 * decompress, strip HTML tags, and return plain text capped at PLAIN_TEXT_CAP.
 *
 * Step-level slicing (honoring `stepNumber`) is a TODO — full-tutorial body
 * is acceptable for the spike (Phase 1 of #171).
 *
 * @param {string}  slug        - Tutorial slug (lowercase canonical).
 * @param {number} _stepNumber  - Step number (reserved; unused for the spike).
 * @returns {Promise<string|null>} Plain text or null on any error.
 */
export async function defaultLoadStepText(slug, _stepNumber) {
  try {
    const { ContentFiles } = cds.entities(NAMESPACE);

    const activeVersion = await getActiveVersion();
    if (activeVersion === null) {
      // debug-level: a totally empty content publish is unusual but recoverable;
      // it's not an error. The fact that no version is active is captured by
      // /content/hashes anyway.
      LOG.debug('code-check-step-loader: no active content version');
      return null;
    }

    // Read metadata first (hash + mimeType) — same pattern as serveHandler.
    const [meta] = await SELECT.from(ContentFiles)
      .where({ slug: slug.toLowerCase(), version: activeVersion })
      .columns('contentHash', 'mimeType', 'version');

    if (!meta) {
      // debug-level: routine miss for unpublished slugs (typos, stale chat
      // history, etc). Real DB errors land in the catch block at warn.
      LOG.debug('code-check-step-loader: no ContentFiles row for slug', slug);
      return null;
    }

    // Read BLOB separately — HANA LOB locators expire before consumption when
    // mixed with non-BLOB columns in the same CDS QL query.  Raw SQL returns a
    // Buffer directly on HANA; CDS QL works fine on SQLite (unit tests).
    const db = await cds.connect.to('db');
    let contentBuf;
    if (db.options?.kind === 'hana' || db.constructor?.name === 'HANAService') {
      const [blobRow] = await db.run(
        `SELECT TOP 1 "CONTENT" FROM "${hanaTableName()}" WHERE "SLUG" = ? AND "VERSION" = ?`,
        [slug.toLowerCase(), meta.version]
      );
      contentBuf = blobRow?.CONTENT;
    } else {
      const blobRow = await SELECT.one.from(ContentFiles)
        .where({ slug: slug.toLowerCase(), version: meta.version })
        .columns('content');
      contentBuf = blobRow?.content ? await toBuffer(blobRow.content) : null;
    }

    if (!contentBuf) {
      LOG.warn('code-check-step-loader: BLOB null for slug', slug);
      return null;
    }

    // Decompress (same gunzipSync pattern as serveHandler in content-store.js)
    const decompressed = gunzipSync(contentBuf);
    const html = decompressed.toString('utf-8');

    // Strip tags and cap
    const plain = stripHtml(html);
    return plain.length > PLAIN_TEXT_CAP ? plain.slice(0, PLAIN_TEXT_CAP) : plain;

  } catch (err) {
    // Defensive — never let step-loader errors surface as unhandled rejections.
    LOG.warn('code-check-step-loader: error loading step text', {
      slug,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}
