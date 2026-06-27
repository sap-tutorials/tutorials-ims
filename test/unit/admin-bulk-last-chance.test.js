// test/unit/admin-bulk-last-chance.test.js
// Issue #622 Task 12. Unit tests for AdminService.sendLastChanceEmailsAllDormant.
//
// Pattern follows admin-last-chance-action.test.js (Task 11): deploy schema to
// in-memory SQLite, serve AdminService, send the action via cds.User.Privileged.
//
// Mock strategy: vi.mock cannot intercept modules loaded through cds.serve()'s
// loader, so we observe FailedEmails rows (with no SMTP transport, the
// production mail-client queues messages there) to verify the handler reached
// the send path with the expected payload.

import { describe, it, expect, beforeEach } from 'vitest';
import path from 'node:path';
import cds from '@sap/cds';

const schemaPath = path.join(process.cwd(), 'db', 'schema.cds');

/**
 * Seed two authors (Alice, Bob), each owning one tutorial with its
 * TutorialMeta row. Per-author knobs (level, lastNotifDate) are configurable
 * so each test case can shape who qualifies.
 *
 * `lastNotifDate`: 'old' = 80 days ago (older than 60-day dormancy cutoff),
 *                  'recent' = 1 day ago (newer than cutoff).
 */
async function seedFixture({
  aliceLevel = 3, aliceLastNotifDate = 'old',
  bobLevel = 3, bobLastNotifDate = 'old',
  minLevel = '3', dormancyDays = '60',
} = {}) {
  const { Tutorials, TutorialMeta, Users, ImsConfig } = cds.entities('com.sap.developers.ims');

  await DELETE.from(TutorialMeta);
  await DELETE.from(Tutorials);
  await DELETE.from(Users);
  await DELETE.from(ImsConfig);

  await INSERT.into(ImsConfig).entries([
    { ID: cds.utils.uuid(), key: 'staleDaysThreshold', value: '90' },
    { ID: cds.utils.uuid(), key: 'resendIntervalDays', value: '0' },
    { ID: cds.utils.uuid(), key: 'maxNotificationLevel', value: '3' },
    { ID: cds.utils.uuid(), key: 'isNotificationSendingAllowed', value: 'true' },
    { ID: cds.utils.uuid(), key: 'useDigestNotifications', value: 'true' },
    { ID: cds.utils.uuid(), key: 'lastChanceMinLevel', value: minLevel },
    { ID: cds.utils.uuid(), key: 'lastChanceDormancyDays', value: dormancyDays },
  ]);

  const aliceId = cds.utils.uuid();
  const bobId = cds.utils.uuid();
  await INSERT.into(Users).entries([
    { ID: aliceId, uuid: aliceId, email: 'alice@sap.com', displayName: 'Alice',
      firstName: 'Alice', lastName: 'Anderson', sapId: 'I012345' },
    { ID: bobId, uuid: bobId, email: 'bob@sap.com', displayName: 'Bob',
      firstName: 'Bob', lastName: 'Baker', sapId: 'I067890' },
  ]);

  const t1Id = cds.utils.uuid();
  const t2Id = cds.utils.uuid();
  const reviewedOld = new Date(Date.now() - 200 * 86400000).toISOString();
  const notifOld = new Date(Date.now() - 80 * 86400000).toISOString();
  const notifRecent = new Date(Date.now() - 1 * 86400000).toISOString();

  await INSERT.into(Tutorials).entries([
    { ID: t1Id, slug: 't1', title: 'Tutorial 1', status: 'ACTIVE', author_ID: aliceId },
    { ID: t2Id, slug: 't2', title: 'Tutorial 2', status: 'ACTIVE', author_ID: bobId },
  ]);

  await INSERT.into(TutorialMeta).entries([
    {
      ID: cds.utils.uuid(),
      tutorial_ID: t1Id,
      monitoredStatus: 'ACTIVE',
      reviewedDate: reviewedOld,
      notificationNumber: aliceLevel,
      lastNotificationDate: aliceLastNotifDate === 'recent' ? notifRecent : notifOld,
    },
    {
      ID: cds.utils.uuid(),
      tutorial_ID: t2Id,
      monitoredStatus: 'ACTIVE',
      reviewedDate: reviewedOld,
      notificationNumber: bobLevel,
      lastNotificationDate: bobLastNotifDate === 'recent' ? notifRecent : notifOld,
    },
  ]);
}

async function sendAsAdmin(srv, event, data) {
  const user = new cds.User.Privileged();
  return srv.tx({ user }, tx => tx.send({ event, data }));
}

describe('AdminService.sendLastChanceEmailsAllDormant', () => {
  let srv;

  beforeEach(async () => {
    await cds.deploy(schemaPath).to('sqlite::memory:');
    srv = await cds.serve('AdminService').from('./srv/admin-service');
    const { FailedEmails } = cds.entities('com.sap.developers.ims');
    await DELETE.from(FailedEmails);
  });

  it('dryRun=true: both authors qualify (L3 + old notif)', async () => {
    await seedFixture();
    const data = await sendAsAdmin(srv, 'sendLastChanceEmailsAllDormant', { dryRun: true });
    expect(data.authorsProcessed).toBe(2);
    expect(data.preview).toHaveLength(2);
    expect(data.emailsSent).toBe(0);
    expect(data.emailsFailed).toBe(0);
    const emails = data.preview.map(p => p.authorEmail).sort();
    expect(emails).toEqual(['alice@sap.com', 'bob@sap.com']);
    const { FailedEmails } = cds.entities('com.sap.developers.ims');
    const queued = await SELECT.from(FailedEmails);
    expect(queued).toHaveLength(0);
  });

  it('dryRun=true: bob has recent notif → only alice qualifies', async () => {
    await seedFixture({ bobLastNotifDate: 'recent' });
    const data = await sendAsAdmin(srv, 'sendLastChanceEmailsAllDormant', { dryRun: true });
    expect(data.authorsProcessed).toBe(1);
    expect(data.preview).toHaveLength(1);
    expect(data.preview[0].authorEmail).toBe('alice@sap.com');
    const { FailedEmails } = cds.entities('com.sap.developers.ims');
    const queued = await SELECT.from(FailedEmails);
    expect(queued).toHaveLength(0);
  });

  it('dryRun=true: bob level 2 → only alice qualifies (level threshold)', async () => {
    await seedFixture({ bobLevel: 2 });
    const data = await sendAsAdmin(srv, 'sendLastChanceEmailsAllDormant', { dryRun: true });
    expect(data.authorsProcessed).toBe(1);
    expect(data.preview).toHaveLength(1);
    expect(data.preview[0].authorEmail).toBe('alice@sap.com');
  });

  it('dryRun=false: fires one email per qualifying author', async () => {
    await seedFixture();
    const data = await sendAsAdmin(srv, 'sendLastChanceEmailsAllDormant', { dryRun: false });
    expect(data.authorsProcessed).toBe(2);
    // With no SMTP transport, mail-client returns success=false and queues into
    // FailedEmails. From the bulk handler's perspective the per-author send
    // came back unsuccessful, so emailsFailed=2, not emailsSent=2.
    expect(data.emailsSent + data.emailsFailed).toBe(2);
    const { FailedEmails } = cds.entities('com.sap.developers.ims');
    const queued = await SELECT.from(FailedEmails);
    // Two FailedEmails rows = one per qualifying author. The handler reached
    // sendNotificationEmail twice. At level 3 with no admin emails configured
    // the To field is empty (that's correct — determineRecipients(L3) routes
    // to the admin list, which is empty here); we instead verify each row
    // carries the last-chance template (the "Final notice" subject is unique
    // to this handler).
    expect(queued).toHaveLength(2);
    for (const row of queued) {
      expect(row.subject).toMatch(/final notice/i);
    }
    // Per-tutorial subject reflects each author's single tutorial: "1 tutorial".
    expect(queued.every(r => /1 tutorial/.test(r.subject))).toBe(true);
  });

  it('lastChanceMinLevel=99 → nobody qualifies', async () => {
    await seedFixture({ minLevel: '99' });
    const data = await sendAsAdmin(srv, 'sendLastChanceEmailsAllDormant', { dryRun: false });
    expect(data.authorsProcessed).toBe(0);
    expect(data.preview).toHaveLength(0);
    expect(data.emailsSent).toBe(0);
    expect(data.emailsFailed).toBe(0);
    const { FailedEmails } = cds.entities('com.sap.developers.ims');
    const queued = await SELECT.from(FailedEmails);
    expect(queued).toHaveLength(0);
  });
});
