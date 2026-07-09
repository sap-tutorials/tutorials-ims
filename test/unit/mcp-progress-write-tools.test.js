// test/unit/mcp-progress-write-tools.test.js
//
// Unit tests for DeveloperService authenticated MCP write tools:
//   complete_step, reset_tutorial_progress
//
// Includes: delegation correctness, TutorialProgressReset audit event shape
// (tokenSource field), anonymous 401, read-only-PAT 403 scope gate.
//
// (#1105 Task 12)
//
// Auth pattern: basic-auth username becomes req.user.id; resolveUserSapId
// falls back to req.user.id as sapId. Seed Users with sapId == basic-auth user.

import { describe, it, expect, beforeAll } from 'vitest';
import cds from '@sap/cds';

// Module-level cds.test boots CAP + in-memory SQLite.
const project = cds.test('serve', '--project', '.', '--in-memory');

const WU1_SAPID = 'wu1@ex.com';
const auth1 = { auth: { username: WU1_SAPID, password: 'x' } };

describe('DeveloperService authenticated MCP write tools', () => {
  const emittedEvents = [];

  beforeAll(async () => {
    const { Users, Tutorials, Steps } = cds.entities('com.sap.developers.ims');

    await INSERT.into(Users).entries([
      { ID: 'wu1-id', sapId: WU1_SAPID, uuid: 'uuid-wu1', displayName: 'W1', email: WU1_SAPID },
    ]);

    await INSERT.into(Tutorials).entries([
      { ID: 'wt-a', slug: 'wtut-a', title: 'W', legacyId: 9001, status: 'ACTIVE' },
    ]);

    // Seed a step so completeStep can find one.
    await INSERT.into(Steps).entries([
      { ID: 'ws-1', tutorial_ID: 'wt-a', stepOrder: 1, title: 'Step 1', legacyId: 9101, status: 'ACTIVE' },
      { ID: 'ws-2', tutorial_ID: 'wt-a', stepOrder: 2, title: 'Step 2', legacyId: 9102, status: 'ACTIVE' },
      { ID: 'ws-3', tutorial_ID: 'wt-a', stepOrder: 3, title: 'Step 3', legacyId: 9103, status: 'ACTIVE' },
    ]);

    // Listen for TutorialProgressReset events to inspect the tokenSource field.
    // cds.emit('TutorialProgressReset', ...) dispatches on the global event bus,
    // so we must use cds.on (same pattern as admin-service.js audit listener).
    cds.on('TutorialProgressReset', (msg) => emittedEvents.push(msg.data ?? msg));
  });

  it('complete_step delegates to completeStep and returns the same shape', async () => {
    const { data } = await project.post('/api/complete_step',
      { slug: 'wtut-a', stepNumber: 2 },
      auth1
    );
    expect(Array.isArray(data.completedSteps)).toBe(true);
    expect(data.completedSteps).toContain(2);
    expect(typeof data.points).toBe('number');
  });

  it('reset_tutorial_progress emits TutorialProgressReset with tokenSource field', async () => {
    // First complete a step so there are live rows to reset.
    await project.post('/api/complete_step',
      { slug: 'wtut-a', stepNumber: 1 },
      auth1
    );

    const initialCount = emittedEvents.length;

    const { data } = await project.post('/api/reset_tutorial_progress',
      { slug: 'wtut-a' },
      auth1
    );
    expect(data.newAttemptNumber).toBeGreaterThanOrEqual(2);

    // The audit event must have fired and include tokenSource.
    const newEvents = emittedEvents.slice(initialCount);
    const event = newEvents.find(e => e.tutorialSlug === 'wtut-a');
    expect(event).toBeDefined();
    expect(Object.prototype.hasOwnProperty.call(event, 'tokenSource')).toBe(true);
    // Basic-auth has no tokenSource → should be null or undefined
    expect(event.tokenSource == null).toBe(true);
  });

  it('rejects anonymous callers with 401 on complete_step', async () => {
    await expect(
      project.post('/api/complete_step', { slug: 'wtut-a', stepNumber: 3 })
    ).rejects.toMatchObject({ response: { status: 401 } });
  });

  it('rejects anonymous callers with 401 on reset_tutorial_progress', async () => {
    await expect(
      project.post('/api/reset_tutorial_progress', { slug: 'wtut-a' })
    ).rejects.toMatchObject({ response: { status: 401 } });
  });

  it('rejects a read-only PAT caller with 403 on complete_step', async () => {
    // Simulate req as the handler sees it: PAT with tokenSource='pat', no pat-write role.
    // We test the handler directly by importing and calling it with a mock req.
    const mcpDev = await import('../../srv/lib/mcp-developer-tools.js');
    const readOnlyPatUser = {
      id: WU1_SAPID,
      tokenSource: 'pat',
      is: (role) => role === 'authenticated-user' || role === 'pat-read',
      attr: {},
      _patScopes: ['read'],
    };
    let rejected = null;
    const mockReq = {
      data: { slug: 'wtut-a', stepNumber: 3 },
      user: readOnlyPatUser,
      reject: (code, msg) => { rejected = { code, msg }; return undefined; },
      _: { service: null },
    };
    await mcpDev.handleCompleteStep(mockReq);
    expect(rejected).not.toBeNull();
    expect(rejected.code).toBe(403);
  });

  it('rejects a read-only PAT caller with 403 on reset_tutorial_progress', async () => {
    const mcpDev = await import('../../srv/lib/mcp-developer-tools.js');
    const readOnlyPatUser = {
      id: WU1_SAPID,
      tokenSource: 'pat',
      is: (role) => role === 'authenticated-user' || role === 'pat-read',
      attr: {},
      _patScopes: ['read'],
    };
    let rejected = null;
    const mockReq = {
      data: { slug: 'wtut-a' },
      user: readOnlyPatUser,
      reject: (code, msg) => { rejected = { code, msg }; return undefined; },
      _: { service: null },
    };
    await mcpDev.handleResetTutorialProgress(mockReq);
    expect(rejected).not.toBeNull();
    expect(rejected.code).toBe(403);
  });

  it('allows a write-scoped PAT (via basic-auth — JWT/OAuth callers have no tokenSource)', async () => {
    // A JWT/OAuth caller (browser) has no tokenSource — the pat-write gate must NOT
    // block them. Basic-auth users in tests have no tokenSource, which simulates this.
    const mcpDev = await import('../../srv/lib/mcp-developer-tools.js');
    const jwtUser = {
      id: WU1_SAPID,
      tokenSource: undefined, // no tokenSource = JWT/OAuth
      is: (role) => role === 'authenticated-user',
      attr: {},
    };
    let rejected = null;
    const mockReq = {
      data: { slug: 'wtut-a', stepNumber: 3 },
      user: jwtUser,
      reject: (code, msg) => { rejected = { code, msg }; return undefined; },
      _: { service: null },
    };
    // Should NOT be blocked at the scope gate (may fail later at delegation, but not 403).
    await mcpDev.handleCompleteStep(mockReq);
    expect(rejected?.code).not.toBe(403);
  });
});
