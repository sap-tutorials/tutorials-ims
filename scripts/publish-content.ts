import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { parse as parseYaml } from 'yaml';

// --- Build validation ---

const DEV_ARTIFACT_PATTERNS = [
  { pattern: /data-cap-base="http:\/\/localhost/, label: 'data-cap-base pointing to localhost' },
  { pattern: /livereload\.js/, label: 'Hugo livereload script injection' },
  { pattern: /<script>document\.write.*livereload/s, label: 'Hugo dev server livereload' },
];

export function validateProductionBuild(tutorials: Map<string, string>, sampleSize = 5): string[] {
  const slugs = [...tutorials.keys()];
  const sample = slugs.slice(0, Math.min(sampleSize, slugs.length));
  const violations: string[] = [];

  for (const slug of sample) {
    const content = readFileSync(tutorials.get(slug)!, 'utf-8');
    for (const { pattern, label } of DEV_ARTIFACT_PATTERNS) {
      if (pattern.test(content)) {
        violations.push(`${slug}: ${label}`);
      }
    }
  }
  return violations;
}

// --- Pure functions (exported for testing) ---

export function discoverTutorials(hugoDir: string): Map<string, string> {
  const tutorialsDir = join(hugoDir, 'tutorials');
  const result = new Map<string, string>();

  let entries: string[];
  try {
    entries = readdirSync(tutorialsDir);
  } catch {
    return result;
  }

  for (const entry of entries) {
    const indexPath = join(tutorialsDir, entry, 'index.html');
    try {
      const stat = statSync(indexPath);
      if (stat.isFile()) {
        result.set(entry, indexPath);
      }
    } catch {
      // not a tutorial directory
    }
  }

  return result;
}

export function computeLocalHashes(tutorials: Map<string, string>): Map<string, string> {
  const hashes = new Map<string, string>();
  for (const [slug, filePath] of tutorials) {
    const content = readFileSync(filePath);
    const hash = createHash('sha256').update(content).digest('hex');
    hashes.set(slug, hash);
  }
  return hashes;
}

export function computeDiff(
  local: Map<string, string>,
  remote: Record<string, string>
): string[] {
  const changed: string[] = [];
  for (const [slug, localHash] of local) {
    if (remote[slug] !== localHash) {
      changed.push(slug);
    }
  }
  return changed;
}

export function buildPayload(
  slugs: string[],
  tutorials: Map<string, string>
): Record<string, string> {
  const payload: Record<string, string> = {};
  for (const slug of slugs) {
    const filePath = tutorials.get(slug);
    if (!filePath) continue;
    const content = readFileSync(filePath);
    const compressed = gzipSync(content);
    payload[slug] = compressed.toString('base64');
  }
  return payload;
}

// --- Body text extraction (for HANA full-text search) ---

const TUTORIAL_MAIN_RE = /<main\b[^>]*class\s*=\s*["']?[^"'>]*\btutorial-main\b[^"'>]*["']?[^>]*>([\s\S]*?)<\/main>/i;
const BODY_RE = /<body\b[^>]*>([\s\S]*?)<\/body>/i;
const STRIP_BLOCKS_RE = /<(script|style|nav|footer|aside)\b[^>]*>[\s\S]*?<\/\1>/gi;
const TAG_RE = /<[^>]+>/g;
const WHITESPACE_RE = /\s+/g;

const ENTITY_MAP: Record<string, string> = {
  '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"',
  '&#39;': "'", '&apos;': "'", '&nbsp;': ' ',
};

export function extractBodyText(html: string): string {
  const mainMatch = html.match(TUTORIAL_MAIN_RE);
  let zone = mainMatch ? mainMatch[1] : (html.match(BODY_RE)?.[1] ?? html);

  zone = zone.replace(STRIP_BLOCKS_RE, ' ');
  zone = zone.replace(TAG_RE, ' ');
  zone = zone.replace(/&[a-z#0-9]+;/gi, m => ENTITY_MAP[m.toLowerCase()] ?? ' ');
  zone = zone.replace(WHITESPACE_RE, ' ').trim();

  return zone;
}

export function extractAllBodyTexts(
  tutorials: Map<string, string>,
  slugs: string[]
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const slug of slugs) {
    const filePath = tutorials.get(slug);
    if (!filePath) continue;
    const html = readFileSync(filePath, 'utf-8');
    const text = extractBodyText(html);
    if (text) result[slug] = text;
  }
  return result;
}

// --- Metadata extraction ---

export interface StepMeta {
  number: number;
  title: string;
}

export interface TutorialMeta {
  slug: string;
  title: string;
  description: string;
  time: number | null;
  level: string | null;
  primaryTag: string | null;
  stepCount: number;
  steps: StepMeta[];
  lastUpdated: string | null;
  primaryContributorEmail: string | null;
  primaryContributorLogin: string | null;
}

export function extractMetadata(
  contentDir: string,
  slugs: string[]
): Record<string, TutorialMeta> {
  const result: Record<string, TutorialMeta> = {};

  for (const slug of slugs) {
    const mdPath = join(contentDir, `${slug}.md`);
    if (!existsSync(mdPath)) continue;

    const raw = readFileSync(mdPath, 'utf-8');
    const fmMatch = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (!fmMatch) continue;

    let fm: any;
    try {
      fm = parseYaml(fmMatch[1]);
    } catch {
      continue;
    }

    const steps: StepMeta[] = Array.isArray(fm.steps)
      ? fm.steps.map((s: any) => ({ number: s.number ?? 0, title: s.title ?? '' }))
      : [];

    const trim = (v: unknown): string | null =>
      typeof v === 'string' && v.trim().length > 0 ? v.trim() : null;

    const contributors = Array.isArray(fm.contributors) ? fm.contributors : [];
    const primary = contributors.length > 0 ? contributors[0] : null;
    const primaryContributorEmail = primary ? trim((primary as any).email) : null;
    const primaryContributorLogin = primary ? trim((primary as any).login) : null;

    result[slug] = {
      slug,
      title: fm.title ?? slug,
      description: fm.description ?? '',
      time: typeof fm.time === 'number' ? fm.time : null,
      level: fm.level ?? null,
      primaryTag: fm.primaryTag ?? null,
      stepCount: fm.stepCount ?? steps.length,
      steps,
      lastUpdated: trim(fm.lastUpdated),
      primaryContributorEmail,
      primaryContributorLogin,
    };
  }

  return result;
}

// --- CLI ---

interface PublishOptions {
  hugoDir: string;
  baseUrl: string;
  apiKey: string;
  trigger: string;
  hugoVersion: string;
  dryRun: boolean;
  force: boolean;
  verbose: boolean;
}

function parseArgs(argv: string[]): PublishOptions {
  const get = (flag: string, fallback: string): string => {
    const idx = argv.indexOf(flag);
    return idx !== -1 && idx + 1 < argv.length ? argv[idx + 1] : fallback;
  };
  const has = (flag: string): boolean => argv.includes(flag);

  return {
    hugoDir: get('--hugo-dir', 'hugo/public'),
    baseUrl: get('--base-url', process.env.CAP_BASE_URL || 'http://localhost:4004'),
    apiKey: get('--api-key', process.env.CONTENT_API_KEY || ''),
    trigger: get('--trigger', `manual@${process.env.GITHUB_SHA?.slice(0, 7) || 'local'}`),
    hugoVersion: get('--hugo-version', ''),
    dryRun: has('--dry-run'),
    force: has('--force'),
    verbose: has('--verbose'),
  };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  if (!opts.apiKey) {
    console.error('Error: No API key. Set CONTENT_API_KEY env var or pass --api-key');
    process.exit(1);
  }

  const log = opts.verbose ? console.log : () => {};

  log(`Discovering tutorials in ${opts.hugoDir}...`);
  const tutorials = discoverTutorials(opts.hugoDir);

  if (tutorials.size === 0) {
    console.error('Error: No tutorials found. Did you run the Hugo build?');
    process.exit(1);
  }

  log(`Found ${tutorials.size} tutorials`);

  const violations = validateProductionBuild(tutorials);
  if (violations.length > 0) {
    console.error('Error: Hugo output contains dev-build artifacts. Refusing to publish.');
    console.error('Run `hugo --environment production` before publishing.\n');
    for (const v of violations) {
      console.error(`  ✗ ${v}`);
    }
    process.exit(1);
  }
  log('Production build validation passed');

  log('Computing local hashes...');
  const localHashes = computeLocalHashes(tutorials);

  let changed: string[];

  if (opts.force) {
    log('Force mode: publishing all tutorials');
    changed = [...localHashes.keys()];
  } else {
    log(`Fetching remote hashes from ${opts.baseUrl}/content/hashes...`);
    let remoteHashes: Record<string, string> = {};
    try {
      const res = await fetch(`${opts.baseUrl}/content/hashes`);
      if (res.ok) {
        remoteHashes = await res.json() as Record<string, string>;
      } else if (res.status === 503) {
        log('No active content version — will publish all');
      } else {
        console.error(`Warning: Failed to fetch remote hashes (HTTP ${res.status}), publishing all`);
      }
    } catch (err) {
      console.error(`Warning: Cannot reach ${opts.baseUrl}/content/hashes, publishing all`);
    }

    changed = computeDiff(localHashes, remoteHashes);
  }

  if (changed.length === 0) {
    console.log('No changes detected. Nothing to publish.');
    process.exit(0);
  }

  console.log(`${changed.length} of ${tutorials.size} tutorials changed`);

  if (opts.dryRun) {
    console.log('Dry run — would publish:');
    for (const slug of changed.sort()) {
      console.log(`  ${slug}`);
    }
    process.exit(0);
  }

  log('Building payload...');
  const startTime = Date.now();
  const payload = buildPayload(changed, tutorials);

  // Include nav metadata so /content/nav can serve it without DB JOINs
  const navJsonPath = join(opts.hugoDir, 'tutorials', '_nav.json');
  if (existsSync(navJsonPath)) {
    const navContent = readFileSync(navJsonPath);
    const navData = JSON.parse(navContent.toString('utf-8'));
    const allNavTutorials = navData.tutorials ?? navData;
    const filteredNav = JSON.stringify({ tutorials: allNavTutorials });
    payload['__nav__'] = gzipSync(Buffer.from(filteredNav)).toString('base64');
    log(`Included nav metadata for ${allNavTutorials.length} tutorials`);
  }

  // Include the 404 page so the serveHandler can render styled "Tutorial not found"
  // instead of a JSON error. Always sent — small enough that delta detection isn't worth it.
  const notFoundPath = join(opts.hugoDir, '404.html');
  if (existsSync(notFoundPath)) {
    const notFoundContent = readFileSync(notFoundPath);
    payload['__404__'] = gzipSync(notFoundContent).toString('base64');
    log(`Included 404 page (${notFoundContent.length} bytes)`);
  }

  // Extract tutorial metadata for DB upsert (self-healing — ensures Tutorials + Steps exist)
  const hugoContentDir = join(opts.hugoDir, '..', 'content', 'tutorials');
  const allSlugs = [...tutorials.keys()];
  const metadata = extractMetadata(hugoContentDir, allSlugs);
  log(`Extracted metadata for ${Object.keys(metadata).length} tutorials`);

  const bodyTexts = extractAllBodyTexts(tutorials, allSlugs);
  log(`Extracted body text for ${Object.keys(bodyTexts).length} tutorials`);

  const body = JSON.stringify({
    trigger: opts.trigger,
    hugoVersion: opts.hugoVersion || undefined,
    files: payload,
    metadata,
    bodyTexts,
  });

  const sizeMB = (Buffer.byteLength(body) / 1024 / 1024).toFixed(1);
  log(`Payload size: ${sizeMB} MB`);

  log(`Publishing to ${opts.baseUrl}/content/publish...`);
  const res = await fetch(`${opts.baseUrl}/content/publish`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${opts.apiKey}`,
    },
    body,
  });

  if (!res.ok) {
    const errBody = await res.text();
    console.error(`Publish failed (HTTP ${res.status}): ${errBody}`);
    process.exit(1);
  }

  const result = await res.json() as {
    version: number;
    filesWritten: number;
    totalSizeBytes: number;
    durationMs: number;
  };
  const totalMs = Date.now() - startTime;

  console.log(`Published successfully:`);
  console.log(`  Version:    ${result.version}`);
  console.log(`  Files:      ${result.filesWritten}`);
  console.log(`  Size:       ${(result.totalSizeBytes / 1024 / 1024).toFixed(1)} MB (decompressed)`);
  console.log(`  Server:     ${result.durationMs} ms`);
  console.log(`  Total:      ${totalMs} ms`);
}

// Run CLI when executed directly
const isMain = process.argv[1]?.includes('publish-content');
if (isMain) {
  main().catch(err => {
    console.error('Fatal:', err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
