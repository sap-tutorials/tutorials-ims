import { mkdirSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const CAP_BASE = process.env.CAP_BASE_URL || 'http://localhost:4004';
const OUT_PATH = join('hugo', 'data', 'teched.json');
const AUTHOR_INDEX_PATH = join('hugo', 'data', 'author_index.json');
const ADVOCATES_DIR = join('hugo', 'content', 'developer-advocates');

const require = createRequire(import.meta.url);
// author-match.js is CJS (srv/lib convention); safe to require from ESM.
const { enrichSpeakersWithAuthorLogin, enrichSpeakersWithAdvocateSlug } = require('../srv/lib/teched/author-match.js');

// Build the developer-advocate roster (name → slug) from the Hugo content dir.
// Each hugo/content/developer-advocates/<slug>.md carries `title:` (the display
// name) + `slug:`. Fail-open: missing dir or unparseable file → empty roster.
function loadAdvocateRoster(): { name: string; slug: string }[] {
  const roster: { name: string; slug: string }[] = [];
  let files: string[];
  try {
    files = readdirSync(ADVOCATES_DIR);
  } catch {
    return roster; // no advocates dir → nothing to match
  }
  for (const f of files) {
    if (!f.endsWith('.md') || f === '_index.md') continue;
    const slug = f.replace(/\.md$/, '');
    try {
      const md = readFileSync(join(ADVOCATES_DIR, f), 'utf-8');
      const m = md.match(/^title:\s*(.+?)\s*$/m);
      const name = m ? m[1].replace(/^["']|["']$/g, '').trim() : '';
      if (name) roster.push({ name, slug });
    } catch {
      // unreadable page — skip, stay fail-open
    }
  }
  return roster;
}

let payload: {
  sessions: unknown[];
  speakers: unknown[];
  tracks: unknown[];
  buildAt: string;
  error: string | null;
} = {
  sessions: [], speakers: [], tracks: [], buildAt: new Date().toISOString(), error: null,
};
try {
  const res = await fetch(`${CAP_BASE}/build/teched`);
  if (!res.ok) throw new Error(`status ${res.status}`);
  payload = { ...payload, ...(await res.json()) };
} catch (err) {
  payload.error = err instanceof Error ? err.message : String(err);
  console.warn(`[fetch-teched] warn: ${payload.error} — writing empty payload`);
}

// Enrich speakers with authorLogin by matching displayName against author_index.
// Fail-open: if author_index.json is missing or unparseable, speakers get
// authorLogin: null and no error is thrown.
let authorIndex: Record<string, { login: string; displayName: string }> = {};
try {
  authorIndex = JSON.parse(readFileSync(AUTHOR_INDEX_PATH, 'utf-8'));
} catch {
  // Missing (first build or catalog-only run) — not an error.
}
if (Array.isArray(payload.speakers) && payload.speakers.length) {
  enrichSpeakersWithAuthorLogin(payload.speakers, authorIndex);
  const advocates = loadAdvocateRoster();
  enrichSpeakersWithAdvocateSlug(payload.speakers, advocates);
  const linked = (payload.speakers as { authorLogin?: string | null }[]).filter((s) => s.authorLogin).length;
  const advLinked = (payload.speakers as { advocateSlug?: string | null }[]).filter((s) => s.advocateSlug).length;
  if (linked > 0 || advLinked > 0) console.log(`[fetch-teched] linked ${linked} author + ${advLinked} advocate page(s) across ${payload.speakers.length} speaker(s)`);
}

mkdirSync(join('hugo', 'data'), { recursive: true });
writeFileSync(OUT_PATH, JSON.stringify(payload, null, 2), 'utf-8');
console.log(`[fetch-teched] wrote ${payload.sessions.length} sessions → ${OUT_PATH}`);
