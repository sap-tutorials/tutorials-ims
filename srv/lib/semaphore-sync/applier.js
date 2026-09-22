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

// SES SAPCore is the ENTIRE SAP product/topic universe (~21k terms); the Tags
// table is a deliberately curated subset. So the sync is two-tier (#2184):
//
//   Tier 1 — ADOPT (existing tags): match by semaphoreId, else by name. Backfill
//     ONLY the taxonomy-owned fields (semaphoreId, titlePath, label). The
//     isActualTag / isInterestItem flags are EDITORIAL — set per-term by hand,
//     not derivable from any SES class — so the sync must never overwrite them
//     (verified: 99 tags under the "Software Product" root, only 18/18 flagged).
//
//   Tier 2 — INTAKE (new terms): a term with no matching row is INSERTed ONLY
//     when it passes the intake allowlist (opts.intakeClasses). New rows land
//     INERT (isActualTag=false, isInterestItem=false) awaiting editor curation —
//     never active, never flooding the table with all 21k. With no allowlist,
//     intake is OFF and unmatched terms are counted `skippedIntake`, not inserted.
//
// Idempotent: a second run with the same payload reports every row `unchanged`.
// dryRun:true computes the same plan without writing.

// Taxonomy-owned fields the sync may write onto an EXISTING row. The editorial
// flags are deliberately excluded so an adopt/update never clobbers curation.
const ADOPT_FIELDS = ['label', 'name', 'titlePath', 'semaphoreId'];

function adoptDiffers(existing, row) {
  return ADOPT_FIELDS.some((f) => (existing[f] ?? null) !== (row[f] ?? null));
}

// Case-insensitive membership, tolerant of full class URIs vs short names —
// mirrors mapper.classMatches so intake uses the same class-matching semantics.
function classAllowed(termClasses, allow) {
  if (!Array.isArray(allow) || allow.length === 0) return false;
  if (!Array.isArray(termClasses) || termClasses.length === 0) return false;
  const allowLc = allow.map((w) => String(w).toLowerCase());
  return termClasses.some((c) => {
    const cl = String(c ?? '').toLowerCase();
    const short = cl.includes('#') ? cl.slice(cl.lastIndexOf('#') + 1)
      : cl.includes('/') ? cl.slice(cl.lastIndexOf('/') + 1)
      : cl;
    return allowLc.some((w) => w === cl || w === short);
  });
}

/**
 * Two-tier upsert of mapper rows into Tags.
 *
 * @param {Array}  rows  Output of mapAllTerms().rows (each row also carries
 *                       `classes` for the intake gate)
 * @param {object} [opts]
 * @param {boolean}  [opts.dryRun=false]       compute the plan without writing
 * @param {string[]} [opts.intakeClasses=[]]   class allowlist for Tier-2 INSERT;
 *                                              empty ⇒ intake OFF (adopt-only)
 * @param {object}   [opts.db]                 cds db (defaults to cds.db / connect)
 * @returns {Promise<{inserted:number, updated:number, unchanged:number,
 *                    skippedIntake:number, total:number}>}
 */
export async function applyTerms(rows, opts = {}) {
  const { dryRun = false, intakeClasses = [] } = opts;
  const db = opts.db ?? cds.db ?? (await cds.connect.to('db'));
  const { Tags } = cds.entities('com.sap.developers.ims');

  let inserted = 0;
  let updated = 0;
  let unchanged = 0;
  let skippedIntake = 0;
  const total = Array.isArray(rows) ? rows.length : 0;

  for (const row of rows ?? []) {
    // 1. Existing by semaphoreId.
    let existing = await db.run(SELECT.one.from(Tags).where({ semaphoreId: row.semaphoreId }));
    // 2. Adopt a legacy/CSV row that matches by name but has no semaphoreId yet.
    if (!existing) {
      existing = await db.run(
        SELECT.one.from(Tags).where({ name: row.name, semaphoreId: null }),
      );
    }

    // Tier 1 — ADOPT: update ONLY taxonomy-owned fields; never the editorial flags.
    if (existing) {
      const adopt = {
        semaphoreId: row.semaphoreId,
        label: row.label,
        name: row.name,
        titlePath: row.titlePath,
      };
      if (adoptDiffers(existing, adopt)) {
        if (!dryRun) await db.run(UPDATE(Tags, existing.ID).set(adopt));
        updated++;
      } else {
        unchanged++;
      }
      continue;
    }

    // Tier 2 — INTAKE: insert a genuinely new term ONLY if class-allowlisted.
    // New rows land inert; an editor promotes them by setting the flags later.
    if (!classAllowed(row.classes, intakeClasses)) {
      skippedIntake++;
      continue;
    }
    if (!dryRun) {
      await db.run(INSERT.into(Tags).entries({
        ID: cds.utils.uuid(),
        semaphoreId: row.semaphoreId,
        label: row.label,
        name: row.name,
        titlePath: row.titlePath,
        isActualTag: false,
        isInterestItem: false,
      }));
    }
    inserted++;
  }

  return { inserted, updated, unchanged, skippedIntake, total };
}
