import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// Guard rail for the "CSV changes wipe admin-editable columns on deploy" gotcha.
//
// The production profile loads initial data from db/data + db/csv ONLY
// (test/data is development-profile only — see `cds env requires.db.data`).
// Any runtime/admin-editable table whose seed CSV lives in db/data has its
// rows re-imported (replaced) by HDI whenever the CSV hash changes on deploy,
// silently clobbering live admin edits.
//
// These tables were made admin-managed by moving their seed CSV to test/data
// (still seeds cds watch + unit tests, never ships to HANA). This test fails
// if any of them creeps back into db/data.
const DB_DATA = join(import.meta.dirname, '../../../db/data');
const TEST_DATA = join(import.meta.dirname, '../../../test/data');

const ADMIN_MANAGED = [
  'com.sap.developers.ims-HomepageConfig.csv',
  'com.sap.developers.ims-CommunityBlogSources.csv',
  'com.sap.developers.ims-ImsConfig.csv',
];

// HomepageShelves no longer has a seed CSV at all — it is seeded idempotently
// (insert-if-missing on verb+url) at boot by srv/lib/homepage/seed-homepage-shelves.js
// from the inline canonical defaults (srv/lib/homepage/homepage-shelves-defaults.js).
// The CSV was retired so nothing can ever full-replace the admin-managed table.
const RETIRED_SHELVES_CSV = 'com.sap.developers.ims-HomepageShelves.csv';

describe('admin-managed seed CSVs stay out of the production seed folder', () => {
  for (const csv of ADMIN_MANAGED) {
    it(`${csv} is NOT in db/data (would re-seed on deploy and wipe admin edits)`, () => {
      expect(existsSync(join(DB_DATA, csv))).toBe(false);
    });
    it(`${csv} lives in test/data (still seeds dev + unit tests)`, () => {
      expect(existsSync(join(TEST_DATA, csv))).toBe(true);
    });
  }

  it(`${RETIRED_SHELVES_CSV} is retired — absent from BOTH db/data and test/data`, () => {
    // Seeded at boot (insert-if-missing), never from a CSV → an HDI redeploy
    // can never full-replace the admin-managed HomepageShelves table.
    expect(existsSync(join(DB_DATA, RETIRED_SHELVES_CSV))).toBe(false);
    expect(existsSync(join(TEST_DATA, RETIRED_SHELVES_CSV))).toBe(false);
  });

  it('Categories seed CSV header omits the editable seedDescription column', () => {
    // seedDescription is authored/edited at runtime (Categories UPDATE after-hook
    // → category-seed-embeddings). Keeping it in the seed CSV would let a
    // CSV-touching deploy overwrite admin edits. Only structural columns seed.
    const header = readFileSync(
      join(DB_DATA, 'com.sap.developers.ims-Categories.csv'),
      'utf8',
    ).split(/\r?\n/)[0].trim();
    expect(header).toBe('ID;slug;label;sortOrder');
    expect(header).not.toMatch(/seedDescription/);
  });
});
