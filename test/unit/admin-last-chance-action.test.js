// test/unit/admin-last-chance-action.test.js
// Issue #622 Task 11. Unit tests for AdminService.sendLastChanceEmail.
//
// Pattern follows admin-seed-embeddings.test.js: deploy schema to in-memory
// SQLite, serve AdminService, send the action through cds.User.Privileged
// (the action is @requires: 'Admin' inherited at the service level).
//
// Mock strategy:
//   - vi.mock cannot intercept modules loaded through cds.serve()'s loader
//     (see comment in admin-seed-embeddings.test.js). Mocks on
//     srv/lib/mail-client.js or 'nodemailer' do NOT take effect inside the
//     admin-service handler.
//   - Instead we let the real production srv/lib/mail-client.js run end-to-end
//     and observe the side effect: with no SMTP transport configured, it
//     queues the message into FailedEmails with the fully rendered subject
//     and HTML body. That is enough to verify (a) the handler reached
//     sendNotificationEmail, (b) it used the last-chance template (the
//     "Final notice" subject + the "Dear Alice" body string come from
//     srv/templates/notification/last-chance.html), and (c) the
//     `authorName` variable was resolved from the FK author display name.

import { describe, it, expect, beforeEach } from 'vitest';
import path from 'node:path';
import cds from '@sap/cds';

const schemaPath = path.join(process.cwd(), 'db', 'schema.cds');

async function seedFixture() {
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
  ]);

  const aliceId = cds.utils.uuid();
  await INSERT.into(Users).entries([{
    ID: aliceId,
    uuid: aliceId,
    email: 'alice@sap.com',
    displayName: 'Alice',
    firstName: 'Alice',
    lastName: 'Anderson',
    sapId: 'I012345',
  }]);

  const t1Id = cds.utils.uuid();
  const t2Id = cds.utils.uuid();
  const oldDate = new Date(Date.now() - 200 * 86400000).toISOString();

  await INSERT.into(Tutorials).entries([
    { ID: t1Id, slug: 't1', title: 'Tutorial 1', status: 'ACTIVE', author_ID: aliceId },
    { ID: t2Id, slug: 't2', title: 'Tutorial 2', status: 'ACTIVE', author_ID: aliceId },
  ]);

  await INSERT.into(TutorialMeta).entries([
    {
      ID: cds.utils.uuid(),
      tutorial_ID: t1Id,
      monitoredStatus: 'ACTIVE',
      reviewedDate: oldDate,
      notificationNumber: 1,
      lastNotificationDate: oldDate,
    },
    {
      ID: cds.utils.uuid(),
      tutorial_ID: t2Id,
      monitoredStatus: 'ACTIVE',
      reviewedDate: oldDate,
      notificationNumber: 2,
      lastNotificationDate: oldDate,
    },
  ]);
}

/** Send an action on the AdminService as a privileged (Admin) user */
async function sendAsAdmin(srv, event, data) {
  const user = new cds.User.Privileged();
  return srv.tx({ user }, tx => tx.send({ event, data }));
}

describe('AdminService.sendLastChanceEmail', () => {
  let srv;

  beforeEach(async () => {
    await cds.deploy(schemaPath).to('sqlite::memory:');
    srv = await cds.serve('AdminService').from('./srv/admin-service');
    await seedFixture();
    // FailedEmails captures the queued message when transport is absent;
    // tests rely on this side-effect to verify handler reached the send path.
    const { FailedEmails } = cds.entities('com.sap.developers.ims');
    await DELETE.from(FailedEmails);
  });

  it('dryRun=true returns payload without sending', async () => {
    const data = await sendAsAdmin(srv, 'sendLastChanceEmail', {
      authorEmail: 'alice@sap.com', dryRun: true,
    });
    expect(data.success).toBe(true);
    expect(data.recipientTo).toBe('alice@sap.com');
    expect(data.tutorialsIncluded).toBe(2);
    expect(data.tutorialSlugs).toEqual(expect.arrayContaining(['t1', 't2']));
    // No FailedEmails row created — handler short-circuited before send.
    const { FailedEmails } = cds.entities('com.sap.developers.ims');
    const queued = await SELECT.from(FailedEmails);
    expect(queued).toHaveLength(0);
  });

  it('dryRun=false reaches send path with last-chance template rendered for author', async () => {
    const data = await sendAsAdmin(srv, 'sendLastChanceEmail', {
      authorEmail: 'alice@sap.com', dryRun: false,
    });
    // With no SMTP transport in the unit-test env, sendNotificationEmail
    // returns success=false and inserts a FailedEmails row containing the
    // rendered subject + html. That's our proof the handler invoked the
    // mail-client with the right template + variables.
    expect(data.recipientTo).toBe('alice@sap.com');
    expect(data.tutorialsIncluded).toBe(2);
    expect(data.tutorialSlugs).toEqual(expect.arrayContaining(['t1', 't2']));

    const { FailedEmails } = cds.entities('com.sap.developers.ims');
    const queued = await SELECT.from(FailedEmails);
    expect(queued).toHaveLength(1);
    expect(queued[0].to).toBe('alice@sap.com');
    // Subject "Final notice: 2 tutorials pending retirement" comes from the
    // sendLastChanceEmail handler (not the legacy digest subject builder).
    expect(queued[0].subject).toMatch(/final notice/i);
    // "Dear Alice" appears in last-chance.html when authorName='Alice' (the
    // displayName from the Users FK). Proves variables.authorName wired.
    expect(queued[0].body).toContain('Dear Alice');
    expect(queued[0].body).toContain('t1');
    expect(queued[0].body).toContain('t2');
  });

  it('author with no stale tutorials returns success=false', async () => {
    const data = await sendAsAdmin(srv, 'sendLastChanceEmail', {
      authorEmail: 'nobody@sap.com', dryRun: true,
    });
    expect(data.success).toBe(false);
    expect(data.error).toMatch(/no stale tutorials/i);
    const { FailedEmails } = cds.entities('com.sap.developers.ims');
    const queued = await SELECT.from(FailedEmails);
    expect(queued).toHaveLength(0);
  });

  it('case-insensitive author match', async () => {
    const data = await sendAsAdmin(srv, 'sendLastChanceEmail', {
      authorEmail: 'ALICE@sap.com', dryRun: true,
    });
    expect(data.success).toBe(true);
    expect(data.tutorialsIncluded).toBe(2);
  });
});
