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
// If a new draft-enabled entity is added to AdminService, add its entry here.
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
 * Query SYS.REFERENTIAL_CONSTRAINTS for ON DELETE CASCADE FKs on draft tables.
 *
 * Pure: receives dbRun as a parameter so it can be tested without booting CAP.
 *
 * @param {(sql: string) => Promise<any[]>} dbRun
 * @returns {Promise<{ok: boolean, found: string[], missing: string[], error?: string}>}
 */
export async function checkDraftCascadeConstraints(dbRun) {
  try {
    const rows = await dbRun(
      `SELECT TABLE_NAME FROM SYS.REFERENTIAL_CONSTRAINTS` +
      ` WHERE COLUMN_NAME = 'DRAFTADMINISTRATIVEDATA_DRAFTUUID'` +
      `   AND DELETE_RULE = 'CASCADE'`
    );
    const foundSet = new Set((rows || []).map(r => String(r.TABLE_NAME).toLowerCase()));
    const found = DRAFT_TABLES.filter(t => foundSet.has(t));
    const missing = DRAFT_TABLES.filter(t => !foundSet.has(t));
    return { ok: missing.length === 0, found, missing };
  } catch (err) {
    return {
      ok: false,
      found: [],
      missing: [...DRAFT_TABLES],
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
      } else if (!result.ok) {
        log.warn(
          `[draft-integrity-preflight] cds.fiori.draft_admin_integrity is ON but` +
          ` ON DELETE CASCADE constraints are missing on HANA for` +
          ` ${result.missing.length}/${DRAFT_TABLES.length} draft tables.` +
          ` Missing: ${result.missing.join(', ')}.` +
          ` Deploy the HDI constraints (.hdbconstraint) before drafts are created` +
          ` or activated on this environment, then restart.`
        );
      } else {
        log.info(
          `[draft-integrity-preflight] draft cascade constraints verified` +
          ` (${result.found.length}/${DRAFT_TABLES.length}).`
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
