// scripts/backfill-images.ts
//
// Populates the tutorial-image store by fetching each referenced image from
// GitHub (this runner has clean GitHub egress) and POSTing the BYTES to the
// srv's `POST /content/image` endpoint. The srv never fetches GitHub itself —
// its CF egress IP is anon-404'd by GitHub's raw CDN and it has no runtime
// GitHub token. See srv/lib/image-ingest-handler.js.
//
// Enumeration source: the rendered tutorial HTML in hugo/public/tutorials/*/
// index.html — the same `/img-cdn?u=<encoded>` references the browser requests.
//
// Usage:
//   CAP_BASE_URL=<srv-url> CONTENT_API_KEY=<key> npm run backfill-images
//   ...            [--slug <slug>]   # only images referenced by one tutorial (#2288)
//   ...            [--channel qa]    # QA: reads CAP_QA_BASE_URL/CONTENT_API_KEY_QA + hugo/public-qa
//   ...            [--limit N]        # only the first N unique images (smoke)
//   ...            [--concurrency N]  # parallel fetch+push (default 12)
//   ...            [--dry-run]        # enumerate + count only, no fetch/push
//
// GitHub auth (for the FETCH side only): anonymous-first, falls back to a
// Bearer token from TUTORIALS_GITHUB_TOKEN / GITHUB_TOKEN on a 404 (private
// QA -Contribution repos need it; public prod images ride anon).

import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { extractImgCdnUrls, channelFor } from '../srv/lib/image-warm-utils.js';

interface Args { limit: number; concurrency: number; dryRun: boolean; force: boolean; slug?: string; channel: 'prod' | 'qa'; }

/** Read `--slug <value>` from argv; undefined when absent or blank. */
export function parseSlug(argv: string[]): string | undefined {
  const i = argv.indexOf('--slug');
  const v = i >= 0 ? argv[i + 1]?.trim() : undefined;
  return v || undefined;
}

/** Read `--channel qa|prod` from argv; defaults to 'prod'. Mirrors publish-content.ts. */
export function parseChannel(argv: string[]): 'prod' | 'qa' {
  const i = argv.indexOf('--channel');
  return i >= 0 && argv[i + 1]?.trim().toLowerCase() === 'qa' ? 'qa' : 'prod';
}

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
    slug: parseSlug(argv),
    channel: parseChannel(argv),
  };
}

/**
 * Walk hugo/public/tutorials/<slug>/index.html → Map<sourceUrl, slug>.
 *
 * When `slug` is given, only that one tutorial's built HTML is scanned — used
 * by the slug-targeted rebuild path (#2288) to re-warm just the changed
 * tutorial's images without re-fetching the whole catalog. An unknown slug
 * yields an empty map (no throw): nothing to warm.
 */
export function collectImageUrls(publicDir: string, slug?: string): Map<string, string> {
  const urlToSlug = new Map<string, string>();
  const tutorialsDir = join(publicDir, 'tutorials');
  if (!existsSync(tutorialsDir)) {
    throw new Error(`Not found: ${tutorialsDir} — run the Hugo build first (npm run build:all).`);
  }
  const slugs = slug ? [slug] : readdirSync(tutorialsDir);
  for (const s of slugs) {
    const indexPath = join(tutorialsDir, s, 'index.html');
    if (!existsSync(indexPath)) continue;
    let html: string;
    try { html = readFileSync(indexPath, 'utf8'); } catch { continue; }
    for (const u of extractImgCdnUrls(html)) {
      if (!urlToSlug.has(u)) urlToSlug.set(u, s); // first-seen slug wins
    }
  }
  return urlToSlug;
}

/** Fetch an image: anonymous-first, Bearer-token fallback on 404. */
async function fetchImage(u: string, token: string | undefined): Promise<{ ok: boolean; status: number; buffer?: Buffer; mimeType?: string }> {
  const doFetch = (authToken?: string) => {
    const headers: Record<string, string> = { 'User-Agent': 'tutorials-backfill' };
    if (authToken) headers['Authorization'] = `Bearer ${authToken}`;
    return fetch(u, { headers, signal: AbortSignal.timeout(20000) });
  };
  let res = await doFetch();
  if (res.status === 404 && token && /raw\.githubusercontent\.com/.test(u)) {
    res = await doFetch(token);
  }
  if (!res.ok) return { ok: false, status: res.status };
  const buffer = Buffer.from(await res.arrayBuffer());
  const mimeType = res.headers.get('content-type') || 'application/octet-stream';
  return { ok: true, status: res.status, buffer, mimeType };
}

/** POST bytes to the srv ingest endpoint. Returns the server's action. */
async function pushImage(baseUrl: string, apiKey: string, u: string, slug: string, buffer: Buffer, mimeType: string, force: boolean): Promise<{ ok: boolean; status: number; action?: string }> {
  const url = `${baseUrl}/content/image?u=${encodeURIComponent(u)}&slug=${encodeURIComponent(slug)}${force ? '&force=1' : ''}`;
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
  // Channel selects the srv + built-HTML dir, mirroring publish-content.ts.
  const isQa = args.channel === 'qa';
  const baseUrl = ((isQa ? process.env.CAP_QA_BASE_URL : process.env.CAP_BASE_URL) || '').replace(/\/$/, '');
  const apiKey = (isQa ? process.env.CONTENT_API_KEY_QA : process.env.CONTENT_API_KEY) || '';
  const token = process.env.TUTORIALS_GITHUB_TOKEN || process.env.GITHUB_TOKEN || undefined;
  const envHint = isQa ? 'CAP_QA_BASE_URL / CONTENT_API_KEY_QA' : 'CAP_BASE_URL / CONTENT_API_KEY';

  if (!baseUrl) { console.error(`Fatal: ${isQa ? 'CAP_QA_BASE_URL' : 'CAP_BASE_URL'} not set`); process.exit(1); }
  if (!apiKey && !args.dryRun) { console.error(`Fatal: ${isQa ? 'CONTENT_API_KEY_QA' : 'CONTENT_API_KEY'} not set (${envHint})`); process.exit(1); }

  const publicDir = join(process.cwd(), 'hugo', isQa ? 'public-qa' : 'public');
  console.log(`Enumerating image URLs under ${publicDir}/tutorials ${args.slug ? `(slug: ${args.slug}) ` : ''}...`);
  let urlToSlug = collectImageUrls(publicDir, args.slug);
  let entries = [...urlToSlug.entries()];
  const totalUnique = entries.length;
  if (args.limit > 0) entries = entries.slice(0, args.limit);
  console.log(`Found ${totalUnique} unique image URL(s)${args.limit ? `, backfilling first ${entries.length}` : ''}.`);
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
        const got = await fetchImage(u, token);
        if (!got.ok) {
          stats.fetchFailed++;
        } else {
          const pushed = await pushImage(baseUrl, apiKey, u, slug, got.buffer!, got.mimeType!, args.force);
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
  console.log(`  fetch-fail:  ${stats.fetchFailed} (image genuinely 404 on GitHub, or network)`);
  console.log(`  push-fail:   ${stats.pushFailed} (srv ingest error)`);
  // Non-zero exit only if EVERY push failed (indicates a broken endpoint/auth),
  // not for individual missing-on-GitHub images (expected tail).
  if (total > 0 && stats.stored === 0 && stats.unchanged === 0) process.exit(2);
  process.exit(0);
}

// Only run main() when executed directly (not when imported by tests).
const isMainModule = process.argv[1] && (
  process.argv[1].endsWith('backfill-images.ts') ||
  process.argv[1].endsWith('backfill-images.js')
);
if (isMainModule) {
  main().catch(err => { console.error('Fatal:', err instanceof Error ? err.message : String(err)); process.exit(1); });
}
