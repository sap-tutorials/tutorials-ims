/**
 * sync-published-flag-from-aem-sitemap.cjs
 *
 * Establishes the AEM-curated visibility model on DEV by reading the
 * live AEM sitemap, matching mission/group titles to DB rows, and
 * setting `published=true` only on rows AEM published.
 *
 * Background: developers.sap.com (legacy) was the public face of the
 * tutorial system. AEM curated which missions/groups appeared on the
 * public navigator — that gate doesn't exist in IMS source data
 * (IMS_TASK has no "publish" flag). PR #349 introduced
 * `Missions.published` / `Groups.published` (default false) as the
 * AEM-replacement curation gate, but the migrator has no signal to
 * decide which 87/193 should land as published.
 *
 * The AEM sitemap (https://developers.sap.com/sitemap_{1,2,3}.xml) is
 * the source of truth: every mission AEM publishes shows up as
 * `mission.<slug>.html`; every group as `group.<slug>.html`. AEM
 * generates the slugs differently from our DB (URL-style vs
 * title-derived), so we match by page title instead.
 *
 * Algorithm:
 *   1. Fetch sitemap_1/2/3.xml and extract mission.* + group.* URLs
 *   2. Bulk-fetch each page (~280 pages, parallel)
 *   3. Extract the title tag, strip "| SAP Tutorials" suffix, decode
 *      entities
 *   4. Normalize (lowercase + collapse whitespace)
 *   5. Match against DB Missions.title / Groups.title; for ambiguous
 *      titles prefer non-DELETED rows
 *   6. UPDATE: published=false everywhere, then published=true on
 *      matched rows
 *
 * Idempotent: re-running over an unchanged sitemap produces identical
 * results. Safe to re-run after every migration.
 *
 * Surfaced during 2026-06-16 cutover rehearsal: navigator showed 370
 * missions / 203 groups (every non-DELETED row); should have shown 86
 * / 194 (AEM-curated only).
 *
 * Usage:
 *   CAP_HANA_CREDENTIALS="$(cat target-creds.json)" \
 *   node scripts/sync-published-flag-from-aem-sitemap.cjs [--dry-run] [--no-fetch]
 *
 * Flags:
 *   --dry-run   Show what would change without UPDATE
 *   --no-fetch  Reuse cached sitemap+pages from .migration-data/aem-snapshot/
 *               (skip the network round trip; useful for repeat runs)
 */

'use strict';

const hdb = require('hdb');
const fs = require('fs');
const path = require('path');
const { mkdirSync, writeFileSync, readFileSync, existsSync } = fs;

const DRY_RUN  = process.argv.includes('--dry-run');
const NO_FETCH = process.argv.includes('--no-fetch');

const CACHE_DIR = path.join(process.cwd(), '.migration-data', 'aem-snapshot');
const SITEMAPS = ['sitemap_1.xml', 'sitemap_2.xml', 'sitemap_3.xml'];
const SITEMAP_BASE = 'https://developers.sap.com';
const PARALLEL = 8;

// ─── HANA helpers ──────────────────────────────────────────────────────────

function connectHana(creds) {
  const port = parseInt(creds.port || '443', 10);
  const client = hdb.createClient({
    host: creds.host, port, user: creds.user, password: creds.password, useTLS: true
  });
  return new Promise((resolve, reject) => {
    client.connect((err) => err ? reject(err) : resolve(client));
  });
}

function runSql(client, sql) {
  // hdb's exec method runs SQL; isolated in a helper so callers stay readable.
  const fn = client['exec'].bind(client);
  return new Promise((resolve, reject) =>
    fn(sql, (err, rows) => err ? reject(err) : resolve(rows)));
}

function runStmt(client, sql, params) {
  return new Promise((resolve, reject) => {
    client.prepare(sql, (err, stmt) => {
      if (err) return reject(err);
      stmt.exec(params, (err2, affected) => {
        stmt.drop();
        err2 ? reject(err2) : resolve(affected);
      });
    });
  });
}

function resolveTargetCreds() {
  if (process.env.CAP_HANA_CREDENTIALS) {
    return JSON.parse(process.env.CAP_HANA_CREDENTIALS);
  }
  throw new Error('No target credentials. Set CAP_HANA_CREDENTIALS to the JSON service-key.');
}

// ─── Title parsing ─────────────────────────────────────────────────────────

const decodeEntities = (s) => (s || '')
  .replace(/&amp;/g, '&')
  .replace(/&lt;/g, '<')
  .replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"')
  .replace(/&#39;/g, "'")
  .replace(/&nbsp;/g, ' ');

const normalizeTitle = (s) => decodeEntities(s).trim().replace(/\s+/g, ' ').toLowerCase();

function extractTitle(html) {
  const m = html.match(/<title>([^<]+)<\/title>/);
  if (!m) return null;
  return m[1].replace(/\s*\|\s*SAP Tutorials\s*$/i, '').trim();
}

// ─── Concurrency-limited fetch ─────────────────────────────────────────────

async function parallelDo(items, fn, concurrency) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  return results;
}

// ─── Sitemap + page fetch ──────────────────────────────────────────────────

async function loadSitemapUrls() {
  const all = [];
  for (const file of SITEMAPS) {
    const cachePath = path.join(CACHE_DIR, file);
    let xml;
    if (NO_FETCH && existsSync(cachePath)) {
      xml = readFileSync(cachePath, 'utf8');
      console.log(`  ✓ Cached ${file}`);
    } else {
      const res = await fetch(`${SITEMAP_BASE}/${file}`);
      if (!res.ok) throw new Error(`Sitemap fetch ${file} returned ${res.status}`);
      xml = await res.text();
      mkdirSync(CACHE_DIR, { recursive: true });
      writeFileSync(cachePath, xml);
      console.log(`  ✓ Fetched ${file}`);
    }
    const matches = xml.match(/<loc>([^<]+)<\/loc>/g) || [];
    matches.forEach(m => all.push(m.replace(/<\/?loc>/g, '')));
  }
  return all;
}

async function fetchPages(slugs, kind) {
  const dir = path.join(CACHE_DIR, `${kind}-pages`);
  mkdirSync(dir, { recursive: true });

  const out = [];
  await parallelDo(slugs, async (slug) => {
    const cachePath = path.join(dir, `${slug}.html`);
    let html;
    if (NO_FETCH && existsSync(cachePath)) {
      html = readFileSync(cachePath, 'utf8');
    } else {
      const url = `${SITEMAP_BASE}/${kind}.${slug}.html`;
      const res = await fetch(url);
      if (!res.ok) {
        console.error(`  ✗ ${kind}.${slug} returned ${res.status}`);
        out.push({ slug, title: null, error: `HTTP ${res.status}` });
        return;
      }
      html = await res.text();
      writeFileSync(cachePath, html);
    }
    out.push({ slug, title: extractTitle(html) });
  }, PARALLEL);

  return out;
}

// ─── Match + apply ─────────────────────────────────────────────────────────

function buildTitleIndex(rows) {
  // Group by normalized title; for duplicates prefer non-DELETED.
  const grouped = new Map();
  for (const row of rows) {
    const key = normalizeTitle(row.TITLE);
    if (!key) continue;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(row);
  }
  const out = new Map();
  for (const [key, candidates] of grouped) {
    const live = candidates.filter(r => r.STATUS !== 'DELETED');
    if (live.length === 1) out.set(key, live[0]);
    else if (live.length === 0 && candidates.length === 1) out.set(key, candidates[0]);
    else if (live.length > 1) out.set(key, { __ambiguous: true, candidates: live });
  }
  return out;
}

function matchAemToDb(aemPages, dbIndex) {
  const matched = [], missing = [];
  for (const a of aemPages) {
    if (!a.title) {
      missing.push({ slug: a.slug, title: null, reason: a.error || 'NO_TITLE' });
      continue;
    }
    const key = normalizeTitle(a.title);
    const hit = dbIndex.get(key);
    if (!hit) missing.push({ slug: a.slug, title: a.title, reason: 'NO_MATCH' });
    else if (hit.__ambiguous) missing.push({ slug: a.slug, title: a.title, reason: 'AMBIGUOUS', candidates: hit.candidates.length });
    else matched.push({ slug: a.slug, title: a.title, dbId: hit.ID });
  }
  return { matched, missing };
}

// ─── Main ──────────────────────────────────────────────────────────────────

(async function main() {
  const targetCreds = resolveTargetCreds();
  console.log(`Target: ${targetCreds.host?.slice(0, 30)}... schema=${targetCreds.schema}`);
  if (DRY_RUN) console.log('=== DRY RUN — no UPDATEs will be issued ===');
  if (NO_FETCH) console.log('=== NO FETCH — reusing cached sitemap+pages ===');

  console.log('\n▸ Loading AEM sitemap');
  const allUrls = await loadSitemapUrls();
  const missionSlugs = allUrls
    .filter(u => /\/mission\.[^/]+\.html$/.test(u))
    .map(u => u.replace(/^.*\/mission\./, '').replace(/\.html$/, ''));
  const groupSlugs = allUrls
    .filter(u => /\/group\.[^/]+\.html$/.test(u))
    .map(u => u.replace(/^.*\/group\./, '').replace(/\.html$/, ''));
  console.log(`  ${missionSlugs.length} missions, ${groupSlugs.length} groups`);

  console.log('\n▸ Fetching mission pages');
  const missionPages = await fetchPages(missionSlugs, 'mission');
  console.log(`  ${missionPages.filter(p => p.title).length}/${missionPages.length} with title`);

  console.log('\n▸ Fetching group pages');
  const groupPages = await fetchPages(groupSlugs, 'group');
  console.log(`  ${groupPages.filter(p => p.title).length}/${groupPages.length} with title`);

  console.log('\n▸ Connecting to target HANA');
  const target = await connectHana(targetCreds);
  await runSql(target, `SET SCHEMA "${targetCreds.schema}"`);

  const dbMissions = await runSql(target, 'SELECT ID, TITLE, STATUS FROM COM_SAP_DEVELOPERS_IMS_MISSIONS');
  const dbGroups   = await runSql(target, 'SELECT ID, TITLE, STATUS FROM COM_SAP_DEVELOPERS_IMS_GROUPS');
  console.log(`  ${dbMissions.length} DB missions, ${dbGroups.length} DB groups`);

  const mIdx = buildTitleIndex(dbMissions);
  const gIdx = buildTitleIndex(dbGroups);

  const m = matchAemToDb(missionPages, mIdx);
  const g = matchAemToDb(groupPages,   gIdx);
  console.log(`\n▸ Match results`);
  console.log(`  Missions: ${m.matched.length} matched / ${m.missing.length} missing`);
  m.missing.forEach(x => console.log(`    ✗ ${x.slug} | ${x.reason} | ${x.title || '(no title)'}`));
  console.log(`  Groups:   ${g.matched.length} matched / ${g.missing.length} missing`);
  g.missing.forEach(x => console.log(`    ✗ ${x.slug} | ${x.reason} | ${x.title || '(no title)'}`));

  if (DRY_RUN) {
    console.log('\n▸ Dry run — would set:');
    console.log(`    UPDATE Missions: published=false everywhere, published=true on ${m.matched.length} matched`);
    console.log(`    UPDATE Groups:   published=false everywhere, published=true on ${g.matched.length} matched`);
    target.end();
    process.exit(0);
  }

  console.log('\n▸ Applying UPDATEs');
  await runSql(target, 'UPDATE COM_SAP_DEVELOPERS_IMS_MISSIONS SET PUBLISHED = FALSE');
  console.log(`  ✓ Reset all missions to published=false (${dbMissions.length} rows)`);
  await runSql(target, 'UPDATE COM_SAP_DEVELOPERS_IMS_GROUPS SET PUBLISHED = FALSE');
  console.log(`  ✓ Reset all groups to published=false (${dbGroups.length} rows)`);

  if (m.matched.length) {
    const ids = m.matched.map(x => x.dbId);
    const placeholders = ids.map(() => '?').join(',');
    await runStmt(target, `UPDATE COM_SAP_DEVELOPERS_IMS_MISSIONS SET PUBLISHED = TRUE WHERE ID IN (${placeholders})`, ids);
    console.log(`  ✓ Published ${m.matched.length} missions`);
  }
  if (g.matched.length) {
    const ids = g.matched.map(x => x.dbId);
    const placeholders = ids.map(() => '?').join(',');
    await runStmt(target, `UPDATE COM_SAP_DEVELOPERS_IMS_GROUPS SET PUBLISHED = TRUE WHERE ID IN (${placeholders})`, ids);
    console.log(`  ✓ Published ${g.matched.length} groups`);
  }

  const verify = await runSql(target, `SELECT
    (SELECT COUNT(*) FROM COM_SAP_DEVELOPERS_IMS_MISSIONS WHERE PUBLISHED = TRUE) AS M_PUB,
    (SELECT COUNT(*) FROM COM_SAP_DEVELOPERS_IMS_GROUPS   WHERE PUBLISHED = TRUE) AS G_PUB
    FROM SYS.DUMMY`);
  console.log(`\n▸ Final state: ${verify[0].M_PUB} missions published, ${verify[0].G_PUB} groups published`);

  target.end();
  process.exit(0);
})().catch((e) => {
  console.error('FATAL:', e.message);
  process.exit(2);
});
