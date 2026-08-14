import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export function toEntryStub(pr, repoKey, repoLabel) {
  return {
    id: `${repoKey}#${pr.number}`,
    repo: repoKey,
    label: repoLabel,
    number: pr.number,
    title: pr.title || '',
    body: pr.body || '',
    mergedAt: pr.mergedAt,
    url: pr.url,
    labels: (pr.labels || []).map((l) => l.name),
  };
}

// ISO strings compare chronologically as long as both are UTC ('Z'). A
// date-only cutoff ('YYYY-MM-DD') is a prefix of any same-day timestamp, so
// mergedAt >= cutoff correctly includes the whole cutoff day.
export function filterPending(stubs, existingIds, sinceIso) {
  const seen = new Set(existingIds);
  return stubs.filter((s) => !seen.has(s.id) && s.mergedAt >= sinceIso);
}

function resolveSince(args) {
  if (args.since) return args.since;
  const days = Number(args.days || 90);
  return new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
}

function fetchRepoPrs(slug, sinceDate) {
  const out = execFileSync('gh', [
    'pr', 'list', '--repo', slug, '--state', 'merged',
    '--search', `merged:>=${sinceDate}`, '--limit', '300',
    '--json', 'number,title,body,mergedAt,url,labels',
  ], { encoding: 'utf8', maxBuffer: 1 << 26 });
  return JSON.parse(out);
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
  let rawData;
  try { rawData = fs.readFileSync(args.data, 'utf8'); } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    rawData = '';
  }
  const data = rawData.trim() ? JSON.parse(rawData) : { repos: [], entries: [] };
  const since = resolveSince(args);
  const sinceDate = since.slice(0, 10); // gh search qualifier takes a date
  const existingIds = (data.entries || []).map((e) => e.id);
  const pending = [];
  for (const repo of data.repos || []) {
    if (!repo.slug || repo.slug.startsWith('<')) {
      console.warn(`[fetch] skipping placeholder repo "${repo.key}"`);
      continue;
    }
    try {
      const prs = fetchRepoPrs(repo.slug, sinceDate);
      const stubs = prs.map((pr) => toEntryStub(pr, repo.key, repo.label));
      pending.push(...filterPending(stubs, existingIds, since));
    } catch (err) {
      console.warn(`[fetch] skipping ${repo.slug}: ${err.message.split('\n')[0]}`);
    }
  }
  fs.writeFileSync(args.out, JSON.stringify(pending, null, 2) + '\n');
  console.log(`[fetch] ${pending.length} pending PR(s) since ${since} → ${args.out}`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2));
}
