// srv/lib/tag-md-format.js
//
// Markdown-format derivation for IMS Tags (#824). Mirrors the Java IMS
// canonical algorithm from `com.sap.developers.ims.util.TagUtil#textToMdFormat`:
//
//   "Path"                                   → "path"
//   "Path : Second path"                     → "path>second-path"
//   "Path : Second path / Third Long (Path)" → "path>third-long--path-"
//   null / ""                                → ""
//
// Rules: split on `:` or `/`, take FIRST and LAST segments, trim each,
// replace every non-[A-Za-z0-9] run-of-one with `-`, lowercase, join with `>`.
// A titlePath with no separator returns just the single transformed segment.
//
// `mdFormat` is declared `virtual` on `ims.Tags`, so it never round-trips
// through the database — each service that projects Tags must register its
// own `after('READ', 'Tags')` handler that calls applyMdFormat() to populate
// the column. AdminService and AuthorService both do. Without this, OData
// reads return an undefined mdFormat (the Sage tag-search regression that
// motivated this helper).
//
// Issue #824 / parity with com.sap.developers.ims.util.TagUtil.

const SEPARATOR_REGEX = /[:/]/;
const NON_ALPHANUMERIC_REGEX = /[^A-Za-z\d]/g;

function normalizeSegment(segment) {
  return segment.trim().replace(NON_ALPHANUMERIC_REGEX, '-').toLowerCase();
}

/**
 * Convert a tag's titlePath into the legacy IMS markdown-ready key.
 *
 * @param {string|null|undefined} titlePath
 * @returns {string} The mdFormat key, or '' for null/empty input.
 */
export function titlePathToMdFormat(titlePath) {
  if (!titlePath) return '';
  const parts = titlePath.split(SEPARATOR_REGEX);
  if (parts.length === 1) return normalizeSegment(parts[0]);
  const first = normalizeSegment(parts[0]);
  const last = normalizeSegment(parts[parts.length - 1]);
  return `${first}>${last}`;
}

/**
 * Mutate Tags result rows in-place, attaching the computed mdFormat virtual.
 * Designed to be the body of an `after('READ', 'Tags')` handler so both
 * AdminService and AuthorService stay symmetric.
 *
 * @param {object|object[]} rows  A single row or an array of rows.
 */
export function applyMdFormat(rows) {
  for (const row of Array.isArray(rows) ? rows : [rows]) {
    if (row && typeof row === 'object') {
      row.mdFormat = titlePathToMdFormat(row.titlePath);
    }
  }
}
