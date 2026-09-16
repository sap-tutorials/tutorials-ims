import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const CAP_BASE = process.env.CAP_BASE_URL || 'http://localhost:4004';
const OUT_PATH = join('hugo', 'data', 'teched.json');
const AUTHOR_INDEX_PATH = join('hugo', 'data', 'author_index.json');

const require = createRequire(import.meta.url);
// author-match.js is CJS (srv/lib convention); safe to require from ESM.
const { enrichSpeakersWithAuthorLogin } = require('../srv/lib/teched/author-match.js');

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
  const linked = (payload.speakers as { authorLogin?: string | null }[]).filter((s) => s.authorLogin).length;
  if (linked > 0) console.log(`[fetch-teched] linked ${linked}/${payload.speakers.length} speaker(s) to author page(s)`);
}

mkdirSync(join('hugo', 'data'), { recursive: true });
writeFileSync(OUT_PATH, JSON.stringify(payload, null, 2), 'utf-8');
console.log(`[fetch-teched] wrote ${payload.sessions.length} sessions → ${OUT_PATH}`);
