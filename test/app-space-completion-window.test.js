import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import cds from '@sap/cds';

const project = cds.test('serve', '--project', '.', '--in-memory');

// Issue #2866: App Space prize credit must reflect work done DURING the event.
// getAppSpaceProgress now downgrades a COMPLETED TaskRecord whose completionDate
// falls outside the event's inclusive [startDate, endDate] window to the plain
// status 'COMPLETED_OUT_OF_WINDOW'. Gating applies ONLY to TUTORIAL items and
// ONLY when BOTH event dates are present (fail-open otherwise). The Vue client
// gates track/prize completion strictly on === 'COMPLETED', so a downgraded item
// stops counting automatically.

const auth = { auth: { username: 'developer', password: 'developer' } };

// Window: 2026-10-10T00:00:00Z .. 2026-10-12T23:59:59Z (gated event).
const GATED_EVENT   = 28660001;
const TUT_LEGACY    = 28660010;   // the single TUTORIAL item's taskLegacyId
const NULLSTART_EVENT = 28660002; // endDate only → fail-open
const NULLEND_EVENT   = 28660003; // startDate only → fail-open

// Resolve the returned item's status for a given event.
async function statusFor(eventLegacyId) {
  const { data } = await project.get(`/api/getAppSpaceProgress(eventLegacyId=${eventLegacyId})`, auth);
  const items = data.paths.flatMap(p => p.items);
  return items;
}

// Overwrite the developer user's TaskRecord for TUT_LEGACY with a specific
// status/completionDate so each test controls exactly one record.
async function setRecord({ status = 'COMPLETED', completionDate, taskType = 'TUTORIAL', taskLegacyId = TUT_LEGACY } = {}) {
  const { TaskRecords } = cds.entities('com.sap.developers.ims');
  await DELETE.from(TaskRecords).where({ user_ID: 'w2866-user', taskLegacyId, taskType });
  await INSERT.into(TaskRecords).entries({
    user_ID: 'w2866-user', taskLegacyId, taskType, status, progress: 100,
    completionDate: completionDate === undefined ? null : completionDate,
  });
}

describe('App Space completion time window (#2866)', () => {
  beforeAll(async () => {
    const { Events, Missions, CompletionPaths, CompletionPathItems, Tutorials, Users } =
      cds.entities('com.sap.developers.ims');

    // resolveDbUserScoped matches on Users.sapId; mocked basic auth sets sapId = username.
    await INSERT.into(Users).entries({ ID: 'w2866-user', sapId: 'developer', legacyId: 28669999 });

    await INSERT.into(Tutorials).entries([
      { ID: 'w2866-t1', legacyId: TUT_LEGACY, slug: 'window-tut', title: 'Window Tut', status: 'ACTIVE' },
    ]);
    await INSERT.into(Missions).entries([
      { ID: 'w2866-mg', legacyId: 28660100, slug: 'win-gated',    title: 'Gated',    description: 'd' },
      { ID: 'w2866-ms', legacyId: 28660200, slug: 'win-nullstart', title: 'NullStart', description: 'd' },
      { ID: 'w2866-me', legacyId: 28660300, slug: 'win-nullend',   title: 'NullEnd',   description: 'd' },
    ]);
    await INSERT.into(CompletionPaths).entries([
      { ID: 'w2866-pg', legacyId: 28660110, name: 'Gated Path',    mission_ID: 'w2866-mg' },
      { ID: 'w2866-ps', legacyId: 28660210, name: 'NullStart Path', mission_ID: 'w2866-ms' },
      { ID: 'w2866-pe', legacyId: 28660310, name: 'NullEnd Path',   mission_ID: 'w2866-me' },
    ]);
    await INSERT.into(CompletionPathItems).entries([
      { ID: 'w2866-ig', path_ID: 'w2866-pg', taskLegacyId: TUT_LEGACY, taskType: 'TUTORIAL',   itemOrder: 1 },
      // A non-tutorial item on the gated path, to prove pass-through.
      { ID: 'w2866-ic', path_ID: 'w2866-pg', taskLegacyId: 28660020,   taskType: 'CHECKPOINT', itemOrder: 2 },
      { ID: 'w2866-is', path_ID: 'w2866-ps', taskLegacyId: TUT_LEGACY, taskType: 'TUTORIAL',   itemOrder: 1 },
      { ID: 'w2866-ie', path_ID: 'w2866-pe', taskLegacyId: TUT_LEGACY, taskType: 'TUTORIAL',   itemOrder: 1 },
    ]);
    await INSERT.into(Events).entries([
      { ID: 'w2866-eg', legacyId: GATED_EVENT, name: 'Gated Event', eventType: 'OTHER',
        startDate: '2026-10-10T00:00:00Z', endDate: '2026-10-12T23:59:59Z', mission_ID: 'w2866-mg' },
      { ID: 'w2866-es', legacyId: NULLSTART_EVENT, name: 'Null Start', eventType: 'OTHER',
        startDate: null, endDate: '2026-10-12T23:59:59Z', mission_ID: 'w2866-ms' },
      { ID: 'w2866-ee', legacyId: NULLEND_EVENT, name: 'Null End', eventType: 'OTHER',
        startDate: '2026-10-10T00:00:00Z', endDate: null, mission_ID: 'w2866-me' },
    ]);
  });

  afterAll(async () => {
    const { Events, Missions, CompletionPaths, CompletionPathItems, Tutorials, Users, TaskRecords } =
      cds.entities('com.sap.developers.ims');
    await DELETE.from(TaskRecords).where({ user_ID: 'w2866-user' });
    await DELETE.from(Users).where({ ID: 'w2866-user' });
    await DELETE.from(CompletionPathItems).where({ ID: { in: ['w2866-ig', 'w2866-ic', 'w2866-is', 'w2866-ie'] } });
    await DELETE.from(CompletionPaths).where({ ID: { in: ['w2866-pg', 'w2866-ps', 'w2866-pe'] } });
    await DELETE.from(Events).where({ legacyId: { in: [GATED_EVENT, NULLSTART_EVENT, NULLEND_EVENT] } });
    await DELETE.from(Missions).where({ ID: { in: ['w2866-mg', 'w2866-ms', 'w2866-me'] } });
    await DELETE.from(Tutorials).where({ ID: 'w2866-t1' });
  });

  const tut = (items) => items.find(i => i.type === 'TUTORIAL');

  it('in-window COMPLETED stays COMPLETED', async () => {
    await setRecord({ completionDate: '2026-10-11T12:00:00Z' });
    expect(tut(await statusFor(GATED_EVENT)).status).toBe('COMPLETED');
  });

  it('completed before startDate → COMPLETED_OUT_OF_WINDOW', async () => {
    await setRecord({ completionDate: '2026-09-01T00:00:00Z' });
    expect(tut(await statusFor(GATED_EVENT)).status).toBe('COMPLETED_OUT_OF_WINDOW');
  });

  it('completed after endDate → COMPLETED_OUT_OF_WINDOW', async () => {
    await setRecord({ completionDate: '2026-11-01T00:00:00Z' });
    expect(tut(await statusFor(GATED_EVENT)).status).toBe('COMPLETED_OUT_OF_WINDOW');
  });

  it('completionDate === startDate counts (inclusive)', async () => {
    await setRecord({ completionDate: '2026-10-10T00:00:00Z' });
    expect(tut(await statusFor(GATED_EVENT)).status).toBe('COMPLETED');
  });

  it('completionDate === endDate counts (inclusive)', async () => {
    await setRecord({ completionDate: '2026-10-12T23:59:59Z' });
    expect(tut(await statusFor(GATED_EVENT)).status).toBe('COMPLETED');
  });

  it('null completionDate on a gated event → COMPLETED_OUT_OF_WINDOW', async () => {
    await setRecord({ completionDate: null });
    expect(tut(await statusFor(GATED_EVENT)).status).toBe('COMPLETED_OUT_OF_WINDOW');
  });

  it('event with null startDate → no gating (fail-open)', async () => {
    await setRecord({ completionDate: '2026-09-01T00:00:00Z' }); // out of range but window not gatable
    expect(tut(await statusFor(NULLSTART_EVENT)).status).toBe('COMPLETED');
  });

  it('event with null endDate → no gating (fail-open)', async () => {
    await setRecord({ completionDate: '2026-11-01T00:00:00Z' }); // out of range but window not gatable
    expect(tut(await statusFor(NULLEND_EVENT)).status).toBe('COMPLETED');
  });

  it('IN_PROGRESS record passes through unchanged', async () => {
    await setRecord({ status: 'IN_PROGRESS', completionDate: null });
    expect(tut(await statusFor(GATED_EVENT)).status).toBe('IN_PROGRESS');
  });

  it('non-TUTORIAL (CHECKPOINT) COMPLETED is never downgraded', async () => {
    // CHECKPOINT completed with an out-of-range date on the gated event.
    await setRecord({ taskType: 'CHECKPOINT', taskLegacyId: 28660020, completionDate: '2026-09-01T00:00:00Z' });
    const items = await statusFor(GATED_EVENT);
    const cp = items.find(i => i.type === 'CHECKPOINT');
    expect(cp.status).toBe('COMPLETED');
  });
});
