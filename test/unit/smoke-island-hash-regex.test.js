// test/unit/smoke-island-hash-regex.test.js
//
// Unit tests for the island-hash-detection regex used by assertHashedIslands
// in test/smoke/pages-routes.smoke.test.js.
//
// The regex guards against the stale-island class (#1628/#1604): if a deployed
// page serves an un-fingerprinted island bundle, this flag catches it.
//
// Bug fixed: Vite content hashes are base64url ([A-Za-z0-9_-]), which includes
// the hyphen `-`.  The old regex char-class [A-Za-z0-9_] excluded `-`, so any
// island whose Vite hash contained a hyphen was falsely flagged "unhashed" and
// the deploy smoke gate failed even though the bundle was correctly hashed.
// 6 of 49 real island bundles had hyphenated hashes (verified against live
// manifest at /_island-manifest.json on 2026-08-16).
//
// MUST match the regex in test/smoke/pages-routes.smoke.test.js:assertHashedIslands.

import { describe, it, expect } from 'vitest';

// Vite content hashes are base64url ([A-Za-z0-9_-]) and always contain at
// least one uppercase letter or digit (entropy discriminator).  Bare island
// names are all-lowercase kebab-case, so they never satisfy that requirement.
// The lookahead is scoped to the TRAILING segment, so a digit in the island
// NAME (e.g. `oauth2-client.js`) does not falsely pass.
const ISLAND_HASH_RE = /-(?=[A-Za-z0-9_-]*[A-Z0-9])[A-Za-z0-9_-]{6,}\.js$/;

const isHashed = (path) => ISLAND_HASH_RE.test(path);

describe('island hash regex — assertHashedIslands guard', () => {

  describe('HASHED: Vite base64url hashes that contain a hyphen (were false-failing before fix)', () => {
    it.each([
      ['/js/homepage-explainers-Cy2N-GCe.js'],
      ['/js/advocate-profile-BRM-qJcR.js'],
      ['/js/devtoberfest-faq-xxe74s-1.js'],
      ['/js/devtoberfest-sessions-calendar-8_-UGbPZ.js'],
      ['/js/preview-banner-TGQ3QZ--.js'],
      ['/js/tutorial-pip-launcher-KK-zMs-T.js'],
    ])('%s → hashed', (path) => {
      expect(isHashed(path)).toBe(true);
    });
  });

  describe('HASHED: standard (no-hyphen) Vite hashes that must not regress', () => {
    it.each([
      ['/js/alerts-CMUM_6iz.js'],
      ['/js/cmd-palette-BJtTJn3_.js'],
      ['/js/browse-CZzKJc_5.js'],
      ['/js/advocates-C2Y1kDxT.js'],
      ['/js/app-space-BHrPfcIu.js'],
      ['/js/tutorial-branches-DQD9wyex.js'],
      ['/js/navigator-Cjz1Gjrm.js'],
    ])('%s → hashed', (path) => {
      expect(isHashed(path)).toBe(true);
    });
  });

  describe('UNHASHED: bare island names must still be flagged (no fingerprint = stale-island bug)', () => {
    it.each([
      ['/js/homepage-explainers.js'],   // same island name, just no hash appended
      ['/js/tutorial-branches.js'],     // bare name
      ['/js/navigator.js'],             // single-segment name, no hash
      // tricky: `oauth2` has a digit in the NAME, not the trailing hash segment
      // (`-client` has no uppercase/digit) — must still be flagged unhashed
      ['/js/oauth2-client.js'],
      // real unhashed entries from the live /_island-manifest.json (2026-08-16)
      ['/js/concepts-filter.js'],
      ['/js/nav-dropdown.js'],
    ])('%s → unhashed', (path) => {
      expect(isHashed(path)).toBe(false);
    });
  });

});
