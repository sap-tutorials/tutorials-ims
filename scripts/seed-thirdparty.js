#!/usr/bin/env node
// Idempotent loader for homepage third-party content.
// Upserts db/data/staging/homepage-thirdparty.json into HomepageShelves,
// keyed on (verb, url). Run against DEV: `npm run seed:thirdparty`.
// PROD promotion is manual — see the file's _comment and the spec
// (docs/superpowers/specs/2026-07-30-homepage-thirdparty-content-design.md).
import cds from '@sap/cds';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { KNOWN_TAGS } from '../srv/lib/homepage/persona-tag-validator.js';

const KNOWN = new Set(KNOWN_TAGS);
const DATA_URL = new URL('../db/data/staging/homepage-thirdparty.json', import.meta.url);

function loadRows() {
  const raw = JSON.parse(readFileSync(fileURLToPath(DATA_URL), 'utf-8'));
  return raw.filter((r) => !r._comment);
}

function validate(rows) {
  const errors = [];
  const seen = new Set();
  for (const r of rows) {
    if (!r.verb || !r.url) errors.push(`row ${r.ID || '?'}: missing verb/url`);
    if (typeof r.url !== 'string' || !r.url.startsWith('https://')) {
      errors.push(`row ${r.ID}: url must be absolute https`);
    }
    const key = `${r.verb}|${r.url}`;
    if (seen.has(key)) errors.push(`duplicate (verb,url): ${key}`);
    seen.add(key);
    for (const t of r.personaTags || []) {
      if (!KNOWN.has(t)) errors.push(`row ${r.ID}: unknown personaTag "${t}"`);
    }
  }
  if (errors.length) {
    throw new Error(`seed-thirdparty validation failed:\n  ${errors.join('\n  ')}`);
  }
}

const NAMESPACE = 'com.sap.developers.ims';

export async function seedThirdParty(dbOverride) {
  const db = dbOverride ?? await cds.connect.to('db');
  // Reflect the entity via cds.linked so CQL is type-aware and serializes the
  // `personaTags` array to JSON for the HANA NCLOB column. `cds.entities` is a
  // getter that is undefined in a standalone script (only set after cds.serve),
  // and a fully-qualified string name is NOT type-aware (fails on HANA with
  // "Wrong input for LOB type"). cds.linked(csn) works in every context.
  const linked = cds.linked(cds.model ?? await cds.load('*'));
  const { HomepageShelves } = linked.entities(NAMESPACE);
  const rows = loadRows();
  validate(rows);

  let inserted = 0;
  let updated = 0;
  for (const r of rows) {
    const existing = await db.run(SELECT.one.from(HomepageShelves).columns('ID').where({ verb: r.verb, url: r.url }));
    if (existing) {
      const { ID, ...patch } = r;   // keep existing ID on update
      await db.run(UPDATE(HomepageShelves).set(patch).where({ ID: existing.ID }));
      updated++;
    } else {
      await db.run(INSERT.into(HomepageShelves).entries(r));
      inserted++;
    }
  }
  return { inserted, updated };
}

// CLI entry
if (fileURLToPath(import.meta.url) === process.argv[1]) {
  seedThirdParty()
    .then(({ inserted, updated }) => {
      console.log(`seed-thirdparty: ${inserted} inserted, ${updated} updated`);
      process.exit(0);
    })
    .catch((err) => {
      console.error(err.message || err);
      process.exit(1);
    });
}
