import { describe, it, expect, beforeAll } from 'vitest';
import cds from '@sap/cds';

// ---------------------------------------------------------------------------
// Regression guard for issue #1752 — several Admin UI detail edit screens
// rendered long-form text fields as single-line Inputs, which is unusable for
// multi-line content (alert bodies, URLs, taglines, "why it matters" blurbs,
// redirect paths). Fiori Elements renders an element as a multi-line TextArea
// when it carries the @UI.MultiLineText annotation. This test asserts that
// every field called out in the issue carries that annotation in the compiled
// CSN, so a future annotation edit can't silently revert the fields to Inputs.
// ---------------------------------------------------------------------------

// entity → fields that must be @UI.MultiLineText, per issue #1752.
const MULTILINE_FIELDS = {
  // Content -> Alerts
  'AdminService.Alerts': ['body'],
  // Homepage -> Shelf Entries (Links)
  'AdminService.HomepageShelves': ['url', 'description', 'tagline', 'whyItMatters'],
  // Homepage -> Verb Explainers
  'AdminService.VerbDefinitions': ['tagline', 'whyItMatters'],
  // Homepage -> Shelf Explainers
  'AdminService.ShelfDefinitions': ['tagline', 'whyItMatters'],
  // Homepage -> Redirects
  'AdminService.LegacyRedirects': ['fromPath', 'toPath'],
};

describe('admin-annotations.cds — long-form edit fields render as TextArea (#1752)', () => {
  let csn;

  beforeAll(async () => {
    csn = await cds.load(['srv', 'app', 'db']);
  });

  for (const [entityName, fields] of Object.entries(MULTILINE_FIELDS)) {
    describe(entityName, () => {
      for (const field of fields) {
        it(`${field} is annotated @UI.MultiLineText`, () => {
          const element = csn.definitions[entityName]?.elements?.[field];
          expect(element, `${entityName}.${field} should exist`).toBeTruthy();
          expect(
            element['@UI.MultiLineText'],
            `${entityName}.${field} must carry @UI.MultiLineText so Fiori ` +
            `Elements renders a multi-line TextArea instead of a single-line Input`,
          ).toBe(true);
        });
      }
    });
  }
});
