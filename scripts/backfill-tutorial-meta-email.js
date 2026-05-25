// scripts/backfill-tutorial-meta-email.js
//
// Best-effort backfill of TutorialMeta.ownerEmail from Users by name.
// Idempotent: only updates rows where ownerEmail IS NULL.
// Unresolved rows logged to .migration-data/ownerEmail-unresolved.csv.
//
// Usage: npx cds bind --exec -- node scripts/backfill-tutorial-meta-email.js [--dry-run]

import cds from '@sap/cds';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export async function backfill({ dryRun = false } = {}) {
  const db = await cds.connect.to('db');
  const { TutorialMeta, Users } = cds.entities('com.sap.developers.ims');

  const metas = await db.run(
    SELECT.from(TutorialMeta).columns('ID', 'owner', 'ownerEmail').where(`ownerEmail IS NULL`)
  );
  const users = await db.run(SELECT.from(Users).columns('ID', 'email', 'firstName', 'lastName', 'displayName'));

  const byFullName = new Map();
  const byDisplay  = new Map();
  const setOrFlagAmbiguous = (map, key, email) => {
    if (map.has(key)) map.set(key, null);   // sentinel: ambiguous
    else map.set(key, email);
  };
  for (const u of users) {
    if (!u.email) continue;
    if (u.firstName && u.lastName) setOrFlagAmbiguous(byFullName, `${u.firstName} ${u.lastName}`.toLowerCase(), u.email);
    if (u.displayName) setOrFlagAmbiguous(byDisplay, u.displayName.toLowerCase(), u.email);
  }

  let resolved = 0;
  const unresolved = [];
  for (const m of metas) {
    if (!m.owner) { unresolved.push({ id: m.ID, owner: '', reason: 'empty owner' }); continue; }
    const key = m.owner.toLowerCase();
    let email = byFullName.get(key);
    if (email === undefined) email = byDisplay.get(key);
    if (email === null)      { unresolved.push({ id: m.ID, owner: m.owner, reason: 'ambiguous name' }); continue; }
    if (email === undefined) { unresolved.push({ id: m.ID, owner: m.owner, reason: 'no Users match' }); continue; }
    if (!dryRun) await db.run(UPDATE(TutorialMeta, m.ID).set({ ownerEmail: email }));
    resolved++;
  }

  const dir = path.resolve(process.cwd(), '.migration-data');
  fs.mkdirSync(dir, { recursive: true });
  const esc = s => `"${String(s).replace(/"/g, '""')}"`;
  const csv = ['id,owner,reason',
    ...unresolved.map(r => `${r.id},${esc(r.owner)},${esc(r.reason)}`)
  ].join('\n');
  fs.writeFileSync(path.join(dir, 'ownerEmail-unresolved.csv'), csv);

  console.log(`Resolved: ${resolved}/${metas.length}. Unresolved logged to .migration-data/ownerEmail-unresolved.csv.`);
  return { resolved, unresolved: unresolved.length, total: metas.length };
}

// Run when invoked directly (ESM equivalent of `require.main === module`)
const isDirectRun = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isDirectRun) {
  const dryRun = process.argv.includes('--dry-run');
  backfill({ dryRun }).then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
}
