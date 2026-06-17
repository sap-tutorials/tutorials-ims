// CDS handlers for Advocates entities, registered onto AdminService at init time.

import { deriveSlug, suffixOnCollision } from '../lib/advocate-slug.js';

/**
 * Wire CDS handlers for Advocates entities onto the AdminService instance.
 * Caller passes `this` from inside AdminService.init().
 */
export function register(srv) {
  const { Advocates } = srv.entities;

  // Slug auto-derivation.
  //
  // Fiori draft lifecycle on @odata.draft.enabled entities:
  //   - 'NEW' on Advocates.drafts — initial draft creation from Fiori UI
  //     (POST /admin/Advocates with firstName/lastName in the body).
  //   - 'CREATE' on Advocates — programmatic non-draft writes (tests, scripts).
  //
  // We derive on draft-create because firstName/lastName ARE present in the
  // initial payload, and the draft response immediately reflects the slug
  // for assertions. Collision check queries both active and draft rows.
  const deriveAdvocateSlug = async (req) => {
    const data = req.data;
    if (!data.slug) {
      const base = deriveSlug(data.firstName, data.lastName);
      // Collect slugs from BOTH active and draft rows. Two `Casey Smith` drafts
      // POSTed back-to-back must produce `casey-smith` then `casey-smith-2`,
      // and at the moment the second handler fires the first is still a draft.
      const [activeRows, draftRows] = await Promise.all([
        SELECT.from(Advocates).columns('slug'),
        SELECT.from(Advocates.drafts).columns('slug'),
      ]);
      const taken = new Set(
        [...activeRows, ...draftRows].map((r) => r.slug).filter(Boolean),
      );
      data.slug = suffixOnCollision(base, taken);
    } else {
      data.slug = String(data.slug).toLowerCase();
    }
  };

  srv.before('NEW',    'Advocates.drafts', deriveAdvocateSlug);
  srv.before('CREATE', Advocates,          deriveAdvocateSlug);
}
