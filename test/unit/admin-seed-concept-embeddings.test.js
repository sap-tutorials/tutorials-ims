import { describe, it, expect, beforeEach } from 'vitest';
import path from 'node:path';
import cds from '@sap/cds';

// Issue #943: Task 6 — AdminService.seedConceptEmbeddings action.
//
// Verifies the admin action is registered, auth-gated by the entity-level
// @requires: 'Admin' on ChatSettings, and returns the expected
// { processed, failed, latencyMs } shape.
//
// This test does NOT mock runConceptEmbeddingBackfill — vi.mock does not
// intercept the dynamic `await import(...)` inside a cds.serve'd module
// (same caveat noted in test/unit/admin-seed-embeddings.test.js). Instead
// we rely on the real backfill running against an empty in-memory sqlite:
// with no Concepts rows to embed, fetchCandidates() returns [] and the job
// exits cleanly with processed=0, failed=0, latencyMs>0 — no AI Core call.
// A more focused integration/E2E of the actual embed loop is Task 10's
// manual DEV verification.

const schemaPath = path.join(process.cwd(), 'db', 'schema.cds');
const CHAT_ID = '00000000-0000-0000-0000-00000000c943';

async function seedChatSettings() {
  const { ChatSettings } = cds.entities('com.sap.developers.ims');
  await DELETE.from(ChatSettings);
  await INSERT.into(ChatSettings).entries({ ID: CHAT_ID, ragEnabled: true });
}

async function sendAsAdmin(srv, event) {
  const user = new cds.User.Privileged();
  return srv.tx({ user }, tx => tx.send({ event, entity: 'ChatSettings' }));
}

describe('AdminService seedConceptEmbeddings action (#943)', () => {
  let srv;

  beforeEach(async () => {
    await cds.deploy(schemaPath).to('sqlite::memory:');
    srv = await cds.serve('AdminService').from('./srv/admin-service');
    await seedChatSettings();
  });

  it('returns { processed, failed, latencyMs } shape from runConceptEmbeddingBackfill', async () => {
    const result = await sendAsAdmin(srv, 'seedConceptEmbeddings');

    // No Concepts rows in memory ⇒ nothing to embed, no AI Core call.
    expect(result).toBeDefined();
    expect(typeof result.processed).toBe('number');
    expect(typeof result.failed).toBe('number');
    expect(typeof result.latencyMs).toBe('number');
    expect(result.processed).toBe(0);
    expect(result.failed).toBe(0);
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('is auth-gated: anonymous invocation is rejected', async () => {
    // Non-privileged anonymous user should fail the entity-level
    // @requires: 'Admin' check on ChatSettings.
    const anon = new cds.User({ id: 'anonymous' });
    await expect(
      srv.tx({ user: anon }, tx => tx.send({ event: 'seedConceptEmbeddings', entity: 'ChatSettings' }))
    ).rejects.toMatchObject({ code: expect.any(Number) });
  });
});
