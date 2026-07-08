import { describe, it, expect, beforeAll } from 'vitest';
import cds from '@sap/cds';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  VERB_DEFAULTS, SHELF_DEFAULTS,
  VERB_KEYS_SORTED, SHELF_KEYS_SORTED,
} from '../../../srv/lib/homepage/verb-shelf-defaults.js';   // #1089

const project = cds.test('serve', '--project', '.', '--in-memory');

const ADMIN_AUTH = { auth: { username: 'admin', password: 'admin' } };

describe('AdminService — VerbDefinitions/ShelfDefinitions auto-init (#759 PR 1)', () => {
  let db;
  beforeAll(async () => {
    db = await cds.connect.to('db');
  });

  it('auto-creates one VerbDefinitions row per VERB_DEFAULTS entry when reading an empty table', async () => {
    // (#1029) MODEL added as 7th verb. (#1089) cardinality now derived
    // from VERB_DEFAULTS — vocab expansions no longer silently regress.
    await db.run(DELETE.from('com.sap.developers.ims.VerbDefinitions'));
    const res = await project.get('/admin/VerbDefinitions', ADMIN_AUTH);
    expect(res.status).toBe(200);
    const rows = res.data.value;
    expect(rows.length).toBe(VERB_DEFAULTS.length);
    const keys = rows.map(r => r.verbKey).sort();
    expect(keys).toEqual([...VERB_KEYS_SORTED]);
    expect(rows.every(r => r.authoringStatus === 'BLANK')).toBe(true);
  });

  it('auto-creates one ShelfDefinitions row per SHELF_DEFAULTS entry when reading an empty table', async () => {
    await db.run(DELETE.from('com.sap.developers.ims.ShelfDefinitions'));
    const res = await project.get('/admin/ShelfDefinitions', ADMIN_AUTH);
    expect(res.status).toBe(200);
    const rows = res.data.value;
    expect(rows.length).toBe(SHELF_DEFAULTS.length);
    const keys = rows.map(r => r.shelfKey).sort();
    expect(keys).toEqual([...SHELF_KEYS_SORTED]);
  });

  it('idempotent — second read does not duplicate', async () => {
    await project.get('/admin/VerbDefinitions', ADMIN_AUTH);
    await project.get('/admin/VerbDefinitions', ADMIN_AUTH);
    const count = await db.run(
      SELECT.from('com.sap.developers.ims.VerbDefinitions').columns('count(*) as n')
    );
    expect(count[0].n).toBe(VERB_DEFAULTS.length);
  });

  it('idempotent — second ShelfDefinitions read does not duplicate', async () => {
    await project.get('/admin/ShelfDefinitions', ADMIN_AUTH);
    await project.get('/admin/ShelfDefinitions', ADMIN_AUTH);
    const count = await db.run(
      SELECT.from('com.sap.developers.ims.ShelfDefinitions').columns('count(*) as n')
    );
    expect(count[0].n).toBe(SHELF_DEFAULTS.length);
  });

  describe('handler defaults agree with seed CSVs', () => {
    it('VerbDefinitions auto-init values match the seed CSV', async () => {
      const csv = readFileSync(
        join(import.meta.dirname, '../../../db/data/com.sap.developers.ims-VerbDefinitions.csv'),
        'utf8'
      );
      // CSV columns: ID;verbKey;label;iconName;sortOrder
      // (#1029-followup) tagline/whyItMatters/authoringStatus intentionally
      // omitted from the CSV — see docs/developers/reference/hana-hdi-gotchas.md.
      const csvRows = csv.split(/\r?\n/).slice(1).filter(Boolean).map(line => {
        const [, verbKey, label, iconName, sortOrder] = line.split(';');
        return { verbKey, label, iconName, sortOrder: Number(sortOrder) };
      });
      // Force a fresh auto-init via the admin read
      await db.run(DELETE.from('com.sap.developers.ims.VerbDefinitions'));
      await project.get('/admin/VerbDefinitions', ADMIN_AUTH);
      const dbRows = await db.run(SELECT.from('com.sap.developers.ims.VerbDefinitions'));
      for (const csvRow of csvRows) {
        const dbRow = dbRows.find(r => r.verbKey === csvRow.verbKey);
        expect(dbRow, `verbKey ${csvRow.verbKey} missing in DB`).toBeDefined();
        expect(dbRow.label).toBe(csvRow.label);
        expect(dbRow.iconName).toBe(csvRow.iconName);
        expect(dbRow.sortOrder).toBe(csvRow.sortOrder);
      }
    });

    it('ShelfDefinitions auto-init values match the seed CSV', async () => {
      const csv = readFileSync(
        join(import.meta.dirname, '../../../db/data/com.sap.developers.ims-ShelfDefinitions.csv'),
        'utf8'
      );
      // CSV columns: ID;shelfKey;label;iconName;sortOrder
      // (#1029-followup) tagline/whyItMatters/authoringStatus intentionally
      // omitted from the CSV — see docs/developers/reference/hana-hdi-gotchas.md.
      const csvRows = csv.split(/\r?\n/).slice(1).filter(Boolean).map(line => {
        const [, shelfKey, label, iconName, sortOrder] = line.split(';');
        return { shelfKey, label, iconName, sortOrder: Number(sortOrder) };
      });
      await db.run(DELETE.from('com.sap.developers.ims.ShelfDefinitions'));
      await project.get('/admin/ShelfDefinitions', ADMIN_AUTH);
      const dbRows = await db.run(SELECT.from('com.sap.developers.ims.ShelfDefinitions'));
      for (const csvRow of csvRows) {
        const dbRow = dbRows.find(r => r.shelfKey === csvRow.shelfKey);
        expect(dbRow, `shelfKey ${csvRow.shelfKey} missing in DB`).toBeDefined();
        expect(dbRow.label).toBe(csvRow.label);
        expect(dbRow.iconName).toBe(csvRow.iconName);
        expect(dbRow.sortOrder).toBe(csvRow.sortOrder);
      }
    });
  });
});
