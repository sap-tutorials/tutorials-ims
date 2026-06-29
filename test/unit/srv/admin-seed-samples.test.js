// test/unit/srv/admin-seed-samples.test.js
//
// Phase 4.6 (#747) Task 2: AdminService.seedSamples action.
// Mirrors the AdminService.seedApiDocs unit-test pattern
// (test/unit/admin-seed-api-docs.test.js). Deploys to in-memory SQLite,
// serves AdminService, sends the action through cds.User.Privileged.
//
// seedSamples differs from seedApiDocs: the action is fire-and-forget
// (returns { started, reason } synchronously, then invokes the
// fetch-samples cron in setImmediate). We don't await the cron — the
// 3 cases only verify the immediate response shape + action declaration.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import cds from '@sap/cds';

async function sendAsAdmin(srv, event, data = {}) {
  const user = new cds.User.Privileged();
  return srv.tx({ user }, tx => tx.send({
    event, entity: 'KnowledgeGraphSettings', data,
  }));
}

describe('AdminService.seedSamples action', () => {
  let srv;

  beforeAll(async () => {
    await cds.deploy([
      path.join(process.cwd(), 'db'),
      path.join(process.cwd(), 'srv'),
    ]).to('sqlite::memory:');
    srv = await cds.serve('AdminService').from('./srv/admin-service');
  });

  afterAll(async () => { await cds.disconnect(); });

  it('dry-run returns { started: false, reason }', async () => {
    const result = await sendAsAdmin(srv, 'seedSamples', { commit: false });
    expect(result).toHaveProperty('started', false);
    expect(result).toHaveProperty('reason');
    expect(typeof result.reason).toBe('string');
    expect(result.reason).toMatch(/dry-run/i);
  });

  it('commit=true returns { started: true } synchronously (fire-and-forget)', async () => {
    const result = await sendAsAdmin(srv, 'seedSamples', { commit: true });
    expect(result).toHaveProperty('started', true);
    // reason may be null on commit path — only assert the started flag.
  });

  it('action is declared on KnowledgeGraphSettings (verified via operations)', async () => {
    // The action is bound to the KnowledgeGraphSettings singleton via the
    // CDS declaration; the sendAsAdmin invocation above would 400 if the
    // action were missing. As an additional structural check, confirm the
    // action symbol resolves through cds.entities lookup.
    const KGS = srv.entities?.KnowledgeGraphSettings;
    expect(KGS).toBeDefined();
    // CAP exposes actions on the entity model under .actions in CSN.
    const actionsContainer = KGS?.actions ?? {};
    expect(Object.keys(actionsContainer)).toContain('seedSamples');
  });
});
