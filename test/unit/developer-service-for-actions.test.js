// test/unit/developer-service-for-actions.test.js
//
// Unit tests for DeveloperService *For actions (#1105 C1):
//   completeStepFor, resetTutorialProgressFor
//
// These are the internal service-to-service write path used by srv-mcp to
// record progress on behalf of an authenticated developer (via actingSapId).
// They are gated by the InternalWrite scope (a runtime XSUAA scope). In unit
// tests this scope is not assigned to basic-auth users, so we call via
// cds.User.Privileged which bypasses all @requires / scope checks — the
// handler body (actingSapId attribution, 400 guards, tokenSource='mcp') is
// exercised without fighting scope enforcement in the in-memory environment.
//
// Step G of Task 18.
//
// Tests assert:
//   1. completeStepFor attributes to actingSapId — NOT to the calling identity.
//   2. resetTutorialProgressFor attributes to actingSapId — NOT to the caller.
//   3. Empty actingSapId → req.reject(400).
//   4. 'anonymous' actingSapId → req.reject(400).
//   5. resetTutorialProgressFor emits TutorialProgressReset with tokenSource='mcp'.
//   6. completeStep (public) ignores an actingSapId param — IDOR guard (CAP
//      rejects unknown params with 400, which proves no bypass is possible).

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import cds from '@sap/cds';
import { _resetForTests as resetRateLimitBuckets } from '../../srv/lib/per-user-rate-limit.js';

// Boot CAP with in-memory SQLite. Module-level: must execute before describe
// blocks so schema is deployed before cds.entities() is called.
const project = cds.test('serve', '--project', '.', '--in-memory');

// Reset per-user rate-limit buckets between tests so the reset quota (5/hr)
// does not bleed between test cases.
beforeEach(() => {
  resetRateLimitBuckets();
});

// ─── Seed data ────────────────────────────────────────────────────────────────

// Two users: the "MCP user" (who the CC caller acts on behalf of) and the
// "caller" (the CC service identity, which has no personal progress rows).
const MCP_USER_SAPID = 'mcp-for-test@example.com';
const CALLER_SAPID   = 'cc-for-caller@example.com';
const authMcpUser    = { auth: { username: MCP_USER_SAPID, password: 'x' } };

const SLUG = 'for-action-tutorial';

// Helper: send an action on DeveloperService as a privileged (CC-equivalent)
// user, bypassing scope enforcement. This mirrors the test pattern used in
// test/unit/admin-bulk-last-chance.test.js for InternalWrite-equivalent actions.
async function sendAsPrivileged(event, data) {
  const srv = cds.services.DeveloperService;
  const user = new cds.User.Privileged();
  return srv.tx({ user }, tx => tx.send({ event, data }));
}

async function seedData() {
  const { Users, Tutorials, Steps, TaskRecords } = cds.entities('com.sap.developers.ims');

  // Idempotent cleanup — ordered children-before-parents to satisfy FKs.
  await DELETE.from(TaskRecords).where({ user_ID: { in: ['for-u1', 'for-u2'] } });
  await DELETE.from(Steps).where({ tutorial_ID: 'for-t1' });
  await DELETE.from(Tutorials).where({ ID: 'for-t1' });
  await DELETE.from(Users).where({ ID: { in: ['for-u1', 'for-u2'] } });

  await INSERT.into(Users).entries([
    { ID: 'for-u1', sapId: MCP_USER_SAPID, uuid: 'uuid-for-u1', displayName: 'MCP Dev', email: MCP_USER_SAPID },
    { ID: 'for-u2', sapId: CALLER_SAPID,   uuid: 'uuid-for-u2', displayName: 'Caller',  email: CALLER_SAPID  },
  ]);

  await INSERT.into(Tutorials).entries([
    { ID: 'for-t1', slug: SLUG, title: 'For Action Tutorial', legacyId: 7001, status: 'ACTIVE', stepCount: 3 },
  ]);

  await INSERT.into(Steps).entries([
    { ID: 'for-s1', tutorial_ID: 'for-t1', stepOrder: 1, title: 'Step 1', legacyId: 7101, status: 'ACTIVE' },
    { ID: 'for-s2', tutorial_ID: 'for-t1', stepOrder: 2, title: 'Step 2', legacyId: 7102, status: 'ACTIVE' },
    { ID: 'for-s3', tutorial_ID: 'for-t1', stepOrder: 3, title: 'Step 3', legacyId: 7103, status: 'ACTIVE' },
  ]);
}

beforeAll(async () => {
  await seedData();
});

async function clearProgress() {
  const { TaskRecords } = cds.entities('com.sap.developers.ims');
  await DELETE.from(TaskRecords).where({ user_ID: { in: ['for-u1', 'for-u2'] } });
  resetRateLimitBuckets();
}

// ─── completeStepFor ─────────────────────────────────────────────────────────

describe('DeveloperService.completeStepFor (#1105 C1)', () => {
  beforeEach(clearProgress);

  it('attributes step completion to actingSapId, not the caller identity', async () => {
    // Privileged call simulates a CC token with InternalWrite scope.
    // actingSapId = MCP_USER_SAPID; the privileged user itself is not MCP_USER_SAPID.
    const result = await sendAsPrivileged('completeStepFor', {
      actingSapId: MCP_USER_SAPID,
      slug: SLUG,
      stepNumber: 1,
    });

    expect(Array.isArray(result.completedSteps)).toBe(true);
    expect(result.completedSteps).toContain(1);
    expect(typeof result.points).toBe('number');

    // Verify the TaskRecord landed on MCP_USER_SAPID's DB user.
    const { TaskRecords, Users } = cds.entities('com.sap.developers.ims');
    const mcpUser    = await SELECT.one.from(Users).where({ sapId: MCP_USER_SAPID });
    const callerUser = await SELECT.one.from(Users).where({ sapId: CALLER_SAPID });

    const mcpRecords    = await SELECT.from(TaskRecords).where({ user_ID: mcpUser.ID });
    const callerRecords = await SELECT.from(TaskRecords).where({ user_ID: callerUser.ID });

    expect(mcpRecords.length).toBeGreaterThan(0);
    // Caller (CC identity) has no progress records — attribution went to actingSapId.
    expect(callerRecords.length).toBe(0);
  });

  it('returns completedSteps array reflecting the requested step', async () => {
    const result = await sendAsPrivileged('completeStepFor', {
      actingSapId: MCP_USER_SAPID,
      slug: SLUG,
      stepNumber: 2,
    });
    expect(result.completedSteps).toContain(2);
  });

  it('rejects empty actingSapId with 400', async () => {
    // srv.tx().send() throws CAP Error with code:400 (not status:400).
    await expect(
      sendAsPrivileged('completeStepFor', { actingSapId: '', slug: SLUG, stepNumber: 1 }),
    ).rejects.toMatchObject({ code: 400 });
  });

  it('rejects actingSapId="anonymous" with 400', async () => {
    await expect(
      sendAsPrivileged('completeStepFor', { actingSapId: 'anonymous', slug: SLUG, stepNumber: 1 }),
    ).rejects.toMatchObject({ code: 400 });
  });
});

// ─── resetTutorialProgressFor ────────────────────────────────────────────────

describe('DeveloperService.resetTutorialProgressFor (#1105 C1)', () => {
  async function completeAllStepsForUser(actingSapId) {
    for (const step of [1, 2, 3]) {
      await sendAsPrivileged('completeStepFor', { actingSapId, slug: SLUG, stepNumber: step });
    }
  }

  it('attributes reset to actingSapId, not the calling identity', async () => {
    await clearProgress();
    await completeAllStepsForUser(MCP_USER_SAPID);

    const result = await sendAsPrivileged('resetTutorialProgressFor', {
      actingSapId: MCP_USER_SAPID,
      slug: SLUG,
    });
    expect(result.newAttemptNumber).toBeGreaterThanOrEqual(2);

    // Caller (CC identity) still has no progress records.
    const { TaskRecords, Users } = cds.entities('com.sap.developers.ims');
    const callerUser = await SELECT.one.from(Users).where({ sapId: CALLER_SAPID });
    const callerRecords = await SELECT.from(TaskRecords).where({ user_ID: callerUser.ID });
    expect(callerRecords.length).toBe(0);
  });

  it('emits TutorialProgressReset with tokenSource="mcp"', async () => {
    await clearProgress();
    await completeAllStepsForUser(MCP_USER_SAPID);

    const emitted = [];
    cds.on('TutorialProgressReset', (msg) => emitted.push(msg.data ?? msg));

    await sendAsPrivileged('resetTutorialProgressFor', { actingSapId: MCP_USER_SAPID, slug: SLUG });

    const event = emitted.find(e => e.tutorialSlug === SLUG);
    expect(event).toBeDefined();
    expect(event.tokenSource).toBe('mcp');
  });

  it('rejects empty actingSapId with 400', async () => {
    // srv.tx().send() throws CAP Error with code:400 (not status:400).
    await expect(
      sendAsPrivileged('resetTutorialProgressFor', { actingSapId: '', slug: SLUG }),
    ).rejects.toMatchObject({ code: 400 });
  });

  it('rejects actingSapId="anonymous" with 400', async () => {
    await expect(
      sendAsPrivileged('resetTutorialProgressFor', { actingSapId: 'anonymous', slug: SLUG }),
    ).rejects.toMatchObject({ code: 400 });
  });
});

// ─── IDOR guard — public actions cannot be reached with an actingSapId param ─

describe('IDOR guard — public completeStep/resetTutorialProgress reject unknown actingSapId param', () => {
  // CAP's input validation rejects unknown params on bound actions (error 400
  // "Property X does not exist in Service.action"). This confirms that even if
  // a malicious caller injects actingSapId, CAP rejects it before the handler
  // runs — there is no code path that could honour a forged actingSapId on the
  // public actions.
  it('completeStep rejects an unknown actingSapId param with 400', async () => {
    await expect(
      // Send as authenticated-user via HTTP (basic-auth).
      project.post(
        '/api/completeStep',
        { slug: SLUG, stepNumber: 1, actingSapId: CALLER_SAPID },
        authMcpUser,
      ),
    ).rejects.toMatchObject({ response: { status: 400 } });
  });

  it('resetTutorialProgress rejects an unknown actingSapId param with 400', async () => {
    await expect(
      project.post(
        '/api/resetTutorialProgress',
        { slug: SLUG, actingSapId: CALLER_SAPID },
        authMcpUser,
      ),
    ).rejects.toMatchObject({ response: { status: 400 } });
  });
});
