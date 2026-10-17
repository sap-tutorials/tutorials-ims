// test/unit/variables-publish.test.js
//
// Fast in-memory SQLite test for replaceVariablesForSlug.
// Verifies: flat column mapping, configJson round-trip, REPLACE semantics,
// case-insensitive slug handling, empty-array clear, tutorial_not_found.
// No HANA needed — pure mapping test.

import { describe, it, expect, beforeAll } from 'vitest';
import path from 'node:path';
import cds from '@sap/cds';
import { replaceVariablesForSlug } from '../../srv/lib/variables-publish.js';

describe('replaceVariablesForSlug (unit/sqlite)', () => {
  let db;

  beforeAll(async () => {
    await cds.deploy(path.join(process.cwd(), 'db', 'schema.cds')).to('sqlite::memory:');
    db = cds.db;
  });

  it('maps flat columns and configJson correctly', async () => {
    const { Tutorials, TutorialVariables } = cds.entities('com.sap.developers.ims');
    const ID = cds.utils.uuid();
    await db.run(INSERT.into(Tutorials).entries({ ID, slug: 'var-test', title: 'Var Test' }));

    const v = {
      name: 'groupNumber',
      label: 'Group Number',
      type: 'string',
      maxLength: 6,
      required: true,
      placeholder: 'XXX',
      default: { from: 'email', pattern: '(?<=@).+' }
    };
    const result = await replaceVariablesForSlug(db, 'var-test', [v]);
    expect(result.ok).toBe(true);
    expect(result.count).toBe(1);

    const rows = await db.run(SELECT.from(TutorialVariables).where({ tutorial_ID: ID }));
    expect(rows).toHaveLength(1);
    const row = rows[0];

    // Flat columns
    expect(row.varName).toBe('groupNumber');
    expect(row.varLabel).toBe('Group Number');
    expect(row.varType).toBe('string');
    expect(row.maxLength).toBe(6);
    expect(row.isRequired).toBe(true);
    expect(row.placeholder).toBe('XXX');
    expect(row.defaultFrom).toBe('email');
    expect(row.defaultPattern).toBe('(?<=@).+');
    expect(row.sortOrder).toBe(0);

    // configJson round-trip
    const parsed = JSON.parse(row.configJson);
    expect(parsed.name).toBe('groupNumber');
    expect(parsed.default.from).toBe('email');
  });

  it('is case-insensitive on slug (uppercased input)', async () => {
    const { Tutorials, TutorialVariables } = cds.entities('com.sap.developers.ims');
    const ID = cds.utils.uuid();
    await db.run(INSERT.into(Tutorials).entries({ ID, slug: 'ci-slug', title: 'CI Slug' }));

    const result = await replaceVariablesForSlug(db, 'CI-SLUG', [{ name: 'x', label: 'X', type: 'string' }]);
    expect(result.ok).toBe(true);

    const rows = await db.run(SELECT.from(TutorialVariables).where({ tutorial_ID: ID }));
    expect(rows).toHaveLength(1);
  });

  it('REPLACE: second call replaces all rows for the slug', async () => {
    const { Tutorials, TutorialVariables } = cds.entities('com.sap.developers.ims');
    const ID = cds.utils.uuid();
    await db.run(INSERT.into(Tutorials).entries({ ID, slug: 'replace-test', title: 'Replace Test' }));

    await replaceVariablesForSlug(db, 'replace-test', [
      { name: 'a', label: 'A', type: 'string' },
      { name: 'b', label: 'B', type: 'number' },
    ]);
    // Second call with only one variable — result should have 1 row, not 2.
    await replaceVariablesForSlug(db, 'replace-test', [{ name: 'c', label: 'C', type: 'string' }]);

    const rows = await db.run(SELECT.from(TutorialVariables).where({ tutorial_ID: ID }));
    expect(rows).toHaveLength(1);
    expect(rows[0].varName).toBe('c');
  });

  it('empty array clears all variable rows', async () => {
    const { Tutorials, TutorialVariables } = cds.entities('com.sap.developers.ims');
    const ID = cds.utils.uuid();
    await db.run(INSERT.into(Tutorials).entries({ ID, slug: 'clear-test', title: 'Clear Test' }));

    await replaceVariablesForSlug(db, 'clear-test', [{ name: 'x', label: 'X', type: 'string' }]);
    const result = await replaceVariablesForSlug(db, 'clear-test', []);
    expect(result.ok).toBe(true);
    expect(result.count).toBe(0);

    const rows = await db.run(SELECT.from(TutorialVariables).where({ tutorial_ID: ID }));
    expect(rows).toHaveLength(0);
  });

  it('returns tutorial_not_found for unknown slug', async () => {
    const result = await replaceVariablesForSlug(db, 'no-such-slug-zzz', [{ name: 'x', label: 'X', type: 'string' }]);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('tutorial_not_found');
  });

  it('assigns sortOrder by array position', async () => {
    const { Tutorials, TutorialVariables } = cds.entities('com.sap.developers.ims');
    const ID = cds.utils.uuid();
    await db.run(INSERT.into(Tutorials).entries({ ID, slug: 'order-test', title: 'Order Test' }));

    await replaceVariablesForSlug(db, 'order-test', [
      { name: 'first', label: 'First', type: 'string' },
      { name: 'second', label: 'Second', type: 'string' },
    ]);

    const rows = await db.run(SELECT.from(TutorialVariables).where({ tutorial_ID: ID }).orderBy({ sortOrder: 'asc' }));
    expect(rows[0].varName).toBe('first');
    expect(rows[0].sortOrder).toBe(0);
    expect(rows[1].varName).toBe('second');
    expect(rows[1].sortOrder).toBe(1);
  });
});
