// scripts/backfill-attachments.ts
//
// Populates the tutorial-attachment store by fetching each referenced attachment
// from GitHub (this runner has clean GitHub egress) and POSTing the BYTES to the
// srv's `POST /content/attachment` endpoint. The srv never fetches GitHub itself —
// its CF egress IP is anon-404'd by GitHub's raw CDN and it has no runtime
// GitHub token. See srv/lib/attachment-ingest-handler.js.
//
// Enumeration source: the rendered tutorial HTML in hugo/public/tutorials/*/
// index.html — the same `/content/attachment-source?u=<encoded>` references the browser requests.
//
// Usage:
//   CAP_BASE_URL=<srv-url> CONTENT_API_KEY=<key> npm run backfill-attachments
//   ...            [--limit N]        # only the first N unique attachments (smoke)
//   ...            [--concurrency N]  # parallel fetch+push (default 12)
//   ...            [--dry-run]        # enumerate + count only, no fetch/push
//
// GitHub auth (for the FETCH side only): anonymous-first, falls back to a
// Bearer token from TUTORIALS_GITHUB_TOKEN / GITHUB_TOKEN on a 404 (private
// QA -Contribution repos need it; public prod attachments ride anon).

import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { extractAttachmentUrls, channelFor } from '../srv/lib/attachment-warm-utils.js';

interface Args { limit: number; concurrency: number; dryRun: boolean; force: boolean; }

function parseArgs(argv: string[]): Args {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  return {
    limit: Number(get('--limit')) || 0,
    concurrency: Number(get('--concurrency')) || 12,
    dryRun: argv.includes('--dry-run'),
    force: argv.includes('--force'),
  };
}

/** Walk hugo/public/tutorials/<slug>/index.html → Map<sourceUrl, slug>. */
export function collectAttachmentUrls(publicDir: string): Map<string, string> {
  const urlToSlug = new Map<string, string>();
  const tutorialsDir = join(publicDir, 'tutorials');
  if (!existsSync(tutorialsDir)) {
    throw new Error(`Not found: ${tutorialsDir} — run the Hugo build first (npm run build:all).`);
  }
  for (const slug of readdirSync(tutorialsDir)) {
    const indexPath = join(tutorialsDir, slug, 'index.html');
    if (!existsSync(indexPath)) continue;
    let html: string;
    try { html = readFileSync(indexPath, 'utf8'); } catch { continue; }
    for (const u of extractAttachmentUrls(html)) {
      if (!urlToSlug.has(u)) urlToSlug.set(u, slug); // first-seen slug wins
    }
  }
  return urlToSlug;
}

/** True only when u's hostname is exactly raw.githubusercontent.com — prevents token leakage to lookalike hosts. */
export function isRawGithubHost(u: string): boolean {
  try { return new URL(u).hostname.toLowerCase() === 'raw.githubusercontent.com'; } catch { return false; }
}

/** Fetch an attachment: anonymous-first, Bearer-token fallback on 404. */
async function fetchAttachment(u: string, token: string | undefined): Promise<{ ok: boolean; status: number; buffer?: Buffer; mimeType?: string }> {
  const doFetch = (authToken?: string) => {
    const headers: Record<string, string> = { 'User-Agent': 'tutorials-backfill' };
    if (authToken) headers['Authorization'] = `Bearer ${authToken}`;
    return fetch(u, { headers, signal: AbortSignal.timeout(20000) });
  };
  let res = await doFetch();
  if (res.status === 404 && token && isRawGithubHost(u)) {
    res = await doFetch(token);
  }
  if (!res.ok) return { ok: false, status: res.status };
  const buffer = Buffer.from(await res.arrayBuffer());
  const mimeType = res.headers.get('content-type') || 'application/octet-stream';
  return { ok: true, status: res.status, buffer, mimeType };
}

/** POST bytes to the srv ingest endpoint. Returns the server's action. */
async function pushAttachment(baseUrl: string, apiKey: string, u: string, slug: string, buffer: Buffer, mimeType: string, force: boolean): Promise<{ ok: boolean; status: number; action?: string }> {
  const url = `${baseUrl}/content/attachment?u=${encodeURIComponent(u)}&slug=${encodeURIComponent(slug)}${force ? '&force=1' : ''}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': mimeType },
    body: buffer,
    signal: AbortSignal.timeout(30000),
  });
  let action: string | undefined;
  try { action = ((await res.json()) as { action?: string }).action; } catch { /* non-JSON */ }
  return { ok: res.ok, status: res.status, action };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const baseUrl = (process.env.CAP_BASE_URL || '').replace(/\/$/, '');
  const apiKey = process.env.CONTENT_API_KEY || '';
  const token = process.env.TUTORIALS_GITHUB_TOKEN || process.env.GITHUB_TOKEN || undefined;

  if (!baseUrl) { console.error('Fatal: CAP_BASE_URL not set'); process.exit(1); }
  if (!apiKey && !args.dryRun) { console.error('Fatal: CONTENT_API_KEY not set'); process.exit(1); }

  const publicDir = join(process.cwd(), 'hugo', 'public');
  console.log(`Enumerating attachment URLs under ${publicDir}/tutorials ...`);
  let urlToSlug = collectAttachmentUrls(publicDir);
  let entries = [...urlToSlug.entries()];
  const totalUnique = entries.length;
  if (args.limit > 0) entries = entries.slice(0, args.limit);
  console.log(`Found ${totalUnique} unique attachment URL(s)${args.limit ? `, backfilling first ${entries.length}` : ''}.`);
  const channels = entries.reduce((acc, [u]) => { acc[channelFor(u)] = (acc[channelFor(u)] || 0) + 1; return acc; }, {} as Record<string, number>);
  console.log(`Channels: ${JSON.stringify(channels)}`);

  if (args.dryRun) { console.log('Dry run — no fetch/push performed.'); process.exit(0); }

  const stats = { stored: 0, unchanged: 0, fetchFailed: 0, pushFailed: 0 };
  let done = 0;
  const total = entries.length;

  // Simple concurrency pool.
  let cursor = 0;
  async function worker() {
    while (cursor < entries.length) {
      const idx = cursor++;
      const [u, slug] = entries[idx];
      try {
        const got = await fetchAttachment(u, token);
        if (!got.ok) {
          stats.fetchFailed++;
        } else {
          const pushed = await pushAttachment(baseUrl, apiKey, u, slug, got.buffer!, got.mimeType!, args.force);
          if (!pushed.ok) stats.pushFailed++;
          else if (pushed.action === 'unchanged') stats.unchanged++;
          else stats.stored++;
        }
      } catch {
        stats.fetchFailed++;
      }
      done++;
      if (done % 200 === 0 || done === total) {
        console.log(`  ${done}/${total} — stored=${stats.stored} unchanged=${stats.unchanged} fetch-fail=${stats.fetchFailed} push-fail=${stats.pushFailed}`);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, args.concurrency) }, () => worker()));

  console.log('\nBackfill complete:');
  console.log(`  stored:      ${stats.stored}`);
  console.log(`  unchanged:   ${stats.unchanged}`);
  console.log(`  fetch-fail:  ${stats.fetchFailed} (attachment genuinely 404 on GitHub, or network)`);
  console.log(`  push-fail:   ${stats.pushFailed} (srv ingest error)`);
  // Non-zero exit only if EVERY push failed (indicates a broken endpoint/auth),
  // not for individual missing-on-GitHub attachments (expected tail).
  if (total > 0 && stats.stored === 0 && stats.unchanged === 0) process.exit(2);
  process.exit(0);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(err => { console.error('Fatal:', err instanceof Error ? err.message : String(err)); process.exit(1); });
}
