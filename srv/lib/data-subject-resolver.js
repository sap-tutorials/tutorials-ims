/**
 * srv/lib/data-subject-resolver.js
 *
 * Shared data-subject key resolver for GDPR/DPI local export and anonymization cascade.
 *
 * Given a `Users` row and a `getCascadePlan()` entry, returns the WHERE column
 * and candidate values needed to SELECT that subject's rows in a given entity.
 *
 * Pure module — no `cds` import, no DB access. `async` is kept on
 * `resolveSubjectKeys` so callers can await it uniformly (future proofing).
 *
 * ### Nested marker (DeveloperEnvironmentLinks)
 *
 * DeveloperEnvironmentLinks links to DeveloperEnvironmentTabs via `tab_ID`.
 * The resolver cannot produce tab IDs without a DB query, so it returns a
 * nested marker instead of resolved values:
 *
 *   { column: 'tab_ID', values: null, nested: true, via: 'DeveloperEnvironmentTabs' }
 *
 * Task-4 (export handler) and Task-5 (anonymization cascade fix) MUST check
 * for `result.nested === true` and:
 *   1. Query `DeveloperEnvironmentTabs` for rows where `user_ID = user.ID`
 *   2. Collect the resulting `ID` values
 *   3. Then query `DeveloperEnvironmentLinks` where `tab_ID IN (<ids>)`
 *
 * The exact shape of this marker is load-bearing for those consumers — do not
 * change the field names without updating both callers.
 */

/**
 * Return the candidate XSUAA/IAS login claim values for a `Users` row.
 *
 * `AuthorAiRequests.authorId` holds `req.user.id` (the XSUAA login claim).
 * Across the codebase that claim is matched against `Users.sapId` (primary),
 * with a documented divergence that for some providers the claim may be stored
 * in `Users.uuid` instead (see `srv/lib/devtoberfest-registration.js:22`).
 *
 * @param {object} user  Full `Users` row ({ ID, sapId, uuid, ... })
 * @returns {string[]}   Filtered list of non-null candidate id strings
 */
export function authorIdCandidates(user) {
  return [user.sapId, user.uuid].filter(Boolean);
}

/**
 * Map a `Users` row + a cascade plan entry to { column, values } for WHERE
 * filtering, or `null` when the entry cannot / should not be queried.
 *
 * @param {object} user       Full `Users` row ({ ID, sapId, uuid, ... })
 * @param {object} planEntry  Entry from `getCascadePlan()`:
 *                            { entityName, action, dataSubjectField, personalFields }
 * @returns {Promise<object|null>}
 *   null                                        — entry is skip/unresolvable
 *   { column, values: string[] }                — normal direct FK case
 *   { column, values: null, nested, via }       — nested case (DeveloperEnvironmentLinks)
 */
export async function resolveSubjectKeys(user, planEntry) {
  const { entityName, action, dataSubjectField } = planEntry;

  // Skip entries — action explicitly skipped, or no data-subject field identified
  if (action === 'skip' || !dataSubjectField) {
    return null;
  }

  // Users entity (DataSubject root) — key is the UUID PK
  // Match on entityName suffix OR on dataSubjectField === 'ID' (the DataSubjectID element)
  if (dataSubjectField === 'ID') {
    return { column: 'ID', values: [user.ID] };
  }

  // AuthorAiRequests — authorId holds the XSUAA login claim (NOT the user UUID)
  if (dataSubjectField === 'authorId') {
    return { column: 'authorId', values: authorIdCandidates(user) };
  }

  // DeveloperEnvironmentLinks — linked via parent DeveloperEnvironmentTabs (tab_ID)
  // Cannot resolve without a DB query; return a nested marker for the caller to handle.
  if (dataSubjectField === 'tab_ID') {
    return {
      column: 'tab_ID',
      values: null,
      nested: true,
      via: 'DeveloperEnvironmentTabs'
    };
  }

  // Default: direct user FK column (e.g. user_ID, created_by, etc.)
  return { column: dataSubjectField, values: [user.ID] };
}
