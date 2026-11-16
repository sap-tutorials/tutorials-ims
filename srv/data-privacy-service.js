// srv/data-privacy-service.js
//
// Handler for DataPrivacyService -- GDPR/DPI local data-subject export.
//
// Implements the exportDataSubject(userId) function:
//   1. Looks up the Users row by ID (404 if absent).
//   2. Builds a JSON envelope: { exportedAt, exportedBy, subject, sections }.
//      - subject: the 9 @PersonalData.IsPotentiallyPersonal fields on Users.
//      - sections: one entry per @PersonalData entity (excluding Users itself),
//        projected to personalFields + resolving FK + createdAt/modifiedAt.
//   3. Handles the nested marker for DeveloperEnvironmentLinks (tab_ID cannot
//      be resolved without a DB query -- see resolver docs).
//   4. Emits a fail-open audit event for action 'DataSubjectExport'.
//
// Reuses:
//   - srv/lib/anonymization-cascade.js  getCascadePlan
//   - srv/lib/data-subject-resolver.js  resolveSubjectKeys
//   - srv/lib/audit-event.js            createAuditEmitter

import cds from '@sap/cds';
import { getCascadePlan }     from './lib/anonymization-cascade.js';
import { resolveSubjectKeys } from './lib/data-subject-resolver.js';
import { createAuditEmitter } from './lib/audit-event.js';

const LOG = cds.log('data-privacy-service');

// The 9 @PersonalData.IsPotentiallyPersonal fields on ims.Users.
// Kept as an explicit list so the subject block is stable even if the model
// gains new fields in future (the export is intentionally opt-in, not catch-all).
const USER_PERSONAL_FIELDS = [
  'firstName', 'lastName', 'email', 'displayName',
  'sapId', 'khorosId', 'khorosLogin', 'khorosAvatarUrl', 'uuid',
];

// Additional columns to project alongside personalFields in each section row.
const SECTION_META_COLS = ['createdAt', 'modifiedAt'];

export default class DataPrivacyService extends cds.ApplicationService {
  async init() {
    this.on('exportDataSubject', this._handleExport.bind(this));
    return super.init();
  }

  async _handleExport(req) {
    const { userId } = req.data;

    // -- 1. Look up Users row -----------------------------------------------
    // cds.model can be null in vitest+CDS on Windows; fall back to cds.db.model.
    const definitions = (cds.model ?? cds.db?.model)?.definitions;
    if (!definitions) {
      return req.reject(500, 'CDS model not available');
    }

    const { Users } = cds.entities('com.sap.developers.ims');
    const user = await SELECT.one.from(Users).where({ ID: userId });
    if (!user) {
      return req.reject(404, `User not found: ${userId}`);
    }

    // -- 2. Build subject block (9 personal fields) -------------------------
    const subject = {};
    for (const f of USER_PERSONAL_FIELDS) {
      subject[f] = user[f] ?? null;
    }

    // -- 3. Walk the cascade plan and collect sections ----------------------
    const plan = getCascadePlan(definitions);
    const sections = [];

    // Identify entity names that will be output as nested parents (from the
    // nested marker in the resolver). These must be skipped in the direct loop
    // to avoid duplicating them -- the nested handler outputs them instead.
    const nestedParents = new Set();
    for (const entry of plan) {
      if (entry.action === 'skip') continue;
      const resolved = await resolveSubjectKeys(user, entry);
      if (resolved?.nested && resolved.via) {
        // resolved.via is the short name; find the fully-qualified entity name.
        for (const name of Object.keys(definitions)) {
          if (name.endsWith(`.${resolved.via}`) || name === resolved.via) {
            nestedParents.add(name);
            break;
          }
        }
      }
    }

    for (const entry of plan) {
      const { entityName, action, personalFields } = entry;

      // Skip entries with no valid cascade action.
      if (action === 'skip') continue;

      // Skip the Users/DataSubject root entity -- it becomes the subject block
      // above, not a section.
      if (entry.dataSubjectField === 'ID') continue;

      // Skip entities that will be output as nested parents (handled below).
      if (nestedParents.has(entityName)) continue;

      // Resolve the WHERE condition for this entity.
      const resolved = await resolveSubjectKeys(user, entry);
      if (!resolved) continue; // resolver returned null -- unresolvable, skip

      // Handle nested marker (DeveloperEnvironmentLinks).
      if (resolved.nested) {
        const section = await this._fetchNestedLinks(user, entry, personalFields);
        if (section) sections.push(section);
        continue;
      }

      // Normal case: SELECT rows projected to personalFields + FK + meta.
      const { column, values } = resolved;
      const rows = await this._selectRows(entityName, column, values, personalFields);
      sections.push({ entity: entityName, count: rows.length, rows });
    }

    // -- 4. Emit audit event (fail-open) ------------------------------------
    // createAuditEmitter is already fail-open; binding may be null in unit tests.
    const auditBinding = await cds.connect.to('audit-log').catch(() => null);
    const audit = createAuditEmitter(auditBinding, LOG);
    await audit('DataSubjectExport', {
      subjectId: userId,
      by: req.user?.id ?? 'unknown',
    });

    // -- 5. Assemble and return the envelope --------------------------------
    const doc = {
      exportedAt: new Date().toISOString(),
      exportedBy: req.user?.id ?? 'unknown',
      subject,
      sections,
    };
    return JSON.stringify(doc);
  }

  // Select rows for a direct-FK entity, projected to relevant columns.
  // Filters out columns that do not exist on the entity (some entities use
  // non-standard keys or do not have the 'managed' aspect).
  async _selectRows(entityName, column, values, personalFields) {
    if (!values || values.length === 0) return [];
    const definitions = (cds.model ?? cds.db?.model)?.definitions;
    const entityDef = definitions?.[entityName];
    const elements = entityDef?.elements ?? {};
    // Build projection from columns that actually exist on this entity.
    const candidates = ['ID', column, ...personalFields, ...SECTION_META_COLS];
    const cols = [...new Set(candidates.filter((c) => c in elements))];
    if (cols.length === 0) return [];
    const rows = await SELECT.from(entityName).columns(cols).where(`${column} in`, values);
    return rows;
  }

  // Handle the nested marker for DeveloperEnvironmentLinks.
  // Step 1: fetch the subject's DeveloperEnvironmentTabs rows.
  // Step 2: for each Tab, fetch its DeveloperEnvironmentLinks.
  // Returns a section for DeveloperEnvironmentTabs with links nested inside.
  async _fetchNestedLinks(user, entry, _personalFields) {
    // entry is the DeveloperEnvironmentLinks plan entry.
    // Query DeveloperEnvironmentTabs first.
    const TABS_ENTITY  = 'com.sap.developers.ims.DeveloperEnvironmentTabs';
    const LINKS_ENTITY = entry.entityName; // com.sap.developers.ims.DeveloperEnvironmentLinks

    const tabCols = [...new Set(['ID', 'user_ID', 'tabName', 'tabOrder'])];
    const tabRows = await SELECT.from(TABS_ENTITY)
      .columns(tabCols)
      .where({ user_ID: user.ID });

    if (!tabRows.length) {
      return { entity: TABS_ENTITY, count: 0, rows: [] };
    }

    const tabIds = tabRows.map((t) => t.ID);

    // Fetch all links for these tabs in one query.
    const linkCols = [...new Set(['ID', 'tab_ID', 'title', 'url', 'linkOrder'])];
    const allLinks = await SELECT.from(LINKS_ENTITY)
      .columns(linkCols)
      .where(`tab_ID in`, tabIds);

    // Group links by tab_ID.
    const linksByTab = {};
    for (const link of allLinks) {
      (linksByTab[link.tab_ID] ??= []).push(link);
    }

    // Attach links array to each tab row.
    const enrichedTabRows = tabRows.map((t) => ({
      ...t,
      links: linksByTab[t.ID] ?? [],
    }));

    return {
      entity: TABS_ENTITY,
      count:  enrichedTabRows.length,
      rows:   enrichedTabRows,
    };
  }
}
