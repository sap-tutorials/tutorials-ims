// test/unit/chatsettings-no-seed-csv.test.js
//
// Guard: ChatSettings must NOT ship a db/data seed CSV.
//
// Why this exists — the ChatSettings-clobber saga:
//   1. ChatSettings originally shipped a seed CSV WITH a data row
//      (`...c8a7;false;;100;`). HDI re-imported it on every deploy, forcing
//      deploymentId→null and enabled→false, wiping admin-set values every
//      deploy. (chatsettings-seed-csv-clobbers-joule-toggles, PR #1234.)
//   2. PR #1234 emptied the CSV to header-only. But an .hdbtabledata import is
//      a DELTA: HDI tracked the previously-imported key `...c8a7`, so the first
//      deploy carrying the emptied CSV DELETED that row (taking the admin's
//      deploymentId with it) before the header-only steady-state kicked in.
//   3. This PR removes the CSV entirely. With no db/data CSV, `cds build` emits
//      no .hdbtabledata for ChatSettings at all — HDI stops managing the
//      table's data, so no import, no delta, no possible delete. The row is
//      created + owned exclusively by the runtime `before('READ','ChatSettings')`
//      lazy-init in srv/admin-service.js (verified by
//      admin-singleton-auto-init.test.js).
//
// If someone re-adds a ChatSettings seed CSV, this test fails loudly and points
// back here — a data CSV on this singleton is ALWAYS a clobber regression.

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const CSV_PATH = path.join(REPO_ROOT, 'db', 'data', 'com.sap.developers.ims-ChatSettings.csv');

describe('ChatSettings seed CSV guard (clobber regression)', () => {
  it('does NOT ship a db/data ChatSettings seed CSV', () => {
    expect(
      fs.existsSync(CSV_PATH),
      `A ChatSettings seed CSV re-appeared at ${CSV_PATH}. This ALWAYS clobbers ` +
      `admin-set values on deploy (HDI .hdbtabledata re-imports/deletes the ` +
      `singleton row). ChatSettings must be created only by the runtime ` +
      `before('READ') lazy-init. See this test's header for the full history.`,
    ).toBe(false);
  });
});
