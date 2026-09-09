// srv/lib/semaphore-sync/applier.js
//
// Persist mapped Semaphore terms (from srv/lib/semaphore-sync/mapper.js) into the
// `Tags` entity. This is a distinct upsert engine from the CSV importer's
// srv/lib/tag-import/applier.js: the CSV path keys on `name` (author-typed rows
// carry no Semaphore id), whereas taxonomy sync keys on the stable natural key
// `semaphoreId`, so a renamed term updates in place instead of duplicating.
//
// Match order per row:
//   1. by semaphoreId  → UPDATE (authoritative once a tag has been synced)
//   2. by normalized name (only when semaphoreId not yet present on the row)
//      → adopt: attach semaphoreId + flags to a legacy/CSV row
//   3. no match → INSERT (ID assigned here: cds.db INSERT does NOT auto-fill a
//      UUID key on HANA, only on SQLite — see memory cds-db-insert-omitting-uuid-key)
//
// Idempotent: a second run with the same payload reports every row `unchanged`.
// dryRun:true computes the same plan without writing — used to validate the
// class→flag mapping against the live SAPCore model before the flag is flipped.

import cds from '@sap/cds';

// Fields we consider when deciding whether an existing row needs an UPDATE.
const TRACKED = ['label', 'name', 'titlePath', 'isActualTag', 'isInterestItem', 'semaphoreId'];

function differs(existing, row) {
  return TRACKED.some((f) => (existing[f] ?? null) !== (row[f] ?? null));
}

/**
 * Upsert mapper rows into Tags.
 *
 * @param {Array}  rows  Output of mapAllTerms().rows
 * @param {object} [opts]
 * @param {boolean} [opts.dryRun=false]  compute the plan without writing
 * @param {object}  [opts.db]            cds db (defaults to cds.db / connect)
 * @returns {Promise<{inserted:number, updated:number, unchanged:number, total:number}>}
 */
export async function applyTerms(rows, opts = {}) {
  const { dryRun = false } = opts;
  const db = opts.db ?? cds.db ?? (await cds.connect.to('db'));
  const { Tags } = cds.entities('com.sap.developers.ims');

  let inserted = 0;
  let updated = 0;
  let unchanged = 0;
  const total = Array.isArray(rows) ? rows.length : 0;

  for (const row of rows ?? []) {
    const fields = {
      semaphoreId: row.semaphoreId,
      label: row.label,
      name: row.name,
      titlePath: row.titlePath,
      isActualTag: !!row.isActualTag,
      isInterestItem: !!row.isInterestItem,
    };

    // 1. Existing by semaphoreId.
    let existing = await db.run(SELECT.one.from(Tags).where({ semaphoreId: row.semaphoreId }));
    // 2. Adopt a legacy/CSV row that matches by name but has no semaphoreId yet.
    if (!existing) {
      existing = await db.run(
        SELECT.one.from(Tags).where({ name: row.name, semaphoreId: null }),
      );
    }

    if (existing) {
      if (differs(existing, fields)) {
        if (!dryRun) await db.run(UPDATE(Tags, existing.ID).set(fields));
        updated++;
      } else {
        unchanged++;
      }
      continue;
    }

    // 3. Insert. Assign the UUID key explicitly for HANA parity.
    if (!dryRun) {
      await db.run(INSERT.into(Tags).entries({ ID: cds.utils.uuid(), ...fields }));
    }
    inserted++;
  }

  return { inserted, updated, unchanged, total };
}
