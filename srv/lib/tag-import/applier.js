import cds from '@sap/cds';

const VALID_STRATEGIES = new Set(['upsert', 'skip-duplicates', 'abort-on-duplicate']);

export async function apply(rows, strategy, db) {
  if (!VALID_STRATEGIES.has(strategy)) {
    throw new Error(`Unknown strategy: ${strategy}`);
  }

  const { Tags } = cds.entities('com.sap.developers.ims');

  const conflicts = rows.filter(r => r.status === 'conflict');
  if (strategy === 'abort-on-duplicate' && conflicts.length > 0) {
    throw new Error(`${conflicts.length} conflict(s) found; aborting per strategy`);
  }

  let inserted = 0, updated = 0, skipped = 0;
  const total = rows.length;

  for (const r of rows) {
    if (r.status === 'invalid') {
      skipped++;
      continue;
    }
    if (r.status === 'new') {
      // legacyId auto-assigned by AdminService before('CREATE') hook on Tags
      await INSERT.into(Tags).entries({ name: r.name, titlePath: r.titlePath });
      inserted++;
    } else if (r.status === 'conflict') {
      if (strategy === 'upsert' && r.titlePath !== r.existingTitlePath) {
        await UPDATE(Tags, r.existingId).set({ titlePath: r.titlePath });
        updated++;
      } else {
        skipped++;
      }
    }
  }

  return { inserted, updated, skipped, total };
}
