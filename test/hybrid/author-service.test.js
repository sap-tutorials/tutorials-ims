import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import cds from '@sap/cds';
import { isSafeForWrites } from './_guard.js';

cds.test('serve', '--project', '.', '--profile', 'hybrid');

const TEST_PREFIX = '__TEST__';
const RUN_ID = `${TEST_PREFIX}-${Date.now()}`;
const TEST_EMAIL = `${RUN_ID}@example.com`;
const TEST_SLUG = `${RUN_ID}-slug`;
const TEST_UUID = `${RUN_ID}-uuid`;
const TEST_TITLE = `${TEST_PREFIX} author-service test tutorial`;

describe.runIf(isSafeForWrites())('AuthorService on HANA', () => {
  let createdUserId;
  let createdTutorialId;
  let createdMetaId;

  beforeAll(async () => {
    const { Users, Tutorials, TutorialMeta } = cds.entities('com.sap.developers.ims');
    const { getNextLegacyId } = await import('../../srv/lib/legacy-id.js');
    const db = await cds.connect.to('db');

    // Seed user
    const userLegacyId = await getNextLegacyId('Users', db);
    await INSERT.into(Users).entries({
      uuid: TEST_UUID,
      email: TEST_EMAIL,
      firstName: TEST_PREFIX,
      lastName: 'AuthorTest',
      displayName: `${TEST_PREFIX} AuthorTest`,
      legacyId: userLegacyId
    });
    const insertedUser = await SELECT.one.from(Users).where({ email: TEST_EMAIL });
    expect(insertedUser).toBeTruthy();
    createdUserId = insertedUser.ID;

    // Seed tutorial
    const tutorialLegacyId = await getNextLegacyId('Tutorials', db);
    await INSERT.into(Tutorials).entries({
      slug: TEST_SLUG,
      title: TEST_TITLE,
      status: 'ACTIVE',
      legacyId: tutorialLegacyId
    });
    const insertedTutorial = await SELECT.one.from(Tutorials).where({ slug: TEST_SLUG });
    expect(insertedTutorial).toBeTruthy();
    createdTutorialId = insertedTutorial.ID;

    // Seed TutorialMeta linking tutorial → owner email
    const metaLegacyId = await getNextLegacyId('TutorialMeta', db);
    await INSERT.into(TutorialMeta).entries({
      tutorial_ID: createdTutorialId,
      owner: `${TEST_PREFIX} AuthorTest`,
      ownerEmail: TEST_EMAIL,
      monitoredStatus: 'ACTIVE',
      notificationNumber: 0,
      legacyId: metaLegacyId
    });
    const insertedMeta = await SELECT.one.from(TutorialMeta).where({ tutorial_ID: createdTutorialId });
    expect(insertedMeta).toBeTruthy();
    createdMetaId = insertedMeta.ID;
  });

  afterAll(async () => {
    const { Users, Tutorials, TutorialMeta } = cds.entities('com.sap.developers.ims');

    // Reverse FK order: TutorialMeta → Tutorials → Users
    if (createdMetaId) {
      try { await DELETE.from(TutorialMeta).where({ ID: createdMetaId }); } catch (e) { /* swallow */ }
    }
    if (createdTutorialId) {
      try { await DELETE.from(Tutorials).where({ ID: createdTutorialId }); } catch (e) { /* swallow */ }
    }
    if (createdUserId) {
      try { await DELETE.from(Users).where({ ID: createdUserId }); } catch (e) { /* swallow */ }
    }
  });

  it('MyTutorialsView returns the seeded row on real HANA', async () => {
    const { MyTutorialsView } = cds.entities('com.sap.developers.ims');
    const rows = await SELECT.from(MyTutorialsView).where({ ownerEmail: TEST_EMAIL });
    expect(rows.length).toBeGreaterThan(0);
    const match = rows.find(r => r.ID === createdTutorialId);
    expect(match).toBeTruthy();
    expect(match.slug).toBe(TEST_SLUG);
    expect(match.title).toBe(TEST_TITLE);
    expect(match.ownerEmail).toBe(TEST_EMAIL);
    expect(match.ownerUserId).toBe(TEST_UUID);
  });

  it('reviewTutorial bumps modifiedAt via the managed aspect on TutorialMeta', async () => {
    const { TutorialMeta } = cds.entities('com.sap.developers.ims');
    const { reviewTutorial } = await import('../../srv/lib/tutorial-review.js');

    const before = await SELECT.one.from(TutorialMeta).where({ ID: createdMetaId });
    expect(before).toBeTruthy();

    // Ensure clock advances by at least 1ms even on fast systems
    await new Promise((resolve) => setTimeout(resolve, 5));

    await reviewTutorial(createdTutorialId);

    const after = await SELECT.one.from(TutorialMeta).where({ ID: createdMetaId });
    expect(after).toBeTruthy();
    expect(after.reviewedDate).toBeTruthy();
    expect(after.notificationNumber).toBe(0);

    const beforeMs = Date.parse(before.modifiedAt || '2000-01-01');
    const afterMs = Date.parse(after.modifiedAt || '2000-01-01');
    expect(afterMs).toBeGreaterThan(beforeMs);
  });
});
