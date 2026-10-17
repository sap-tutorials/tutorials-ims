// test/hybrid/2811-tutorial-variables.test.js
//
// Verifies that replaceVariablesForSlug persists variable rows to HANA
// and that the round-trip (flat columns + configJson) is correct. (#2811)
// Requires cds bind (real HANA + hybrid profile). Run under the hybrid project.
//
// Issue: #2811

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import cds from '@sap/cds';
import { isSafeForWrites } from './_guard.js';
import { replaceVariablesForSlug } from '../../srv/lib/variables-publish.js';

cds.test('serve', '--project', '.', '--profile', 'hybrid');

describe.runIf(isSafeForWrites())('#2811 TutorialVariables (hybrid)', () => {
  let db;
  let testSlug;
  let testTutorialId;

  const TEST_VAR = {
    name: 'groupNumber',
    label: 'Your BTP Trial Group Number',
    type: 'string',
    maxLength: 6,
    required: true,
    placeholder: 'XXX',
    default: {
      from: 'email',
      pattern: '(?<=@).+'
    }
  };

  beforeAll(async () => {
    db = await cds.connect.to('db');
    // Pick any existing tutorial slug so we don't need to insert fixture rows.
    const { Tutorials } = cds.entities('com.sap.developers.ims');
    const t = await db.run(SELECT.one.from(Tutorials).columns('ID', 'slug'));
    expect(t).toBeTruthy();
    testSlug = t.slug;
    testTutorialId = t.ID;
  }, 30_000);

  afterAll(async () => {
    // Clean up any test rows we inserted.
    if (db && testTutorialId) {
      const { TutorialVariables } = cds.entities('com.sap.developers.ims');
      await db.run(DELETE.from(TutorialVariables).where({ tutorial_ID: testTutorialId }));
    }
  }, 30_000);

  it('persists a variable row and reads it back correctly', async () => {
    const { TutorialVariables } = cds.entities('com.sap.developers.ims');

    const result = await replaceVariablesForSlug(db, testSlug, [TEST_VAR]);
    expect(result.ok).toBe(true);
    expect(result.count).toBe(1);

    const rows = await db.run(SELECT.from(TutorialVariables).where({ tutorial_ID: testTutorialId }));
    expect(rows).toHaveLength(1);

    const row = rows[0];
    expect(row.varName).toBe('groupNumber');
    expect(row.isRequired).toBe(true);
    expect(JSON.parse(row.configJson).default.from).toBe('email');
  }, 30_000);

  it('REPLACE: second call replaces, not appends', async () => {
    const { TutorialVariables } = cds.entities('com.sap.developers.ims');

    await replaceVariablesForSlug(db, testSlug, [TEST_VAR]);
    // Second call with same slug — must have exactly 1 row, not 2.
    const result = await replaceVariablesForSlug(db, testSlug, [TEST_VAR]);
    expect(result.ok).toBe(true);

    const rows = await db.run(SELECT.from(TutorialVariables).where({ tutorial_ID: testTutorialId }));
    expect(rows).toHaveLength(1);
  }, 30_000);

  it('returns tutorial_not_found for an unknown slug', async () => {
    const result = await replaceVariablesForSlug(db, 'no-such-slug-xyz-99999', [TEST_VAR]);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('tutorial_not_found');
  }, 30_000);
});
