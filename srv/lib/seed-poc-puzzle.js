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
import { fileURLToPath } from 'node:url';
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
  const { Puzzles } = cds.entities('com.sap.developers.ims');

  const exists = await SELECT.one.from(Puzzles).where({ slug: SLUG });
  if (exists) {
    return { seeded: false };
  }

  // Lazy-load the transform so this module has no hard dep on file paths at import time.
  const transformUrl = resolve(__dirname, '../../scripts/seed/transform-poc-puzzle.mjs');
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
