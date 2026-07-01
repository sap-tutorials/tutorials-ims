// test/unit/srv/admin-seed-help-docs.test.js
//
// Phase 4.7 (#748) Task 2: AdminService.seedHelpDocs action.
// Mirrors admin-seed-samples.test.js. Fire-and-forget: the action
// returns {started, reason} synchronously and kicks the fetch-help-docs
// cron in setImmediate. We don't await the cron — the 3 cases verify the
// immediate response shape + action declaration.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import cds from '@sap/cds';

async function sendAsAdmin(srv, event, data = {}) {
  const user = new cds.User.Privileged();
  return srv.tx({ user }, tx => tx.send({
    event, entity: 'KnowledgeGraphSettings', data,
  }));
}

describe('AdminService.seedHelpDocs action', () => {
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
    const result = await sendAsAdmin(srv, 'seedHelpDocs', { commit: false });
    expect(result).toHaveProperty('started', false);
    expect(result).toHaveProperty('reason');
    expect(typeof result.reason).toBe('string');
    expect(result.reason).toMatch(/dry-run/i);
  });

  it('commit=true returns { started: true } synchronously (fire-and-forget)', async () => {
    const result = await sendAsAdmin(srv, 'seedHelpDocs', { commit: true });
    expect(result).toHaveProperty('started', true);
    // reason may be null on commit path — only assert the started flag.
  });

  it('action is declared on KnowledgeGraphSettings (verified via CSN)', async () => {
    // The action is bound to the KnowledgeGraphSettings singleton via the
    // CDS declaration; the sendAsAdmin invocation above would 400 if the
    // action were missing. As an additional structural check, confirm the
    // action symbol resolves through cds.entities lookup.
    const KGS = srv.entities?.KnowledgeGraphSettings;
    expect(KGS).toBeDefined();
    const actionsContainer = KGS?.actions ?? {};
    expect(Object.keys(actionsContainer)).toContain('seedHelpDocs');
  });
});
