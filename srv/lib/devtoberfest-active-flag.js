// Enforces the "at most one active row" invariant on DevtoberfestConfig.
//
// DevtoberfestConfig is multi-row by design (one row per Devtoberfest
// cycle). The `isActive` Boolean flag picks which row is "live" for
// public-facing queries (statusHandler, termsHandler, joule tool,
// join handler). Exactly one row should carry isActive=true at any
// time.
//
// CDS @assert.unique can't express "unique when isActive=true", so
// the invariant is enforced here in the CAP layer instead of via a
// HANA partial index. On any save (CREATE/UPDATE/PATCH on the active
// projection, draft-activate funnels through these too) that lands
// isActive=true on a row, we deactivate every OTHER row in the same
// transaction. The unique constraint holds without a DB-level guard.
//
// Auto-deactivation is intentional UX (per spec §"Open questions"):
// flipping isActive on a draft means "make this one the active config";
// the admin shouldn't have to remember to manually clear the previous
// active row first.
//
// Zero-active is acceptable (public handlers return 503
// EVENT_NOT_CONFIGURED). The invariant only fires when isActive=true
// is being written.
//
// Spec: docs/superpowers/specs/2026-06-24-devtoberfest-config-multi-row-draft-design.md

import cds from '@sap/cds';

const LOG = cds.log('devtoberfest');

/**
 * Before-handler for CREATE/UPDATE/NEW/PATCH on AdminService.DevtoberfestConfig.
 * If the incoming change sets isActive=true, deactivate every other
 * active row in the same transaction.
 *
 * @param {object} req - CDS request object
 */
export async function ensureDevtoberfestActiveFlagInvariant(req) {
  const incoming = req.data;
  // Only act when the change is flipping a row to active. PATCHes that
  // don't touch isActive (or set it false) are passthrough.
  if (incoming?.isActive !== true) return;

  // The active-side entity (the projection target). Drafts route through
  // the same projection; CAP funnels draft activation through CREATE on
  // the active side, so this handler sees both new rows and draft-activated
  // rows.
  const { DevtoberfestConfig } = cds.entities('AdminService');

  // The row being saved has an ID (it's a cuid entity, draft activations
  // carry the same key as the active row that came out of draftEdit).
  const myId = incoming?.ID;
  const whereClause = myId
    ? { isActive: true, ID: { '!=': myId } }
    : { isActive: true };

  // Use a single UPDATE rather than fetching + per-row PATCH. CDS QL
  // returns the count of affected rows on HANA + SQLite.
  const deactivated = await UPDATE(DevtoberfestConfig)
    .set({ isActive: false })
    .where(whereClause);

  if (deactivated > 0) {
    LOG.info(`Devtoberfest: deactivated ${deactivated} previously-active row(s) so ${myId || '<new>'} can become active`);
  }
}
