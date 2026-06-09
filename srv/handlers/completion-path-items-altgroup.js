// srv/handlers/completion-path-items-altgroup.js
//
// Issue #172 — refuse incoherent alt-group shapes before they hit the DB.
// Wired onto AdminService.CompletionPathItems and AdminService.GroupPathItems
// `before('CREATE'|'UPDATE')` in srv/admin-service.js.
//
// Per PR 2 plan reviewer addendum:
//   - Item F: resolve entities at call-time (inside the closure), not at registration
//   - Item G: enforceMultiMember=false on CREATE (admins create members one at a time
//     in Fiori; rejecting the first one blocks normal authoring). UPDATE enforces.

import { parseCondition, ConditionParseError } from '../lib/branch/condition.js';

export class AltGroupValidationError extends Error {
  constructor(message) { super(message); this.name = 'AltGroupValidationError'; }
}

/**
 * Validate one path-item against the rest of its path's items.
 *
 * @param {object} item            — the item being created/updated
 * @param {object[]} siblings      — items in the same path; the CDS handler appends
 *                                   `item` itself, so the validator sees the full
 *                                   set of peers (the multi-member check is
 *                                   `peers.length < 2`, where peers includes `item`)
 * @param {object} [options]
 * @param {boolean} [options.enforceMultiMember=true] — when false, skip the
 *   "alt-group needs ≥ 2 members" check (addendum G — CREATE flow).
 */
export function validateAltGroupItem(item, siblings, options = {}) {
  const { enforceMultiMember = true } = options;

  if (!item.altGroupKey) return; // linear backbone — nothing to check

  if (!item.altGroupLabel || !item.altGroupLabel.trim()) {
    throw new AltGroupValidationError(
      `altGroupLabel is required when altGroupKey is set (item path=${item.path_ID} order=${item.itemOrder} key=${item.altGroupKey})`
    );
  }

  if (item.altCondition) {
    try { parseCondition(item.altCondition); }
    catch (err) {
      if (err instanceof ConditionParseError) {
        throw new AltGroupValidationError(
          `altCondition does not parse: ${err.message} (path=${item.path_ID} order=${item.itemOrder})`
        );
      }
      throw err;
    }
  }

  if (!enforceMultiMember) return; // addendum G — CREATE flow skips peer-count check

  // Group-membership check — same path, same itemOrder, same altGroupKey.
  // `siblings` is the full set of items in the path (may include the item itself
  // as already-persisted). We need ≥ 2 distinct members in the alt-group.
  const peers = siblings.filter(s =>
    s.path_ID === item.path_ID &&
    s.itemOrder === item.itemOrder &&
    s.altGroupKey === item.altGroupKey
  );
  if (peers.length < 2) {
    throw new AltGroupValidationError(
      `single-member alt-group (path=${item.path_ID} order=${item.itemOrder} key=${item.altGroupKey}) — alt-groups need ≥ 2 members; either add another member or clear altGroupKey`
    );
  }
}

/**
 * CDS event-handler wrapper. Resolves entity at call-time (addendum F).
 *
 * @param {string} entityName — 'CompletionPathItems' or 'GroupPathItems'
 * @param {string} pathFK     — 'path_ID' (CompletionPathItems) or 'group_ID' (GroupPathItems)
 * @param {string} eventKind  — 'CREATE' or 'UPDATE' (controls enforceMultiMember per addendum G)
 */
export function makeAltGroupHandler(entityName, pathFK, eventKind) {
  const enforceMultiMember = eventKind === 'UPDATE';

  return async (req) => {
    const data = req.data;
    if (!data?.altGroupKey) return; // no alt-group declared → nothing to do

    const itemPath = data[pathFK] || null;
    if (!itemPath || data.itemOrder == null) return; // partial draft; let CDS report missing FK

    // Resolve entity inside the handler (addendum F — avoid registration-time race)
    const cds = (await import('@sap/cds')).default;
    const entity = cds.entities('com.sap.developers.ims')[entityName];

    const siblingsRaw = await SELECT.from(entity)
      .columns(pathFK, 'itemOrder', 'altGroupKey', 'altGroupLabel', 'ID')
      .where({ [pathFK]: itemPath });

    // Normalise the FK name to `path_ID` for the pure validator's filter.
    const item = { ...data, path_ID: itemPath };
    // Build the "all items in path" view the pure validator expects.
    // For UPDATE, replace the persisted row with the incoming `data`.
    // For CREATE, the row isn't in DB yet — append it.
    const otherRows = siblingsRaw
      .filter(s => s.ID !== data.ID)
      .map(s => ({ ...s, path_ID: s[pathFK] }));
    const siblings = [...otherRows, item];

    try {
      validateAltGroupItem(item, siblings, { enforceMultiMember });
    } catch (err) {
      if (err instanceof AltGroupValidationError) {
        return req.reject(400, err.message);
      }
      throw err;
    }
  };
}
