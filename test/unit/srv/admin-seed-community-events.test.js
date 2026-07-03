// test/unit/srv/admin-seed-community-events.test.js
//
// Phase 4.8 (#765): AdminService.seedCommunityEvents action.
// Mirrors admin-seed-help-docs.test.js. Fire-and-forget: the action
// returns {started, reason} synchronously and kicks the
// fetch-community-events cron in setImmediate.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import cds from '@sap/cds';

async function sendAsAdmin(srv, event, data = {}) {
  const user = new cds.User.Privileged();
  return srv.tx({ user }, tx => tx.send({
    event, entity: 'KnowledgeGraphSettings', data,
  }));
}

describe('AdminService.seedCommunityEvents action', () => {
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
    const result = await sendAsAdmin(srv, 'seedCommunityEvents', { commit: false });
    expect(result).toHaveProperty('started', false);
    expect(result).toHaveProperty('reason');
    expect(typeof result.reason).toBe('string');
    expect(result.reason).toMatch(/dry-run/i);
  });

  it('commit=true returns { started: true } synchronously (fire-and-forget)', async () => {
    const result = await sendAsAdmin(srv, 'seedCommunityEvents', { commit: true });
    expect(result).toHaveProperty('started', true);
  });

  it('action is declared on KnowledgeGraphSettings (verified via CSN)', async () => {
    const KGS = srv.entities?.KnowledgeGraphSettings;
    expect(KGS).toBeDefined();
    const actionsContainer = KGS?.actions ?? {};
    expect(Object.keys(actionsContainer)).toContain('seedCommunityEvents');
  });

  it('handler in admin-service.js uses the post-#769 auditEvent pattern', () => {
    const src = require('node:fs').readFileSync('srv/admin-service.js', 'utf8');
    expect(src).toContain("auditEvent('kg.community-events.seed'");
    expect(src).toContain("runJobByName('fetch-community-events'");
  });
});
