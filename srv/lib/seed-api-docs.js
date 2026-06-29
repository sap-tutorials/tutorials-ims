// srv/lib/seed-api-docs.js
//
// Phase 4.5 (#746): shared seed loader. Imported by both
// scripts/seed-api-docs.cjs (CLI) and srv/admin-service.js (admin action — Task 2).
// Single source of truth for YAML → ApiDocs upsert logic.
//
// Idempotent: re-running with unchanged YAML is a no-op (contentHash gate).
// Does NOT write ApiDocConceptLinks — link materialization is the cron's job
// per spec §3 Q3. The seed only writes the source content rows.
//
// Spec: docs/superpowers/specs/2026-06-29-746-phase4.5-api-docs.md §4.2

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { load as yamlLoad } from 'js-yaml';
import cds from '@sap/cds';

const YAML_PATH = path.resolve(process.cwd(), 'db', 'data', 'api-docs.yaml');

/**
 * Canonicalize a YAML sourceId into a slug-safe form. Lowercase + replace
 * any non-[a-z0-9_-] characters with underscore. Defense-in-depth: the YAML
 * validator restricts sourceId to [A-Za-z0-9_\\-]+ already, so the only
 * material change is the case fold.
 */
export function canonicalizeSourceId(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9_\-]/g, '_');
}

function sha256(s) {
  return crypto.createHash('sha256').update(s).digest('hex');
}

/**
 * @param {Object} [opts]
 * @param {string} [opts.yamlContent] — override file read (used by tests)
 * @param {boolean} [opts.commit=false] — false → dry-run; true → actually upsert
 * @param {string|null} [opts.slugFilter=null] — restrict to a single slug
 * @returns {Promise<{ planned: number, committed: number }>}
 */
export async function runSeedApiDocs({ yamlContent, commit = false, slugFilter = null } = {}) {
  const raw = yamlContent ?? fs.readFileSync(YAML_PATH, 'utf8');
  const rows = yamlLoad(raw);
  if (!Array.isArray(rows)) throw new Error('seed-api-docs: YAML root must be an array');

  const { ApiDocs } = cds.entities('com.sap.developers.ims.external');

  let planned = 0;
  let committed = 0;
  const now = new Date();

  for (const row of rows) {
    const slug = 'ad-' + canonicalizeSourceId(row.sourceId);
    if (slugFilter && slug !== slugFilter) continue;

    const contentHash = sha256(`${row.title}\n${row.description}\n${row.category}\n${row.apiType}`);

    // Read scalar metadata only — description is LargeString (NCLOB on HANA)
    // and including it here would risk LOB-locator expiry (§10.1). We don't
    // need description for the contentHash comparison; the hash is computed
    // from the incoming YAML row, not the persisted row.
    const existing = await SELECT.one.from(ApiDocs)
      .columns('ID', 'contentHash')
      .where({ slug });

    if (existing && existing.contentHash === contentHash) continue;

    planned++;
    if (!commit) continue;

    if (existing) {
      await UPDATE(ApiDocs).set({
        title: row.title,
        description: row.description,
        url: row.url,
        category: row.category,
        apiType: row.apiType,
        contentHash,
        sourceId: row.sourceId,
        lastSeenAt: now,
      }).where({ ID: existing.ID });
    } else {
      await INSERT.into(ApiDocs).entries({
        slug,
        title: row.title,
        description: row.description,
        url: row.url,
        sourceId: row.sourceId,
        contentHash,
        firstSeenAt: now,
        lastSeenAt: now,
        category: row.category,
        apiType: row.apiType,
      });
    }
    committed++;
  }

  return { planned, committed };
}
