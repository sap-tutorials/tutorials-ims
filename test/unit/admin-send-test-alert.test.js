import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import path from 'node:path';
import cds from '@sap/cds';

// #1469: AdminService.sendTestAlert bound action. Verifies handler registration,
// entity-level @requires:'Admin' auth gate, severity normalization, and the
// raiseTest call contract.
//
// The real cds.connect.to('alerts') can't resolve kind:'alert-notification-memory'
// in the unit bootstrap — CAP's service factory rejects custom kinds before the
// plugin's cds.on('connect') fires (OOM-crashes the worker if attempted). The
// real raiseTest paths (delivered/disabled/error) are already covered by
// test/unit/alerting.test.js. This test uses the globalThis.__TEST_raiseTest
// injection hook (same pattern as __TEST_emitJobAudit at srv/admin-service.js
// ~line 2971) to isolate handler logic from ANS plumbing.

const schemaPath = path.join(process.cwd(), 'db', 'schema.cds');
const CHAT_ID = '00000000-0000-0000-0000-000000001469';

async function seedChatSettings(fields) {
  const { ChatSettings } = cds.entities('com.sap.developers.ims');
  await DELETE.from(ChatSettings);
  await INSERT.into(ChatSettings).entries({ ID: CHAT_ID, ...fields });
}

async function sendAsAdmin(srv, event, data) {
  const user = new cds.User.Privileged();
  return srv.tx({ user }, tx => tx.send({ event, entity: 'ChatSettings', data }));
}

describe('AdminService sendTestAlert action (#1469)', () => {
  let srv;
  let mockRaiseTest;

  beforeEach(async () => {
    await cds.deploy(schemaPath).to('sqlite::memory:');
    srv = await cds.serve('AdminService').from('./srv/admin-service');
    mockRaiseTest = vi.fn();
    globalThis.__TEST_raiseTest = mockRaiseTest;
  });

  afterEach(() => {
    delete globalThis.__TEST_raiseTest;
    vi.restoreAllMocks();
  });

  it('reports outcome "delivered" and calls raiseTest with correct envelope', async () => {
    mockRaiseTest.mockResolvedValue({ outcome: 'delivered' });
    await seedChatSettings({ alertsEnabled: true });
    const res = await sendAsAdmin(srv, 'sendTestAlert', {});
    expect(res.outcome).toBe('delivered');
    expect(res.eventType).toBe('AlertingTest');
    expect(res.severity).toBe('ERROR'); // default
    expect(mockRaiseTest).toHaveBeenCalledOnce();
    const call = mockRaiseTest.mock.calls[0][0];
    expect(call.eventType).toBe('AlertingTest');
    expect(call.severity).toBe('ERROR');
    expect(call.resource.resourceName).toMatch(/^admin-test:/);
  });

  it('reports outcome "disabled" when raiseTest returns disabled', async () => {
    mockRaiseTest.mockResolvedValue({ outcome: 'disabled' });
    await seedChatSettings({ alertsEnabled: false });
    const res = await sendAsAdmin(srv, 'sendTestAlert', {});
    expect(res.outcome).toBe('disabled');
    expect(res.eventType).toBe('AlertingTest');
  });

  it('normalizes an unknown severity to ERROR', async () => {
    mockRaiseTest.mockResolvedValue({ outcome: 'delivered' });
    await seedChatSettings({ alertsEnabled: true });
    const res = await sendAsAdmin(srv, 'sendTestAlert', { severity: 'BOGUS' });
    expect(res.severity).toBe('ERROR');
    expect(mockRaiseTest.mock.calls[0][0].severity).toBe('ERROR');
  });

  it('accepts a valid severity (WARNING) and echoes it back', async () => {
    mockRaiseTest.mockResolvedValue({ outcome: 'delivered' });
    await seedChatSettings({ alertsEnabled: true });
    const res = await sendAsAdmin(srv, 'sendTestAlert', { severity: 'WARNING' });
    expect(res.severity).toBe('WARNING');
    expect(mockRaiseTest.mock.calls[0][0].severity).toBe('WARNING');
  });

  it('is auth-gated: anonymous invocation is rejected', async () => {
    // No __TEST_raiseTest call needed — auth fails before the handler body runs.
    await seedChatSettings({ alertsEnabled: true });
    const anon = new cds.User({ id: 'anonymous' });
    await expect(
      srv.tx({ user: anon }, tx => tx.send({ event: 'sendTestAlert', entity: 'ChatSettings', data: {} }))
    ).rejects.toMatchObject({ code: expect.any(Number) });
  });
});
