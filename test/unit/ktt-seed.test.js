// test/unit/ktt-seed.test.js
// Regression for spec §7.1/§7.2: the KttLessons catalog is now SEEDED from
// db/data/com.sap.developers.ims-KttLessons.csv. This test deliberately does
// NOT insert any KttLessons row — it relies solely on the CSV seed. It would
// have caught the original gap where the table shipped EMPTY and every KTT
// completion was silently dropped from MyCompletions.
//
// Flow: force KTT_ENABLED on → POST completeLesson for a REAL seeded lesson →
// assert getMyCompletedTutorials surfaces it with the SEEDED title + slug.

import cds from '@sap/cds';
import { expect, test, beforeAll, afterAll } from 'vitest';
import { getMyCompletedTutorials } from '../../srv/lib/user-progress.js';
import { __setFlagForTest, __resetFlagsForTest } from '../../srv/lib/feature-flags/db-flags.js';

const { POST } = cds.test('serve', '--project', '.', '--in-memory');

// Real seeded lesson (unit 1, lesson 1) — see db/data/…-KttLessons.csv.
const SEEDED_LEGACY_ID = 90001;
const SEEDED_SLUG = 'unit-1-platform-lesson-1';
const SEEDED_TITLE = "Who's SAP, and what's BTP?";

let authed;
beforeAll(async () => {
  __setFlagForTest('KTT_ENABLED', true);
  const { Users } = cds.entities('com.sap.developers.ims');
  await INSERT.into(Users).entries({ ID: cds.utils.uuid(), uuid: 'seeduser', sapId: 'seeduser', legacyId: 42 });
  authed = { auth: { username: 'seeduser', password: 'seeduser' } };
});

afterAll(() => {
  __resetFlagsForTest();
});

test('KttLessons catalog is seeded from the generated CSV (no manual insert)', async () => {
  const { KttLessons } = cds.entities('com.sap.developers.ims');
  const seeded = await SELECT.one.from(KttLessons).where({ legacyId: SEEDED_LEGACY_ID });
  expect(seeded).toBeDefined();
  expect(seeded.slug).toBe(SEEDED_SLUG);
  expect(seeded.title).toBe(SEEDED_TITLE);
  const count = await SELECT.from(KttLessons);
  expect(count.length).toBe(12);
});

test('a completed lesson surfaces in MyCompletions with the SEEDED title/slug', async () => {
  // The island sends the lesson id as lessonSlug; the server keys off legacyId.
  const body = { lessonSlug: SEEDED_SLUG, legacyId: SEEDED_LEGACY_ID, title: SEEDED_TITLE };
  const r = await POST('/ktt/completeLesson', body, authed);
  expect(r.data.ok).toBe(true);

  const completions = await getMyCompletedTutorials({ id: 'seeduser' });
  const kttEntry = completions.find((e) => e.kind === 'ktt' && e.slug === SEEDED_SLUG);
  expect(kttEntry).toBeDefined();
  // title/slug come from the SEEDED catalog row via the legacyId join, not from
  // the client payload — proving the seed is what makes MyCompletions work.
  expect(kttEntry.title).toBe(SEEDED_TITLE);
  expect(kttEntry.slug).toBe(SEEDED_SLUG);
});
