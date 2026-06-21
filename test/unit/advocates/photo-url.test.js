import { describe, expect, it } from 'vitest';
import { urlForSlug } from '../../../srv/handlers/advocate-handlers.js';

// Pure-helper tests for the photoUrl normalization invariant (issue #415).
//
// End-to-end coverage of the handler side-effects (after-CREATE on
// AdvocatePhotos flipping hasPhoto + photoUrl, slug-rename recompute,
// clear on delete) lives in:
//   - test/hybrid/advocates-photo-hana.test.js  (real HANA + auth)
//   - manual smoke on deploy: upload a photo, observe the OP header avatar
//
// Direct unit-testing the handler side-effects via cds.test('serve') is
// blocked by AdminService.@requires(...) — the test runner has no user
// context to satisfy the auth check, and raw db.run(INSERT) bypasses the
// service layer entirely (handlers don't fire). The helper coverage here
// + hybrid coverage there is the right test pyramid for this fix.
describe('urlForSlug — photoUrl shape invariant (issue #415)', () => {
  it('builds the canonical public photo URL for a slug', () => {
    expect(urlForSlug('thomas-jung')).toBe('/api/advocates/thomas-jung/photo');
  });

  it('lowercases the slug to match the public route lookup', () => {
    // srv/lib/advocate-photo-store.js does WHERE LOWER(SLUG) = ? — so the URL
    // we emit must also be lowercase, otherwise an admin who renamed an
    // advocate to a mixed-case slug would see a 404 on their own avatar.
    expect(urlForSlug('Thomas-Jung')).toBe('/api/advocates/thomas-jung/photo');
    expect(urlForSlug('UPPERCASE')).toBe('/api/advocates/uppercase/photo');
  });

  it('returns null on empty/missing input', () => {
    // photoUrl is nullable; clearPhoto / DELETE handlers null it. Helper
    // must return null (not undefined or '') so a SET set({photoUrl:null})
    // hits the DB as actual NULL rather than coercing to empty string.
    expect(urlForSlug('')).toBeNull();
    expect(urlForSlug(undefined)).toBeNull();
    expect(urlForSlug(null)).toBeNull();
  });
});
