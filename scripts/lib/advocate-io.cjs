'use strict';

/**
 * Shared helpers for scripts/export-advocates.cjs and scripts/import-advocates.cjs.
 *
 * Lives in CommonJS (.cjs) so both scripts can `require()` it directly even
 * though the repo's package.json declares "type": "module". Kept zero-dep
 * and HANA-free so it can be unit-tested without a DB.
 *
 * The table-info resolver mirrors srv/lib/_tutorials-table.js so both
 * scripts speak the right SQL dialect on either side of `cds bind --exec`.
 */

const SCHEMA_VERSION = 1;

const VALID_REGIONS = new Set(['AMERICAS', 'EMEA', 'APJ']);

// Mirrors the enum in db/advocates.cds (AdvocateLinks.kind).
const VALID_LINK_KINDS = new Set([
  'LinkedIn', 'X', 'Mastodon', 'BlueSky', 'GitHub',
  'YouTube', 'Blog', 'SapCommunity', 'Email', 'Other',
]);

function assertSchemaVersion(payload) {
  if (!payload || typeof payload.schemaVersion === 'undefined') {
    throw new Error(
      'advocates.json is missing schemaVersion - refusing to import. ' +
      'Re-run scripts/export-advocates.cjs against the source DB to regenerate.'
    );
  }
  if (payload.schemaVersion !== SCHEMA_VERSION) {
    throw new Error(
      `advocates.json schemaVersion ${payload.schemaVersion} is not compatible (expected ${SCHEMA_VERSION}). ` +
      `This script supports v${SCHEMA_VERSION} payloads only.`
    );
  }
}

/**
 * @param {object|null} db - the cds.db handle, OR null/undefined
 * @returns {boolean} true when the active DB is SAP HANA
 *
 * Mirrors the check used in srv/lib/advocate-photo-store.js. We don't trust
 * db.kind to be cased consistently across CAP versions.
 */
function isHanaDb(db) {
  if (!db) return false;
  return (db.kind || '').toLowerCase() === 'hana';
}

/**
 * Returns table and column identifiers correctly cased for the active DB.
 *
 * HANA case rules (learned the hard way in PR #404):
 *   - HDI-deployed tables are stored UPPERCASE in HANA's catalog.
 *   - Unquoted identifiers in SQL are folded to UPPERCASE by the parser,
 *     so unquoted UPPERCASE works.
 *   - Quoted lowercase ("com_sap_developers_ims_Advocates") FAILS with
 *     "Could not find table/view" because HANA preserves case in quoted form.
 *   - We therefore emit unquoted UPPERCASE table/column names for HANA.
 *   - Column aliases that need mixed-case JS keys (e.g. `userEmail`) MUST
 *     be quoted: `SELECT U.EMAIL AS "userEmail"`. Otherwise HANA returns
 *     the alias UPPERCASED and the JS property lookup breaks.
 *
 * SQLite (unit/local) rules:
 *   - CDS emits tables with dots-to-underscores, preserving the original
 *     mixed case (e.g. com_sap_developers_ims_Advocates).
 *   - Columns are stored in their original CDS casing (e.g. firstName).
 *   - Identifiers can stay unquoted in raw SQL.
 *
 * @param {boolean} isHana
 * @returns {{
 *   advocates: string, topics: string, links: string, photos: string,
 *   users: string, tags: string,
 *   cols: object
 * }}
 */
function advocateTableInfo(isHana) {
  if (isHana) {
    return {
      advocates: 'COM_SAP_DEVELOPERS_IMS_ADVOCATES',
      topics:    'COM_SAP_DEVELOPERS_IMS_ADVOCATETOPICS',
      links:     'COM_SAP_DEVELOPERS_IMS_ADVOCATELINKS',
      photos:    'COM_SAP_DEVELOPERS_IMS_ADVOCATEPHOTOS',
      users:     'COM_SAP_DEVELOPERS_IMS_USERS',
      tags:      'COM_SAP_DEVELOPERS_IMS_TAGS',
      cols: {
        id: 'ID', slug: 'SLUG',
        firstName: 'FIRSTNAME', lastName: 'LASTNAME',
        title: 'TITLE', pronouns: 'PRONOUNS', location: 'LOCATION', region: 'REGION',
        bio: 'BIO', isActive: 'ISACTIVE', sortOverride: 'SORTOVERRIDE',
        joinedDate: 'JOINEDDATE',
        hasPhoto: 'HASPHOTO', photoUpdatedAt: 'PHOTOUPDATEDAT', photoUrl: 'PHOTOURL',
        userFk: 'USER_ID', advocateFk: 'ADVOCATE_ID', tagFk: 'TAG_ID',
        // Tags has no `slug` column — the path-style identifier
        // (e.g. 'software-product>sap-build') lives in Tags.name.
        // Kept as a separate dict key so the column-name quirk is
        // isolated here and the JS-side payload key stays `tagSlug`.
        // Cross-ref: srv/routes/advocates-public.js maps tag.name -> {slug, label}.
        tagSlugCol: 'NAME',
        kind: 'KIND', url: 'URL', label: 'LABEL', sortOrder: 'SORTORDER',
        email: 'EMAIL', createdAt: 'CREATEDAT',
        photo256: 'PHOTO256', photo64: 'PHOTO64', photoMimeType: 'PHOTOMIMETYPE',
        sizeBytes: 'SIZEBYTES', sha256: 'SHA256', uploadedAt: 'UPLOADEDAT',
      },
    };
  }
  // SQLite — CDS-emitted mixed-case names.
  return {
    advocates: 'com_sap_developers_ims_Advocates',
    topics:    'com_sap_developers_ims_AdvocateTopics',
    links:     'com_sap_developers_ims_AdvocateLinks',
    photos:    'com_sap_developers_ims_AdvocatePhotos',
    users:     'com_sap_developers_ims_Users',
    tags:      'com_sap_developers_ims_Tags',
    cols: {
      id: 'ID', slug: 'slug',
      firstName: 'firstName', lastName: 'lastName',
      title: 'title', pronouns: 'pronouns', location: 'location', region: 'region',
      bio: 'bio', isActive: 'isActive', sortOverride: 'sortOverride',
      joinedDate: 'joinedDate',
      hasPhoto: 'hasPhoto', photoUpdatedAt: 'photoUpdatedAt', photoUrl: 'photoUrl',
      userFk: 'user_ID', advocateFk: 'advocate_ID', tagFk: 'tag_ID',
      tagSlugCol: 'name',
      kind: 'kind', url: 'url', label: 'label', sortOrder: 'sortOrder',
      email: 'email', createdAt: 'createdAt',
      photo256: 'photo256', photo64: 'photo64', photoMimeType: 'photoMimeType',
      sizeBytes: 'sizeBytes', sha256: 'sha256', uploadedAt: 'uploadedAt',
    },
  };
}

module.exports = {
  SCHEMA_VERSION,
  VALID_REGIONS,
  VALID_LINK_KINDS,
  assertSchemaVersion,
  isHanaDb,
  advocateTableInfo,
};
