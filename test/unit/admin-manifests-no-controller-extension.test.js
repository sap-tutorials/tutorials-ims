// Regression guard for the UI5 controller-suffix collision fix (#759 hotfix).
//
// The three admin Fiori apps (verb-definitions, shelf-definitions, homepage)
// originally shipped with an `extends.extensions.sap.ui.controllerExtensions`
// block in their manifests, declaring a ListReportController extension. UI5's
// loader appends `.controller.js` when resolving extension controller files,
// but our controllers are named `ActionsController.js` (no `.controller` infix).
// Result: 404 on the controller fetch → SPA falls through to the index.html
// 404 page → "MIME type ('text/html') is not executable" runtime error on
// every load of the apps. Memory: feedback_ui5_controller_suffix_collision.
//
// Fix: drop the `extends.extensions.sap.ui.controllerExtensions` block. The
// `press` references in `controlConfiguration.actions` resolve as plain
// modules (no `.controller.js` rewrite) so action buttons still work.
//
// This test pins the absence so the broken block doesn't sneak back via
// a future copy-paste of the Categories precedent (which has both forms).

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const MANIFESTS = [
  'app/admin/verb-definitions/webapp/manifest.json',
  'app/admin/shelf-definitions/webapp/manifest.json',
  'app/admin/homepage/webapp/manifest.json',
];

describe('admin Fiori manifests — controller-extension absence (#759 hotfix)', () => {
  for (const path of MANIFESTS) {
    it(`${path}: does NOT declare sap.ui.controllerExtensions`, () => {
      const raw = readFileSync(join(import.meta.dirname, '../..', path), 'utf8');
      const manifest = JSON.parse(raw);
      const exts = manifest['sap.ui5']?.extends?.extensions?.['sap.ui.controllerExtensions'];
      expect(exts).toBeUndefined();
      // Belt + suspenders: also assert the raw text doesn't contain the key,
      // in case future JSON normalization moves the structure.
      expect(raw).not.toMatch(/sap\.ui\.controllerExtensions/);
    });
  }
});
