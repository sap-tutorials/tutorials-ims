import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { isoWeekId, isoWeekStart } from './iso-week.mjs';

export function emptyScaffold() {
  return { generatedAt: new Date(0).toISOString(), repos: [], entries: [] };
}

export function buildEntry(pr, summary) {
  const merged = new Date(pr.mergedAt);
  return {
    id: pr.id,
    repo: pr.repo,
    label: pr.label,
    number: pr.number,
    title: (summary.title || pr.title || '').trim(),
    summary: (summary.summary || '').trim(),
    category: summary.category,
    mergedAt: pr.mergedAt,
    week: isoWeekId(merged),
    weekStart: isoWeekStart(merged),
    url: pr.url,
  };
}

export function mergeEntries(existing, incoming) {
  const byId = new Map(existing.map((e) => [e.id, e]));
  for (const e of incoming) {
    if (!byId.has(e.id)) byId.set(e.id, e); // existing wins → stable wording
  }
  return [...byId.values()].sort((a, b) =>
    a.mergedAt < b.mergedAt ? 1 : a.mergedAt > b.mergedAt ? -1 : 0);
}

function readJson(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); }
  catch { return fallback; }
}

function main(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (!tok.startsWith('--')) continue;
    const eq = tok.indexOf('=');
    if (eq !== -1) { args[tok.slice(2, eq)] = tok.slice(eq + 1); }
    else { args[tok.slice(2)] = argv[++i]; }
  }
  const data = readJson(args.data, emptyScaffold());
  const pending = readJson(args.pending, []);
  const summaries = readJson(args.summaries, []);
  const sumById = new Map(summaries.map((s) => [s.id, s]));
  const built = [];
  for (const pr of pending) {
    const s = sumById.get(pr.id);
    if (!s) { console.warn(`[merge] no summary for ${pr.id} — skipping`); continue; }
    built.push(buildEntry(pr, s));
  }
  data.entries = mergeEntries(data.entries || [], built);
  data.generatedAt = new Date().toISOString();
  fs.writeFileSync(args.data, JSON.stringify(data, null, 2) + '\n');
  console.log(`[merge] added ${built.length} new entries; total ${data.entries.length}`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2));
}
