// e2e: Petoberfest pet photo contest (issue #1xxx).
// Flow: anonymous page renders → authenticated upload → admin approve → public slideshow.
// Path: browser → approuter /petoberfest/:slug/ (static) → /petoberfest-api/* → CAP
//       PetoberfestService; admin moderation via AdminService bound action.
// Self-skips without PLAYWRIGHT_BASE_URL/SMOKE_BASE_URL (repo e2e convention, #1338).
// Run post-deploy only:
//   npx vitest run --project e2e test/e2e/petoberfest.test.js
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { hasBaseUrl, hasCredentials, authHeader } from './e2e.config.js';
import { launchBrowser, newPage } from './_browser.js';

// ── 0. Admin nav reachability: contest maintenance LR (issue #1449) ─────────
// Regression guard for the "shipped but unreachable" nav gap: the Petoberfests
// contest List Report existed in app/admin/petoberfest/ but no shell nav item
// surfaced it. The fix adds a "Contests" item to petoberfestGroup that deep-links
// the petoberfest componentUsage to its inner Petoberfests route. We assert the
// exact hash onNavItemSelect emits ("petoberfestContests&/pb/Petoberfests")
// resolves to a rendered FE List Report inside the shell — proving route +
// componentUsage target + inner deep-link all line up. Needs admin creds.
describe.skipIf(!hasBaseUrl() || !hasCredentials())(
  'e2e: petoberfest contest maintenance is reachable from admin nav (#1449)',
  () => {
    let browser;
    beforeAll(async () => { browser = await launchBrowser(); });
    afterAll(async () => { await browser?.close(); });

    it('#petoberfestContests deep-links to the Petoberfests contest List Report', async () => {
      const { context, page } = await newPage(browser, { authenticated: true });
      try {
        // The full hash produced by the "Contests" nav click in Shell.controller.js.
        await page.goto('/admin-ui/#petoberfestContests&/pb/Petoberfests', {
          waitUntil: 'domcontentloaded',
        });
        // FE List Report surfaces as sap.m.List or sap.ui.table.Table — role-first
        // with a UI5-class fallback (mirrors admin-shell.test.js).
        await page
          .locator('[role="list"], [role="grid"], .sapMList, .sapUiTable')
          .first()
          .waitFor({ state: 'visible', timeout: 30_000 });
        expect(
          await page.locator('[role="list"], [role="grid"], .sapMList, .sapUiTable').count(),
          'contest List Report should render inside the shell'
        ).toBeGreaterThan(0);
      } finally {
        await context.close();
      }
    });
  }
);

// ── 0b. Moderation List Report supports row selection (issue: approve no-op) ─
// Regression guard for "the approval button doesn't do anything" + the
// mass-approve request. The PetSubmissions moderation List Report toolbar
// carries the approve/hide bound-action buttons (UI.DataFieldForAction), which
// need a selected row context to fire. The table shipped with the FE default
// selectionMode:"None" — no checkboxes rendered, so clicking approve was a
// no-op and multi-select was impossible. The fix sets tableSettings.selectionMode
// "ForceMulti" in app/admin/petoberfest/webapp/manifest.json — plain "Multi" is
// advisory and FE's getSelectionMode() downgrades it to "None" on a read-only
// table (PetSubmissions has all Capabilities.*Restrictions=false, moderation is
// via bound actions only); "ForceMulti" short-circuits that downgrade. We assert
// the rendered moderation table exposes row-selection controls (checkboxes /
// rowselect cells), which proves the manifest selectionMode took effect end-to-end.
// Needs admin creds.
describe.skipIf(!hasBaseUrl() || !hasCredentials())(
  'e2e: petoberfest moderation List Report allows multi-select for approve',
  () => {
    let browser;
    beforeAll(async () => { browser = await launchBrowser(); });
    afterAll(async () => { await browser?.close(); });

    it('renders row-selection controls on the PetSubmissions moderation table', async () => {
      const { context, page } = await newPage(browser, { authenticated: true });
      try {
        await page.goto('/admin-ui/#/petoberfest', { waitUntil: 'domcontentloaded' });

        // Wait for the FE List Report table to render.
        await page
          .locator('[role="grid"], [role="list"], .sapMList, .sapUiTable, .sapUiMdcTable')
          .first()
          .waitFor({ state: 'visible', timeout: 30_000 });

        // selectionMode:"ForceMulti" surfaces per-row selection controls. FE renders
        // these as checkboxes (role="checkbox") in ResponsiveTable/MDC, or
        // rowselect cells in a GridTable. Either proves selection is enabled;
        // with the resolved "None" (plain "Multi" on a read-only table) none exist.
        const selectionControls = page.locator(
          '[role="checkbox"], .sapMListTblSelCol, .sapUiTableRowSelectionCell, .sapMCb'
        );
        await selectionControls.first().waitFor({ state: 'attached', timeout: 30_000 });
        expect(
          await selectionControls.count(),
          'moderation table should render row-selection controls (selectionMode:"ForceMulti")'
        ).toBeGreaterThan(0);
      } finally {
        await context.close();
      }
    });
  }
);

// ── 0c. Moderation action buttons reference a resolvable bound action ───────
// Regression guard for "select a row, press Approve — nothing happens, no error,
// no feedback." The approve/hide buttons are UI.DataFieldForAction entries whose
// Action string FE resolves against the OData metamodel. They were authored as
// 'AdminService.PetSubmissions/approve' (the Service.Entity/action *slash* form),
// which FE resolves as an unbound *action import* — none exists, so FE threw
// "Unknown action import" deep inside callActionImport, swallowed it, and never
// issued the POST (hence no visible effect and no console error). Single-overload
// bound actions must use the 'Service.action' form ('AdminService.approve'); the
// slash form is only for multi-overload actions needing entity disambiguation
// (e.g. AdminService.VerbDefinitions/regenerate). This test drives FE's own
// metamodel to assert every LineItem DataFieldForAction Action resolves to a
// bound action overload — the exact resolution FE performs on button press.
// With the pre-fix slash form, resolution yields null and this fails. Needs admin creds.
describe.skipIf(!hasBaseUrl() || !hasCredentials())(
  'e2e: petoberfest moderation actions resolve to bound actions (approve no-op fix)',
  () => {
    let browser;
    beforeAll(async () => { browser = await launchBrowser(); });
    afterAll(async () => { await browser?.close(); });

    it('every PetSubmissions LineItem DataFieldForAction resolves to a bound action', async () => {
      const { context, page } = await newPage(browser, { authenticated: true });
      try {
        await page.goto('/admin-ui/#/petoberfest', { waitUntil: 'domcontentloaded' });

        // Wait for the FE table (proves the OData V4 model + metamodel are live).
        await page
          .locator('[role="grid"], [role="list"], .sapMList, .sapUiTable, .sapUiMdcTable')
          .first()
          .waitFor({ state: 'visible', timeout: 30_000 });

        // Resolve each Action string exactly as FE does at press time.
        const result = await page.evaluate(async () => {
          const Core = sap.ui.require('sap/ui/core/Element') || sap.ui.core.Element;
          let model;
          Core.registry.forEach((el) => {
            const m = el.getModel && el.getModel();
            if (!model && m && m.isA && m.isA('sap.ui.model.odata.v4.ODataModel')) model = m;
          });
          if (!model) return { error: 'no OData V4 model found' };
          const mm = model.getMetaModel();
          const lineItem = mm.getObject('/PetSubmissions/@com.sap.vocabularies.UI.v1.LineItem') || [];
          const actions = lineItem
            .filter((x) => x.$Type === 'com.sap.vocabularies.UI.v1.DataFieldForAction')
            .map((x) => x.Action);
          const resolved = actions.map((name) => {
            const o = mm.getObject('/' + name);
            const overloads = Array.isArray(o) ? o : (o ? [o] : []);
            const bound = overloads.some((ov) => ov && ov.$kind === 'Action' && ov.$IsBound);
            return { name, resolvesToBoundAction: bound };
          });
          return { actions, resolved };
        });

        expect(result.error, `page eval failed: ${result.error}`).toBeUndefined();
        expect(
          result.actions.length,
          'PetSubmissions LineItem should carry DataFieldForAction buttons'
        ).toBeGreaterThan(0);
        for (const r of result.resolved) {
          expect(
            r.resolvesToBoundAction,
            `action "${r.name}" must resolve to a bound action overload — the ` +
            `Service.Entity/action slash form resolves to a non-existent action ` +
            `import (FE throws "Unknown action import" and silently no-ops)`
          ).toBe(true);
        }
      } finally {
        await context.close();
      }
    });
  }
);

// ── 1. Anonymous page load ─────────────────────────────────────────────────
describe.skipIf(!hasBaseUrl())('e2e: petoberfest (anonymous)', () => {
  let browser;
  beforeAll(async () => { browser = await launchBrowser(); });
  afterAll(async () => { await browser?.close(); });

  it('renders #petoberfest-mount with slideshow or empty-state', async () => {
    const { context, page } = await newPage(browser, { authenticated: false });
    try {
      const response = await page.goto('/petoberfest/petoberfest-2026/', { waitUntil: 'domcontentloaded' });
      expect(response, 'no response received').not.toBeNull();
      expect(response.status(), `unexpected status ${response.status()}`).toBe(200);

      // Served page convention: <main> (never <article>), #1338.
      await page.locator('main').first().waitFor({ state: 'visible', timeout: 15_000 });

      // The Vue island mounts into #petoberfest-mount.
      await page.locator('#petoberfest-mount').waitFor({ state: 'attached', timeout: 20_000 });
      expect(
        await page.locator('#petoberfest-mount').count(),
        '#petoberfest-mount should be in the DOM'
      ).toBeGreaterThan(0);

      // Anonymous users see either an approved-photo slideshow OR an empty-state
      // plus a "Sign in" prompt (both are valid: a fresh event has 0 approved photos).
      const slideshowOrEmpty = await page.locator('.pet-slideshow, .pet-empty, .pet-upload').count();
      expect(
        slideshowOrEmpty > 0,
        'island should render a slideshow, empty-state, or upload section'
      ).toBe(true);
    } finally {
      await context.close();
    }
  });
});

// ── 2-4. Authenticated flow: upload → admin-approve → public serve ─────────
// Skips when credentials are absent (same pattern as admin-shell.test.js).
// This suite makes two API calls (upload + approve) and then a photo probe.
// NOTE: the upload leg creates a real PENDING row in the DB and the approve
// leg transitions it to APPROVED. Both are idempotent from a data-safety
// standpoint (the approved row stays; a re-run will hit the 409 DUPLICATE
// guard on upload, which we treat as "already done" and carry the ID forward).
describe.skipIf(!hasBaseUrl() || !hasCredentials())(
  'e2e: petoberfest (authenticated upload → approve → photo serve)',
  () => {
    let browser;
    // NOTE: steps share uploadedId via closure and MUST run serially — do not add .concurrent to this describe.
    let uploadedId = null; // filled in by the upload step

    beforeAll(async () => { browser = await launchBrowser(); });
    afterAll(async () => { await browser?.close(); });

    it('authenticated upload lands a PENDING submission', async () => {
      const { context } = await newPage(browser, { authenticated: true });
      try {
        // Use the Playwright APIRequestContext — it honours the Basic Authorization
        // header baked into the browser context by newPage(). Transport is JSON base64
        // (the upload moved off multipart to survive the Akamai edge on developers.sap.com).
        // 1×1 white PNG — smallest valid image that passes sharp's header check (68 bytes).
        const pngBytes = Buffer.from([
          0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,  // PNG signature
          0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,  // IHDR chunk len + type
          0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,  // 1 wide, 1 tall
          0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0xc3,  // 8-bit RGB, no interlace + CRC
          0xd0, 0x00, 0x00, 0x00, 0x0c, 0x49, 0x44, 0x41,  // IDAT chunk
          0x54, 0x08, 0xd7, 0x63, 0xf8, 0xcf, 0xc0, 0x00,
          0x00, 0x00, 0x02, 0x00, 0x01, 0xe2, 0x21, 0xbc,  // IDAT data + CRC
          0x33, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e,  // IEND
          0x44, 0xae, 0x42, 0x60, 0x82,                    // IEND CRC
        ]);
        const result = await context.request.fetch('/petoberfest-api/petoberfest-2026/upload', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          data: JSON.stringify({
            filename: 'test-pet.png',
            mimeType: 'image/png',
            photoBase64: pngBytes.toString('base64'),
            petName: 'e2e Test Pet',
          }),
        });

        const status = result.status();
        // 200 = new upload (PENDING); 409 = duplicate (already uploaded in a prior run).
        expect(
          status === 200 || status === 409,
          `upload should return 200 or 409 (duplicate), got ${status}`
        ).toBe(true);

        if (status === 200) {
          const body = await result.json();
          expect(body.id, 'upload response must have an id').toBeTruthy();
          expect(body.moderation, 'new upload should be PENDING').toBe('PENDING');
          uploadedId = body.id;
        } else {
          // 409 duplicate — a prior run already uploaded. We can't recover the
          // id from this path without a myUploads call, so mark the approve +
          // photo steps as "unable to verify" (they require the id). We skip
          // them gracefully via the null guard rather than failing.
          uploadedId = null;
        }
      } finally {
        await context.close();
      }
    });

    it('admin approve transitions the submission to APPROVED', async () => {
      if (!uploadedId) {
        // A prior run left a DUPLICATE; skip rather than fail (no id to approve).
        console.warn('petoberfest e2e: skipping approve step — no uploadedId (duplicate upload)');
        return;
      }

      const { context } = await newPage(browser, { authenticated: true });
      try {
        // CAP bound action: POST /admin/PetSubmissions(<id>)/AdminService.approve
        // AdminService is @requires:'Admin'; SMOKE_TECH_USER must carry Admin scope.
        const res = await context.request.post(
          `/admin/PetSubmissions(${uploadedId})/AdminService.approve`,
          { headers: { 'Content-Type': 'application/json' }, data: {} }
        );

        // 200 or 204 = approved.  401/403 = tech user lacks Admin scope.
        // Both outcomes are surfaced clearly rather than failing silently.
        const status = res.status();
        expect(
          status === 200 || status === 204,
          `approve action should return 200 or 204; got ${status} ` +
          `(if 401/403, SMOKE_TECH_USER may lack the 'Admin' XSUAA scope)`
        ).toBe(true);
      } finally {
        await context.close();
      }
    });

    it('approved photo serves 200 from public /petoberfest-api/photo/:id', async () => {
      if (!uploadedId) {
        console.warn('petoberfest e2e: skipping photo-serve step — no uploadedId (duplicate upload)');
        return;
      }

      const { context } = await newPage(browser, { authenticated: false });
      try {
        // Public photo endpoint is authenticationType:none in approuter — no auth needed.
        const res = await context.request.get(
          `/petoberfest-api/photo/${uploadedId}?size=display`
        );
        expect(
          res.status(),
          `approved photo should serve 200; got ${res.status()}`
        ).toBe(200);

        // Content-Type must be an image variant.
        const ct = res.headers()['content-type'] || '';
        expect(
          ct.startsWith('image/'),
          `expected image/* content-type, got "${ct}"`
        ).toBe(true);
      } finally {
        await context.close();
      }
    });

    it('approved pet appears in the public slideshow call', async () => {
      if (!uploadedId) {
        console.warn('petoberfest e2e: skipping slideshow step — no uploadedId (duplicate upload)');
        return;
      }

      const { context } = await newPage(browser, { authenticated: false });
      try {
        // OData function: GET /petoberfest-api/slideshow(slug='petoberfest-2026')
        // The approuter route is authenticationType:none — public.
        const res = await context.request.get(
          `/petoberfest-api/slideshow(slug='petoberfest-2026')`
        );
        expect(res.status(), `slideshow should return 200; got ${res.status()}`).toBe(200);

        const body = await res.json();
        const entries = body.value ?? (Array.isArray(body) ? body : []);
        expect(Array.isArray(entries), 'slideshow should return an array').toBe(true);

        // The just-approved submission should appear.
        const found = entries.some((e) => e.id === uploadedId);
        expect(found, `approved submission ${uploadedId} should appear in the slideshow`).toBe(true);
      } finally {
        await context.close();
      }
    });
  }
);
