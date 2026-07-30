// srv/lib/seed-poc-puzzle.js
// Idempotent seed for the "Devtoberfest Cryptic Crossword" puzzle.
//
// Inserts the POC puzzle row ONLY if no Puzzles row with
// slug 'devtoberfest-cryptic-crossword' already exists.
// Never overwrites an existing row — authors may have edited it.
//
// Called from:
//   - npm run seed-poc-puzzle  (standalone ESM runner, on-demand)
//   - scripts/setup-dev-data.cjs (via dynamic import, on-demand setup-dev-data)
//
// Both paths connect to the cds 'db' service; callers must ensure cds.load('*')
// has been called (or pass an already-connected db instance for tests).

import cds from '@sap/cds';
import { randomUUID } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

const SLUG = 'devtoberfest-cryptic-crossword';

/**
 * Seed the POC puzzle row idempotently.
 *
 * @param {object} [dbOverride] — optional already-connected cds db (for tests).
 *   When omitted, connects via cds.connect.to('db').
 * @returns {Promise<{seeded: boolean}>}
 *   seeded=true  → row was inserted
 *   seeded=false → row already existed, nothing written
 */
export async function seedPocPuzzle(dbOverride) {
  const db = dbOverride ?? await cds.connect.to('db');
  // Resolve the Puzzles entity robustly across contexts:
  //  - booted CAP server / cds.test → cds.entities() is installed.
  //  - standalone `cds bind --exec` (npm run seed-poc-puzzle) → the model is
  //    NOT linked into cds.entities globals and cds.model is unset, so fall
  //    back to explicitly loading + linking the model. (Same class of gotcha
  //    as cap-unit-test-bootstrap-cds-model-undefined.)
  let Puzzles;
  if (typeof cds.entities === 'function' && cds.model) {
    ({ Puzzles } = cds.entities('com.sap.developers.ims'));
  } else {
    const linked = cds.linked(await cds.load('*'));
    ({ Puzzles } = linked.entities('com.sap.developers.ims'));
  }

  // Explicit columns: a bare SELECT.one.from(entity) emits `SELECT *`, which
  // HANA cannot infer when the entity comes from a separately-linked model
  // (standalone `cds bind --exec` path) → "Query was not inferred and includes
  // '*'". Naming columns avoids the inference step. Verified live against DEV.
  const exists = await SELECT.one.from(Puzzles).columns('ID', 'slug').where({ slug: SLUG });
  if (exists) {
    return { seeded: false };
  }

  // Lazy-load the transform. Wrap in pathToFileURL: on Windows a raw absolute
  // path ("D:\...") is not a valid ESM specifier — dynamic import() needs a
  // file:// URL (ERR_UNSUPPORTED_ESM_URL_SCHEME otherwise).
  const transformUrl = pathToFileURL(resolve(__dirname, '../../scripts/seed/transform-poc-puzzle.mjs')).href;
  const { buildSeedRow } = await import(transformUrl);
  const row = buildSeedRow();

  await INSERT.into(Puzzles).entries({ ID: randomUUID(), ...row });
  return { seeded: true };
}

// CLI runner: called by `npm run seed-poc-puzzle`
// Only runs when invoked directly, not when imported.
const isMain = process.argv[1] &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (isMain) {
  (async () => {
    await cds.load('*');
    const result = await seedPocPuzzle();
    if (result.seeded) {
      console.log(`Seeded puzzle: ${SLUG}`);
    } else {
      console.log(`Puzzle already exists: ${SLUG} — skipping`);
    }
    process.exit(0);
  })().catch(e => { console.error(e); process.exit(1); });
}
