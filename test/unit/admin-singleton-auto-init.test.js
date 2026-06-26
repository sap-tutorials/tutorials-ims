// test/unit/admin-singleton-auto-init.test.js
//
// Regression test for the OData v4 singleton 404 bug fixed in this PR.
//
// Bug: `@odata.singleton` projections in admin-service.cds (TenantSettings,
// DisplaySettings, SearchSettings, NavigatorSettings) returned 404 on every
// READ when their backing table was empty, blocking the admin UI from loading
// the tile — and therefore blocking PATCH (you can't save a row that isn't
// there for OData v4 singletons).
//
// Three sibling singletons (ChatSettings, KnowledgeGraphSettings,
// UiEventsSettings) already had a `before('READ')` auto-init handler that
// idempotently creates the row with hardcoded defaults. This bug existed
// because the auto-init pattern was only applied to those three; the other
// four had no equivalent.
//
// This test asserts the pattern works for ALL FOUR newly-fixed singletons.

import { describe, it, expect, beforeAll } from 'vitest';
import cds from '@sap/cds';

const ADMIN_USER = { id: 'admin@test', roles: ['Admin'] };

// Boot AdminService in-process against in-memory SQLite. The cds.test harness
// auto-deploys db/schema.cds, registers handlers from srv/admin-service.js,
// and exposes the OData endpoint without spinning up an HTTP server.
cds.test('serve', '--project', '.', '--in-memory');

describe('AdminService singleton auto-init (regression for 404 on first READ)', () => {
  let srv;

  beforeAll(async () => {
    srv = await cds.connect.to('AdminService');
  });

  // Helper: assert that reading a singleton with an empty backing table
  // returns a row populated with the resolver-default values.
  async function assertAutoInits(entityName, expectedDefaults) {
    const dbEntity = cds.entities('com.sap.developers.ims')[entityName];

    // Pre-condition: table is empty (no auto-init has fired yet).
    const before = await SELECT.from(dbEntity);
    expect(before).toHaveLength(0);

    // Trigger the singleton READ via the AdminService projection — same
    // path the admin-UI controller takes. tx.read returns an array (the
    // singleton wraps a single row), so unwrap it before asserting.
    const result = await srv.tx({ user: ADMIN_USER }, (tx) =>
      tx.read(entityName)
    );
    const row = Array.isArray(result) ? result[0] : result;

    // Post-condition: returned row matches the resolver defaults...
    expect(row).toMatchObject(expectedDefaults);

    // ...AND a row now exists in the DB (the before-handler INSERTed it).
    const after = await SELECT.from(dbEntity);
    expect(after).toHaveLength(1);
  }

  it('TenantSettings: auto-inits with resolver DEFAULTS', async () => {
    await assertAutoInits('TenantSettings', {
      // Mirrors srv/lib/runtime-config/tenant-settings.js DEFAULTS.
      allowedCorsOrigins: 'http://localhost:1313,http://localhost:5000,http://localhost:4004',
      rebuildTargetEnv: 'dev',
      techUsers: '',
      techUsersMapping: '',
    });
  });

  it('DisplaySettings: auto-inits with resolver DEFAULTS', async () => {
    await assertAutoInits('DisplaySettings', {
      // Mirrors srv/lib/runtime-config/display-settings.js DEFAULTS.
      dashboardUrl: 'https://tutorials-approuter.cfapps.eu10-005.hana.ondemand.com/ui/tutorialDashboard',
    });
  });

  it('SearchSettings: auto-inits with resolver DEFAULTS', async () => {
    await assertAutoInits('SearchSettings', {
      // Mirrors srv/lib/runtime-config/search-settings.js DEFAULTS.
      rateLimitMax: 60,
      rateLimitWindowMs: 60_000,
    });
  });

  it('NavigatorSettings: auto-inits with resolver DEFAULTS', async () => {
    await assertAutoInits('NavigatorSettings', {
      // Mirrors srv/lib/runtime-config/navigator-settings.js DEFAULTS.
      includeNestedGroups: false,
    });
  });

  it('auto-init is idempotent — re-reading does not insert a second row', async () => {
    // Pre-condition: TenantSettings has exactly one row (from the first test).
    const { TenantSettings } = cds.entities('com.sap.developers.ims');
    const before = await SELECT.from(TenantSettings);
    expect(before).toHaveLength(1);
    const originalId = before[0].ID;

    // Multiple subsequent reads — each one would fire the before-handler.
    for (let i = 0; i < 3; i++) {
      await srv.tx({ user: ADMIN_USER }, (tx) => tx.read('TenantSettings'));
    }

    // Still one row; the existence-check in the handler prevented duplicates.
    const after = await SELECT.from(TenantSettings);
    expect(after).toHaveLength(1);
    expect(after[0].ID).toBe(originalId);
  });

  it('PATCH after auto-init succeeds (no 404 — the core bug)', async () => {
    // This is the bug the user actually hit: open tile → try to save →
    // 404. After this PR, the READ that fires on tile-open auto-creates
    // the row, then PATCH lands on it.
    await srv.tx({ user: ADMIN_USER }, (tx) => tx.read('DisplaySettings'));
    const updated = await srv.tx({ user: ADMIN_USER }, (tx) =>
      tx.update('DisplaySettings').with({
        dashboardUrl: 'https://changed.example.com/dashboard',
      })
    );
    expect(updated).toBeDefined();

    const { DisplaySettings } = cds.entities('com.sap.developers.ims');
    const [row] = await SELECT.from(DisplaySettings);
    expect(row.dashboardUrl).toBe('https://changed.example.com/dashboard');
  });
});
