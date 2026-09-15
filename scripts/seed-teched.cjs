'use strict';
// scripts/seed-teched.cjs
//
// Idempotent (re-)ingest of the SAP TechEd 2026 catalog into the TechEd*
// entities (issue #2312, Unit F). Dry-run by default.
//
//   # from a captured fetcher-output JSON ({ sessions, speakers, tracks }):
//   npx cds bind --exec -- node scripts/seed-teched.cjs --file <json> --commit
//   # straight from the live RainFocus API (needs venue widget/apiProfile env):
//   npx cds bind --exec -- node scripts/seed-teched.cjs --commit
//
// Flags: --commit writes (else dry-run), --force bypasses the contentHash skip.
//
// This is a CommonJS entry (matches scripts/seed-channels.cjs) but the pure
// logic lives in ESM modules under srv/lib/teched/, loaded here via dynamic
// import() (package.json "type":"module" makes those .js files ESM).
const cds = require('@sap/cds');
const { readFileSync } = require('node:fs');
const { pathToFileURL } = require('node:url');
const path = require('node:path');

const NAMESPACE_EXT = 'com.sap.developers.ims.external';

function esm(rel) {
  return import(pathToFileURL(path.join(__dirname, '..', 'srv', 'lib', 'teched', rel)).href);
}

async function main() {
  const args = process.argv.slice(2);
  const commit = args.includes('--commit');
  const force = args.includes('--force');
  const fileIdx = args.indexOf('--file');
  const file = fileIdx >= 0 ? args[fileIdx + 1] : null;

  let data;
  if (file) {
    const doc = JSON.parse(readFileSync(file, 'utf8'));
    data = { sessions: doc.sessions ?? [], speakers: doc.speakers ?? [], tracks: doc.tracks ?? [] };
    console.log(`[seed-teched] source=file(${file}) sessions=${data.sessions.length} speakers=${data.speakers.length} tracks=${data.tracks.length}`);
  } else {
    const { fetchAllTechEdSessions } = await esm('rainfocus-fetcher.js');
    data = await fetchAllTechEdSessions();
    console.log(`[seed-teched] source=live sessions=${data.sessions.length} speakers=${data.speakers.length} tracks=${data.tracks.length}`);
  }

  const db = await cds.connect.to('db');
  // Ensure the model is loaded so cds.entities() resolves the external ns.
  if (!cds.model) cds.model = await cds.load('*');
  const linked = cds.linked(cds.model);
  const { TechEdSessions, TechEdSpeakers, TechEdTracks, TechEdSessionSpeakers } = linked.entities(NAMESPACE_EXT);

  const { runSeed } = await esm('seed-core.js');
  const summary = await runSeed({
    db,
    entities: { TechEdSessions, TechEdSpeakers, TechEdTracks, TechEdSessionSpeakers },
    data,
    commit,
    force,
  });

  const fmt = (r) => `ins=${r.inserted} upd=${r.updated} skip=${r.skipped}`;
  console.log(
    `[seed-teched] ${commit ? 'COMMIT' : 'DRY-RUN'}${force ? ' (force)' : ''} `
    + `tracks[${fmt(summary.tracks)}] speakers[${fmt(summary.speakers)}] `
    + `sessions[${fmt(summary.sessions)}] links[ins=${summary.links.inserted}]`,
  );
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
