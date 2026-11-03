// srv/lib/draft-integrity-preflight.js
//
// #2968: startup preflight that verifies HANA ON DELETE CASCADE constraints
// exist on every draft table before the runtime serves with
// cds.fiori.draft_admin_integrity: true.
//
// cds build generates one FK constraint per draft-enabled entity:
//   DRAFTADMINISTRATIVEDATA_DRAFTUUID -> DraftAdministrativeData(DraftUUID)
//   ON DELETE CASCADE
// If those constraints are missing on HANA, the runtime's optimised draft
// deletion (activate / root-cancel) deletes only the DraftAdministrativeData
// row and the DB does NOT cascade the child draft rows — producing orphaned
// draft rows.
//
// This check is HANA-only, fail-open, and guarded by a globalThis sentinel
// so it fires once per process even when cds.on('served') re-fires under
// cds.test() across multiple test files.

// Authoritative list of draft-enabled entity table names (lowercase).
// Source: all entities with @odata.draft.enabled: true in AdminService,
// mapped to their underlying HANA table name (dots → underscores + _drafts).
// DEPRECATED — no longer used by checkDraftCascadeConstraints, which now
// discovers the real `ADMINSERVICE_<ENTITY>_DRAFTS` tables from SYS.TABLES at
// runtime. These `com_sap_developers_ims_*_drafts` names never matched any
// deployed table (the check reported them all "missing" and validated nothing).
// Retained only for the existing unit test's import; safe to delete once that
// test is updated.
export const DRAFT_TABLES = [
  'com_sap_developers_ims_tutorials_drafts',
  'com_sap_developers_ims_missions_drafts',
  'com_sap_developers_ims_groups_drafts',
  'com_sap_developers_ims_puzzles_drafts',
  'com_sap_developers_ims_gridtemplates_drafts',
  'com_sap_developers_ims_petoberfests_drafts',
  'com_sap_developers_ims_events_drafts',
  'com_sap_developers_ims_prizes_drafts',
  'com_sap_developers_ims_accomplishments_drafts',
  'com_sap_developers_ims_featuredtasks_drafts',
  'com_sap_developers_ims_alerts_drafts',
  'com_sap_developers_ims_homepageshelves_drafts',
  'com_sap_developers_ims_channels_drafts',
  'com_sap_developers_ims_channelcollections_drafts',
  'com_sap_developers_ims_channeltopicmap_drafts',
  'com_sap_developers_ims_legacyredirects_drafts',
  'com_sap_developers_ims_homepageconfig_drafts',
  'com_sap_developers_ims_verbdefinitions_drafts',
  'com_sap_developers_ims_shelfdefinitions_drafts',
  'com_sap_developers_ims_communityblogsources_drafts',
  'com_sap_developers_ims_communityblogposts_drafts',
  'com_sap_developers_ims_homepageforyoucandidates_drafts',
  'com_sap_developers_ims_devtoberfestconfig_drafts',
  'com_sap_developers_ims_advocates_drafts',
  'com_sap_developers_ims_homepagefeaturedtopics_drafts',
  'com_sap_developers_ims_external_videos_drafts',
];

/**
 * Returns true only when connected to a HANA database.
 * Exported for test isolation.
 * @param {object} cds
 * @returns {boolean}
 */
export function isHanaKind(cds) {
  return cds?.db?.options?.kind === 'hana';
}

/**
 * Query SYS.REFERENTIAL_CONSTRAINTS for ON DELETE CASCADE FKs on draft tables,
 * comparing against the draft tables ACTUALLY present in the schema.
 *
 * The real draft shadow tables are named `ADMINSERVICE_<ENTITY>_DRAFTS`
 * (service-prefixed, uppercased) — NOT the entity-DB names. An earlier
 * hardcoded `com_sap_developers_ims_*_drafts` list never matched any real
 * table, so the check silently reported 26/26 "missing" and validated nothing.
 * We now discover the draft tables from SYS.TABLES at runtime so the list can
 * never drift out of sync with the deployed schema.
 *
 * Pure: receives dbRun as a parameter so it can be tested without booting CAP.
 *
 * @param {(sql: string) => Promise<any[]>} dbRun
 * @returns {Promise<{ok: boolean, found: string[], missing: string[], total: number, error?: string}>}
 */
export async function checkDraftCascadeConstraints(dbRun) {
  try {
    // 1. Discover the draft tables that actually exist in this schema, and
    //    that carry the DraftAdministrativeData FK column (i.e. real draft
    //    shadow tables, not child comps without the FK).
    const draftTableRows = await dbRun(
      `SELECT c.TABLE_NAME FROM SYS.TABLE_COLUMNS c` +
      `  JOIN SYS.TABLES t ON t.SCHEMA_NAME = c.SCHEMA_NAME AND t.TABLE_NAME = c.TABLE_NAME` +
      ` WHERE c.SCHEMA_NAME = CURRENT_SCHEMA` +
      `   AND c.TABLE_NAME LIKE '%\\_DRAFTS' ESCAPE '\\'` +
      `   AND c.COLUMN_NAME = 'DRAFTADMINISTRATIVEDATA_DRAFTUUID'`
    );
    const draftTables = (draftTableRows || []).map(r => String(r.TABLE_NAME).toUpperCase());

    // 2. Which of those have an ON DELETE CASCADE FK on the DraftUUID column.
    const cascadeRows = await dbRun(
      `SELECT TABLE_NAME FROM SYS.REFERENTIAL_CONSTRAINTS` +
      ` WHERE COLUMN_NAME = 'DRAFTADMINISTRATIVEDATA_DRAFTUUID'` +
      `   AND DELETE_RULE = 'CASCADE'`
    );
    const cascadeSet = new Set((cascadeRows || []).map(r => String(r.TABLE_NAME).toUpperCase()));

    const found = draftTables.filter(t => cascadeSet.has(t));
    const missing = draftTables.filter(t => !cascadeSet.has(t));
    return { ok: missing.length === 0, found, missing, total: draftTables.length };
  } catch (err) {
    return {
      ok: false,
      found: [],
      missing: [],
      total: 0,
      error: err?.message ?? String(err),
    };
  }
}

/**
 * Register a cds.on('served') handler that runs checkDraftCascadeConstraints
 * once at startup on HANA. Fail-open: any error is logged as WARN, never thrown.
 *
 * @param {object} cds  The @sap/cds module
 */
export function wireDraftIntegrityPreflight(cds) {
  cds.on('served', async () => {
    if (globalThis.__draftIntegrityPreflightRegistered) return;
    globalThis.__draftIntegrityPreflightRegistered = true;

    if (!isHanaKind(cds)) return;

    const log = cds.log('draft-integrity-preflight');
    try {
      const result = await checkDraftCascadeConstraints((sql) => cds.db.run(sql));
      if (result.error) {
        log.warn(
          `[draft-integrity-preflight] DB error querying SYS.REFERENTIAL_CONSTRAINTS (fail-open):`,
          result.error
        );
      } else if (result.total === 0) {
        log.warn(
          `[draft-integrity-preflight] no draft shadow tables with a` +
          ` DraftAdministrativeData FK were found in the schema — cannot verify` +
          ` cascade constraints. If drafts are expected, check the schema name.`
        );
      } else if (!result.ok) {
        log.warn(
          `[draft-integrity-preflight] cds.fiori.draft_admin_integrity is ON but` +
          ` ON DELETE CASCADE constraints are missing on HANA for` +
          ` ${result.missing.length}/${result.total} draft tables.` +
          ` Missing: ${result.missing.join(', ')}.` +
          ` Deploy the HDI constraints (.hdbconstraint) before drafts are created` +
          ` or activated on this environment, then restart.`
        );
      } else {
        log.info(
          `[draft-integrity-preflight] draft cascade constraints verified` +
          ` (${result.found.length}/${result.total}).`
        );
      }
    } catch (err) {
      cds.log('draft-integrity-preflight').warn(
        `[draft-integrity-preflight] unexpected error (fail-open):`,
        err?.message ?? err
      );
    }
  });
}
