import { readFileSync, readdirSync, statSync, existsSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { userInfo, hostname } from 'node:os';
import { parse as parseYaml } from 'yaml';
import { parseChannel, type Channel } from './fetch-tutorials.js';
import { beginSession, appendBatch, commitSession, abortSession, fetchRemoteHashes, fetchRemoteSourceHashes } from './lib/publish-client.js';
import { withRetry, formatErrorChain } from './lib/publish-retry.js';
import { chunk, runConcurrent } from './lib/publish-batcher.js';
import { collectCodeCheckSpecs, publishCodeCheckSpecs } from './lib/publish-codecheck.js';
import { publishValidateAnswerSpecs } from './lib/publish-validate-answer.js';
import { computeOrphans, enforceCap, formatStepSummary } from './lib/purge-orphans.js';

export type { Channel };

/**
 * Coerce arbitrary values to a trimmed non-empty string, or null. Used by
 * frontmatter extractors that may receive missing keys, numbers, or empties.
 */
const trim = (v: unknown): string | null =>
  typeof v === 'string' && v.trim().length > 0 ? v.trim() : null;

export interface PublishConfig {
  baseUrl: string;
  apiKey: string | undefined;
  sourceDir: string;
  force: boolean;
}

export function resolvePublishConfig({ channel }: { channel: Channel }): PublishConfig {
  if (channel === 'qa') {
    return {
      baseUrl: process.env.CAP_QA_BASE_URL ?? 'http://localhost:4005',
      apiKey: process.env.CONTENT_API_KEY_QA,
      sourceDir: 'hugo/public-qa',
      force: true,
    };
  }
  return {
    baseUrl: process.env.CAP_BASE_URL ?? 'http://localhost:4004',
    apiKey: process.env.CONTENT_API_KEY,
    sourceDir: 'hugo/public',
    force: process.argv.includes('--force'),
  };
}

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

// Concept landing pages (#446 Track 3-A). Walks hugo/public/concepts/<slug>/
// and emits a map keyed by `concept-<slug>` so the rest of the publish
// pipeline (hash, payload, session) handles them transparently alongside
// tutorials. The `concept-` prefix lets the serve handler (srv/server.js)
// and ContentFiles share one slug column without a schema change.
export function discoverConcepts(hugoDir: string): Map<string, string> {
  const conceptsDir = join(hugoDir, 'concepts');
  const result = new Map<string, string>();

  let entries: string[];
  try {
    entries = readdirSync(conceptsDir).filter(e => !e.startsWith('_'));
  } catch {
    // concepts/ directory missing entirely (no concepts published yet) —
    // that's a normal state for fresh installs and the QA channel.
    return result;
  }

  for (const entry of entries) {
    const indexPath = join(conceptsDir, entry, 'index.html');
    try {
      const stat = statSync(indexPath);
      if (stat.isFile()) {
        result.set(`concept-${entry}`, indexPath);
      }
    } catch {
      // not a concept directory
    }
  }

  return result;
}

// Concept slug predicate — used to skip Tutorials-only metadata extraction
// for concept landing pages (metadata, bodyText, branchSpecs, source markdown
// are all keyed off Tutorials.slug; concept-* keys would orphan in those
// tables).
export function isConceptSlug(slug: string): boolean {
  return typeof slug === 'string' && slug.startsWith('concept-');
}

// A slug points at a runtime-SSR'd catalog page (groups/missions) since PR
// #115 (#91). Such slugs must NEVER reach the publish endpoint; the server
// rejects them too, but we strip locally as well so payload size and CI
// logs stay clean. See issue #114.
export function isCatalogSlug(slug: string): boolean {
  return slug.startsWith('group-') || slug.startsWith('mission-');
}

// Strips catalog slugs from the discovery map in place, returning the
// removed slugs in deterministic (sorted) order so callers can log them.
export function stripCatalogSlugs(tutorials: Map<string, string>): string[] {
  const dropped: string[] = [];
  for (const slug of tutorials.keys()) {
    if (isCatalogSlug(slug)) {
      dropped.push(slug);
      tutorials.delete(slug);
    }
  }
  return dropped.sort();
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

/**
 * Build the source-markdown side of the publish payload (PR #591). For each
 * slug, reads `<cacheDir>/<slug>.md` (the raw upstream tutorial markdown that
 * `fetch-tutorials.ts` populated), gzips it, base64-encodes, and stores under
 * the same slug key. Slugs whose source file is missing are silently skipped
 * — the server stores null sourceContent/sourceHash for those rows, and
 * `/content/source-hashes` simply omits them. This is the right behavior for
 * special slugs (`__shell__`, `__nav__`, `__404__`) that have no upstream
 * markdown.
 *
 * Returns the gzipped-base64 map AND a parallel map of pre-gzip SHA-256
 * hashes; the server independently re-hashes after gunzip and rejects on
 * mismatch (defense against in-flight corruption), but exposing the hash
 * locally lets the CLI auto-verify against `/content/source-hashes`
 * without round-tripping through gzip.
 */
/**
 * #672 short-circuit support: compute pre-gzip SHA-256 of each slug's source
 * markdown WITHOUT building the gzip payload. Used in delta mode to drop slugs
 * whose source bytes already match the server, before paying for buildPayload's
 * Hugo-output re-read + gzip.
 *
 * Slugs whose source file is missing (special slugs: __shell__, __nav__, __404__)
 * are silently skipped.
 */
export function computeLocalSourceHashes(
  slugs: string[],
  cacheDir: string
): Map<string, string> {
  const sourceHashes = new Map<string, string>();
  for (const slug of slugs) {
    const mdPath = join(cacheDir, `${slug}.md`);
    if (!existsSync(mdPath)) continue;
    const content = readFileSync(mdPath);
    const hash = createHash('sha256').update(content).digest('hex');
    sourceHashes.set(slug, hash);
  }
  return sourceHashes;
}

export function buildSourcePayload(
  slugs: string[],
  cacheDir: string
): { sources: Record<string, string>; sourceHashes: Map<string, string> } {
  const sources: Record<string, string> = {};
  const sourceHashes = computeLocalSourceHashes(slugs, cacheDir);
  for (const slug of slugs) {
    const mdPath = join(cacheDir, `${slug}.md`);
    if (!existsSync(mdPath)) continue;
    const content = readFileSync(mdPath);
    const compressed = gzipSync(content);
    sources[slug] = compressed.toString('base64');
  }
  return { sources, sourceHashes };
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

// --- Branch spec extraction (issue #172 PR 3) ---
// Reads branchPoints / skipPoints out of each tutorial's parsed Hugo
// frontmatter so they ride along in the publish payload and land in the
// BranchSpecs sidecar entity. Tutorials with no branches/skips are skipped
// entirely (no row written) — the decide handler treats absence as "linear".

export interface BranchSpec {
  branchPoints: Array<{
    id: string;
    parentStepNumber: number;
    groupKey: string;
    branches: Array<{
      key: string;
      label: string;
      condition: string | null;
      embeddingHint: string | null;
    }>;
  }>;
  skipPoints: Array<{
    stepNumber: number;
    skipIf: string;
    skipLabel?: string;
    skipReason?: string;
  }>;
}

export function extractAllBranchSpecs(
  contentDir: string,
  slugs: string[]
): Record<string, BranchSpec> {
  const out: Record<string, BranchSpec> = {};
  for (const slug of slugs) {
    const fmPath = join(contentDir, `${slug}.md`);
    if (!existsSync(fmPath)) continue;
    const raw = readFileSync(fmPath, 'utf-8');
    const fmMatch = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (!fmMatch) continue;
    let fm: any;
    try { fm = parseYaml(fmMatch[1]); } catch { continue; }

    const branchPoints: BranchSpec['branchPoints'] = [];
    const skipPoints: BranchSpec['skipPoints'] = [];

    for (const step of (fm.steps ?? [])) {
      if (step.branchPointId && Array.isArray(step.branches)) {
        branchPoints.push({
          id: step.branchPointId,
          parentStepNumber: step.number,
          groupKey: step.branchGroup,
          branches: step.branches.map((b: any) => ({
            key: b.key,
            label: b.label,
            condition: b.condition ?? null,
            embeddingHint: b.embeddingHint ?? null,
          })),
        });
      }
      if (step.skipIf) {
        skipPoints.push({
          stepNumber: step.number,
          skipIf: step.skipIf,
          skipLabel: step.skipLabel,
          skipReason: step.skipReason,
        });
      }
    }

    if (branchPoints.length || skipPoints.length) {
      out[slug] = { branchPoints, skipPoints };
    }
  }
  return out;
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
  frontmatterGithubLogin: string | null;
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

    const contributors = Array.isArray(fm.contributors) ? fm.contributors : [];
    const primary = contributors.length > 0 ? contributors[0] : null;
    const primaryContributorEmail = primary ? trim((primary as any).email) : null;
    const primaryContributorLogin = primary ? trim((primary as any).login) : null;

    const frontmatterGithubLogin = trim(fm.githubLogin);

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
      frontmatterGithubLogin,
    };
  }

  return result;
}

// --- CLI ---

/** Append a markdown block to $GITHUB_STEP_SUMMARY if set. No-op locally. */
function writeStepSummary(markdown: string) {
  const target = process.env.GITHUB_STEP_SUMMARY;
  if (!target) return;
  try {
    appendFileSync(target, markdown + '\n');
  } catch (err) {
    console.error(`[purge-orphans] Failed to append $GITHUB_STEP_SUMMARY: ${formatErrorChain(err)}`);
  }
}

export function validateFlagCombo(flags: { force: boolean; heal: boolean; verifyOnly: boolean; purgeOrphans?: boolean }) {
  const modes = [
    flags.force && 'force',
    flags.heal && 'heal',
    flags.verifyOnly && 'verify-only',
    flags.purgeOrphans && 'purge-orphans'
  ].filter(Boolean);
  if (modes.length > 1) {
    throw new Error(`Flags ${modes.join(', ')} are mutually exclusive`);
  }
}

export type PublishMode = 'force' | 'heal' | 'delta';

export function computePublishPlan(opts: {
  local: Map<string, string>;
  remote: Record<string, string>;
  mode: PublishMode;
}): { targetSlugs: string[] } {
  if (opts.mode === 'force') return { targetSlugs: [...opts.local.keys()] };
  return { targetSlugs: computeDiff(opts.local, opts.remote) };
}

/**
 * #672 short-circuit: drop slugs from `targetSlugs` whose state is already in
 * sync with the server. A slug is in sync when BOTH:
 *   - source-markdown hash matches the server's stored sourceHash, AND
 *   - rendered-HTML hash matches the server's stored contentHash.
 *
 * The double-hash check is critical. The original #672 design (PR #675) only
 * compared source-markdown — which works for the regression mode it was built
 * to catch (stale workstation cache re-uploads old bytes) but silently hides
 * the much more common case where Hugo's templates change without any source-
 * markdown change. In that case every rendered HTML differs from the server
 * but every source-md matches, so a source-only short-circuit drops every
 * slug from the publish payload, the server carries forward stale HTML, and
 * post-publish auto-verify fails (rebuild-content workflow run 28304515829,
 * the first run after #675 merged, hit exactly this).
 *
 * Pure function: no I/O. The caller is responsible for fetching the server
 * source-hash map and computing the local source-hash map.
 *
 * @param targetSlugs   slugs that `computePublishPlan` selected for upload
 * @param localSource   slug → SHA-256 of source markdown (from cache)
 * @param serverSource  slug → SHA-256 of source markdown (from /content/source-hashes)
 * @param localHtml     slug → SHA-256 of rendered HTML (from hugo/public)
 * @param serverHtml    slug → SHA-256 of rendered HTML (from /content/hashes)
 * @returns the filtered target slug list (a slug is kept unless BOTH hashes match)
 */
export function applySourceHashShortCircuit(opts: {
  targetSlugs: string[];
  localSource: Map<string, string>;
  serverSource: Record<string, string>;
  localHtml: Map<string, string>;
  serverHtml: Record<string, string>;
}): string[] {
  return opts.targetSlugs.filter((slug) => {
    const localSrc = opts.localSource.get(slug);
    const serverSrc = opts.serverSource[slug];
    const localHtml = opts.localHtml.get(slug);
    const serverHtml = opts.serverHtml[slug];
    // Drop only when BOTH source-md AND rendered-HTML match the server.
    // Missing local hash (special slug) or missing server hash (new slug) → keep.
    const sourceInSync = !!(localSrc && serverSrc && localSrc === serverSrc);
    const htmlInSync = !!(localHtml && serverHtml && localHtml === serverHtml);
    return !(sourceInSync && htmlInSync);
  });
}

interface PublishOptions {
  hugoDir: string;
  baseUrl: string;
  apiKey: string;
  trigger: string;
  hugoVersion: string;
  initiator: string;
  dryRun: boolean;
  force: boolean;
  heal: boolean;
  verifyOnly: boolean;
  verbose: boolean;
  concurrency: number;
  batchSize: number;
  purgeOrphans: boolean;
  purgeCapAbs: number;
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
    apiKey:  get('--api-key',  process.env.CONTENT_API_KEY || ''),
    trigger: get('--trigger',  `manual@${process.env.GITHUB_SHA?.slice(0, 7) || 'local'}`),
    hugoVersion: get('--hugo-version', ''),
    initiator: get(
      '--initiator',
      process.env.INITIATOR
        || `${userInfo().username || 'unknown'}@${hostname()}`
    ),
    dryRun:    has('--dry-run'),
    force:     has('--force'),
    heal:      has('--heal'),
    verifyOnly: has('--verify-only'),
    verbose:   has('--verbose'),
    concurrency: parseInt(get('--concurrency', '6'), 10),
    batchSize:   parseInt(get('--batch-size', '50'), 10),
    purgeOrphans: has('--purge-orphans'),
    purgeCapAbs:  parseInt(get('--purge-cap-abs', process.env.PURGE_CAP_ABS ?? '50'), 10),
  };
}

function pickEntries<T>(src: Record<string, T>, keys: string[]): Record<string, T> {
  const out: Record<string, T> = {};
  for (const k of keys) if (k in src) out[k] = src[k];
  return out;
}

async function collectSidecars(hugoDir: string, payload: Record<string, string>, log: (s: string) => void, channel: Channel = "prod"): Promise<string[]> {
  const keys: string[] = [];
  const navJsonPath = join(hugoDir, 'tutorials', '_nav.json');
  if (existsSync(navJsonPath)) {
    const navContent = readFileSync(navJsonPath);
    const navData = JSON.parse(navContent.toString('utf-8'));
    const allNavTutorials = navData.tutorials ?? navData;
    payload['__nav__'] = gzipSync(Buffer.from(JSON.stringify({ tutorials: allNavTutorials }))).toString('base64');
    keys.push('__nav__');
    log(`Included nav metadata for ${allNavTutorials.length} tutorials`);
  }
  const notFoundPath = join(hugoDir, '404.html');
  if (existsSync(notFoundPath)) {
    const notFoundContent = readFileSync(notFoundPath);
    payload['__404__'] = gzipSync(notFoundContent).toString('base64');
    keys.push('__404__');
  }
  // The chrome shell wraps tutorial content with site-wide UI (header, nav,
  // footer, Joule FAB, etc.). On the QA channel, hugo.qa.toml strips all that
  // chrome AND the QA srv at /tutorials-qa/ stands alone for author preview —
  // the __shell__ slug is unused server-side for QA reads. Skipping avoids
  // a hard failure when the QA Hugo build legitimately doesn't emit
  // _shell/index.html. Issue: rebuild-content-qa.yml run #27885050471.
  if (channel === 'qa') {
    log('Skipping __shell__ sidecar (QA channel — no chrome wrapping)');
    return keys;
  }
  const shellPath = join(hugoDir, '_shell', 'index.html');
  if (!existsSync(shellPath)) {
    throw new Error(`[publish-content] _shell/index.html missing — Hugo build did not emit chrome shell. Path: ${shellPath}`);
  }
  const shellRaw = readFileSync(shellPath, 'utf-8');
  const mainMatch = shellRaw.match(/<main\b[^>]*>[\s\S]*?<\/main>/);
  if (!mainMatch) throw new Error('[publish-content] _shell/index.html does not contain <main>...</main>');
  const shellHtml = shellRaw.replace(mainMatch[0], '<!-- MAIN -->');
  if (shellHtml.length < 1000) throw new Error(`[publish-content] chrome shell suspiciously small (${shellHtml.length} bytes)`);
  payload['__shell__'] = gzipSync(Buffer.from(shellHtml, 'utf-8')).toString('base64');
  keys.push('__shell__');
  return keys;
}


async function main() {
  const channel = parseChannel(process.argv);
  const opts = parseArgs(process.argv.slice(2));

  if (channel === 'qa') {
    const cfg = resolvePublishConfig({ channel });
    opts.hugoDir = cfg.sourceDir;
    opts.baseUrl = cfg.baseUrl;
    opts.apiKey = cfg.apiKey ?? '';
    opts.force = cfg.force;
  }

  // --verify-only is a read-only call against the public /content/source-hashes
  // endpoint (PR #591; pre-PR #591 it used /content/hashes — also public-read).
  // No auth needed, so the API key check is skipped. Without this exemption,
  // the daily content-drift-check workflow could never succeed (it sets
  // CONTENT_API_KEY="" deliberately).
  if (!opts.apiKey && !opts.verifyOnly) {
    const envHint = channel === 'qa' ? 'CONTENT_API_KEY_QA' : 'CONTENT_API_KEY';
    console.error(`Error: No API key. Set ${envHint} env var or pass --api-key`);
    process.exit(1);
  }

  const log = opts.verbose ? console.log : () => {};

  // --- verify-only short-circuit ---
  //
  // PR #591 design: --verify-only compares source-markdown hashes, NOT
  // rendered-HTML hashes. The rendered HTML is volatile-by-design relative to
  // upstream (recs rail + CAP-fed breadcrumbs + Shiki vs Chroma + ...), and
  // every previous attempt to normalize those volatile regions out of the hash
  // (#589, #590) failed to scale because there are too many. The source
  // markdown changes only when an author edits the upstream tutorial — a
  // monotonic, meaningful signal.
  //
  // The drift workflow now runs ONLY `npm run fetch-tutorials` before
  // --verify-only — no Hugo build, no Shiki, no Vue. Fast (~1-2 min) and
  // accurate.
  //
  // Runs BEFORE `discoverTutorials(opts.hugoDir)` so the drift workflow
  // doesn't need to build Hugo at all. Pre-PR #591 the verify-only path
  // ran AFTER the Hugo-discovery step and would error out with 'No
  // tutorials found. Did you run the Hugo build?' on a workflow that
  // skipped Hugo — caught the morning of 2026-06-24 by run 28104752827.
  if (opts.verifyOnly) {
    const cacheDir = channel === 'qa'
      ? join(process.cwd(), '.tutorial-cache-qa')
      : join(process.cwd(), '.tutorial-cache');

    // 1) Discover slugs from the cache by listing *.md files (NOT from Hugo
    //    output, which the workflow no longer builds).
    let mdFiles: string[];
    try { mdFiles = readdirSync(cacheDir).filter(f => f.endsWith('.md') && !f.startsWith('_')); }
    catch (err) {
      console.error(`Verify failed: cannot read tutorial-cache dir ${cacheDir}: ${formatErrorChain(err)}`);
      process.exit(1);
    }
    const localHashes = new Map<string, string>();
    for (const f of mdFiles) {
      const slug = f.replace(/\.md$/, '');
      const buf = readFileSync(join(cacheDir, f));
      localHashes.set(slug, createHash('sha256').update(buf).digest('hex'));
    }
    log(`Hashed ${localHashes.size} source markdown files in ${cacheDir}`);

    // 2) Fetch server's source-hash map.
    let remote: Record<string, string>;
    try {
      remote = await fetchRemoteSourceHashes({ baseUrl: opts.baseUrl });
    } catch (err) {
      console.error('Verify failed: cannot reach /content/source-hashes:', formatErrorChain(err));
      process.exit(1);
    }
    const serverSlugCount = Object.keys(remote).length;
    log(`Fetched ${serverSlugCount} source hashes from ${opts.baseUrl}/content/source-hashes`);

    // 3) Diff. Only count slugs the server actually KNOWS about — if the
    //    server returned an empty/partial map (e.g. server pre-dates PR
    //    #591 and never wrote source hashes), warn and exit 0. Otherwise
    //    a fresh deploy would always look like 1400 slugs of "drift".
    if (serverSlugCount === 0) {
      console.warn('');
      console.warn('Verify SKIPPED: server returned 0 source hashes.');
      console.warn('  This is expected immediately after PR #591 deploys, before');
      console.warn('  a new publish-content run has populated sourceHash. Re-run');
      console.warn('  this verify after `npm run publish-content` completes.');
      process.exit(0);
    }

    const drifted: string[] = [];
    const missingLocal: string[] = []; // present on server, missing in local cache
    const missingServer: string[] = []; // present locally, no hash on server
    for (const [slug, localHash] of localHashes) {
      const serverHash = remote[slug];
      if (!serverHash) {
        missingServer.push(slug);
        continue;
      }
      if (serverHash !== localHash) drifted.push(slug);
    }
    for (const slug of Object.keys(remote)) {
      if (!localHashes.has(slug)) missingLocal.push(slug);
    }

    console.log('');
    console.log('Verify summary (source-markdown hash compare):');
    console.log(`  Total local source files:        ${localHashes.size}`);
    console.log(`  Total server source hashes:      ${serverSlugCount}`);
    console.log(`  Drifted (content differs):       ${drifted.length}`);
    console.log(`  Missing on server (not yet published / pre-#591): ${missingServer.length}`);
    console.log(`  Missing locally (server has, local doesn't): ${missingLocal.length}`);

    if (drifted.length === 0) {
      console.log('');
      console.log('Verify OK: no source-markdown drift detected.');
      process.exit(0);
    }
    console.error('');
    console.error(`Verify FAILED: ${drifted.length} slug(s) have source-markdown drift:`);
    for (const s of drifted.slice(0, 50).sort()) console.error(`  - ${s}`);
    if (drifted.length > 50) console.error(`  ... (+${drifted.length - 50} more)`);
    process.exit(2);
  }

  // --- --purge-orphans short-circuit ---
  // CI-only batched soft-delete of tutorials whose source markdown is no
  // longer in any upstream repo. Spec:
  //   docs/superpowers/specs/2026-06-30-orphan-purge-design.md
  if (opts.purgeOrphans) {
    // 1. CI-only guard
    if (!process.env.GITHUB_ACTIONS) {
      console.error('purge-orphans is CI-only; run via:');
      console.error('  gh workflow run rebuild-content.yml -f mode=full -f purge-orphans=true');
      process.exit(1);
    }

    // 1b. Validate cap is a positive finite integer — guards against
    //     PURGE_CAP_ABS=fifty or --purge-cap-abs=-1, both of which would
    //     otherwise produce an unhelpful "exceeds cap (N > NaN abs)" later.
    if (!Number.isFinite(opts.purgeCapAbs) || opts.purgeCapAbs <= 0) {
      console.error(`Invalid --purge-cap-abs / PURGE_CAP_ABS: "${process.env.PURGE_CAP_ABS ?? '(unset)'}" — must be a positive integer`);
      process.exit(1);
    }

    // 2. Load local hashes (same readdir as --verify-only)
    const cacheDir = channel === 'qa'
      ? join(process.cwd(), '.tutorial-cache-qa')
      : join(process.cwd(), '.tutorial-cache');
    let mdFiles: string[];
    try { mdFiles = readdirSync(cacheDir).filter(f => f.endsWith('.md') && !f.startsWith('_')); }
    catch (err) {
      console.error(`purge-orphans: cannot read tutorial-cache dir ${cacheDir}: ${formatErrorChain(err)}`);
      process.exit(1);
    }
    const localSlugs = new Set(mdFiles.map(f => f.replace(/\.md$/, '')));
    log(`[purge-orphans] Hashed ${localSlugs.size} local source markdown files in ${cacheDir}`);

    // 3. Fetch /content/source-hashes
    let remote: Record<string, string>;
    try { remote = await fetchRemoteSourceHashes({ baseUrl: opts.baseUrl }); }
    catch (err) {
      console.error('purge-orphans: cannot reach /content/source-hashes:', formatErrorChain(err));
      process.exit(1);
    }
    const serverSlugs = Object.keys(remote);
    log(`[purge-orphans] Fetched ${serverSlugs.length} server slugs`);

    // 4. Compute orphans
    const orphans = computeOrphans(serverSlugs, localSlugs);
    const pctInfo = serverSlugs.length ? ((orphans.length / serverSlugs.length) * 100).toFixed(1) : '0.0';
    log(`[purge-orphans] Computed ${orphans.length} orphans (${pctInfo}% of server — informational)`);

    // 5. Cap check
    const capErr = enforceCap(orphans.length, opts.purgeCapAbs);
    if (capErr) {
      console.error(`[purge-orphans] ${capErr}`);
      console.error(`[purge-orphans] First 20 orphans:`);
      for (const s of orphans.slice(0, 20)) console.error(`  - ${s}`);
      writeStepSummary(formatStepSummary({
        mode: 'failed', serverCount: serverSlugs.length, orphanCount: orphans.length, errorMessage: capErr
      }));
      process.exit(1);
    }
    log(`[purge-orphans] Cap check: ${orphans.length} <= ${opts.purgeCapAbs} abs → passes`);

    // 6. Sample
    const sample = orphans.slice(0, 10).join(', ');
    log(`[purge-orphans] Sample orphans: ${sample}${orphans.length > 10 ? ` ... (+${orphans.length - 10} more)` : ''}`);

    // 7. Dry-run short-circuit
    if (opts.dryRun) {
      log(`[purge-orphans] --dry-run: would have purged ${orphans.length} slug(s); exiting`);
      writeStepSummary(formatStepSummary({
        mode: 'dry-run', serverCount: serverSlugs.length, orphanCount: orphans.length
      }));
      process.exit(0);
    }

    // 8. POST /content/orphan-purge
    const initiator = opts.initiator;
    const purgeUrl = `${opts.baseUrl.replace(/\/$/, '')}/content/orphan-purge`;
    log(`[purge-orphans] POST ${purgeUrl} (${orphans.length} slugs, initiator=${initiator})`);

    let resp: Response;
    try {
      resp = await fetch(purgeUrl, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${process.env.CONTENT_API_KEY ?? ''}`,
          'Content-Type':  'application/json',
          'x-initiator':   initiator
        },
        body: JSON.stringify({ slugs: orphans })
      });
    } catch (err) {
      const msg = `Connectivity error — verify CAP_BASE_URL: ${formatErrorChain(err)}`;
      console.error(`[purge-orphans] ${msg}`);
      writeStepSummary(formatStepSummary({
        mode: 'failed', serverCount: serverSlugs.length, orphanCount: orphans.length, errorMessage: msg
      }));
      process.exit(1);
    }

    // 9. Error handling
    if (!resp.ok) {
      const bodyText = await resp.text();
      let msg: string;
      if (resp.status === 401 || resp.status === 403) {
        msg = `Auth failure — check CONTENT_API_KEY secret for this environment`;
      } else if (resp.status === 400) {
        msg = `Server rejected payload — ${bodyText}`;
      } else if (resp.status >= 500) {
        msg = `Server error — retry once with same INITIATOR; endpoint is idempotent. Body: ${bodyText}`;
      } else {
        msg = `Unexpected status ${resp.status}: ${bodyText}`;
      }
      console.error(`[purge-orphans] ${msg}`);
      writeStepSummary(formatStepSummary({
        mode: 'failed', serverCount: serverSlugs.length, orphanCount: orphans.length, errorMessage: msg
      }));
      process.exit(1);
    }

    // 10. Parse + sanity check
    const result = await resp.json() as {
      purged: string[]; alreadyInactive: string[]; notFound: string[]; redirected: string[];
      totalAttempted: number; totalPurged: number; version: number;
    };
    const bucketSum = result.purged.length + result.alreadyInactive.length + result.notFound.length + result.redirected.length;
    if (bucketSum !== result.totalAttempted) {
      const msg = `Server returned malformed response: bucket sum ${bucketSum} != totalAttempted ${result.totalAttempted}`;
      console.error(`[purge-orphans] ${msg}`);
      writeStepSummary(formatStepSummary({
        mode: 'failed', serverCount: serverSlugs.length, orphanCount: orphans.length, errorMessage: msg
      }));
      process.exit(1);
    }

    // 11. Print summary to stdout
    console.log(`[purge-orphans] Response:`);
    console.log(`  purged:          ${result.purged.length}`);
    console.log(`  alreadyInactive: ${result.alreadyInactive.length}`);
    console.log(`  notFound:        ${result.notFound.length}`);
    if (result.notFound.length > 0) {
      console.log(`    ⚠️  These slugs have no Tutorials parent row (phantom). Operator action required — file one issue per slug:`);
      for (const s of result.notFound) console.log(`      - ${s}`);
    }
    console.log(`  redirected:      ${result.redirected.length}${result.redirected.length ? ` (preserved: ${result.redirected.slice(0, 5).join(', ')})` : ''}`);
    console.log(`  manifest version: ${result.version}`);

    // 12. Step summary
    writeStepSummary(formatStepSummary({
      mode: 'committed',
      serverCount: serverSlugs.length,
      orphanCount: orphans.length,
      purged: result.purged.length,
      alreadyInactive: result.alreadyInactive.length,
      notFound: result.notFound.length,
      redirected: result.redirected.length,
      redirectedSamples: result.redirected,
      version: result.version
    }));

    log(`[purge-orphans] Done — ${result.purged.length} slugs soft-deleted`);
    process.exit(0);
  }

  log(`Discovering tutorials in ${opts.hugoDir}...`);
  const tutorials = discoverTutorials(opts.hugoDir);

  // Drop any stale group-*/mission-* directories left in hugo/public/tutorials
  // by older builds. Catalog pages have been runtime-SSR'd from the DB since
  // PR #115 (#91); shipping them would create phantom Tutorials rows in HANA
  // and leak into the Admin UI Tutorials list (#114). The server enforces the
  // same filter, this is just a nicety so we don't waste a few KB of payload.
  const droppedCatalogSlugs = stripCatalogSlugs(tutorials);
  if (droppedCatalogSlugs.length) {
    console.warn(
      `[publish-content] dropping ${droppedCatalogSlugs.length} stale catalog ` +
      `slug(s) from Hugo output (these are SSR'd from DB, not published): ` +
      droppedCatalogSlugs.slice(0, 10).join(', ') +
      (droppedCatalogSlugs.length > 10 ? ` (+${droppedCatalogSlugs.length - 10} more)` : '')
    );
  }

  // #446 Track 3-A — concept landing pages. Merged into the same map so
  // hash/payload/session orchestration treats them uniformly; the `concept-`
  // prefix on each key is what lets the serve handler route correctly.
  const concepts = discoverConcepts(opts.hugoDir);
  if (concepts.size > 0) {
    for (const [slug, path] of concepts) tutorials.set(slug, path);
    log(`Found ${concepts.size} concept landing page(s) (concept-*) in ${opts.hugoDir}/concepts`);
  }

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

  validateFlagCombo({ force: opts.force, heal: opts.heal, verifyOnly: opts.verifyOnly, purgeOrphans: opts.purgeOrphans });

  log('Computing local hashes...');
  const localHashes = computeLocalHashes(tutorials);

  // --- decide what to publish ---
  let mode: PublishMode = 'delta';
  if (opts.force) mode = 'force';
  else if (opts.heal) mode = 'heal';

  let remoteHashes: Record<string, string> = {};
  if (mode !== 'force') {
    log(`Fetching remote hashes from ${opts.baseUrl}/content/hashes...`);
    try { remoteHashes = await fetchRemoteHashes({ baseUrl: opts.baseUrl }); }
    catch (err) {
      console.error(`Cannot reach ${opts.baseUrl}/content/hashes: ${formatErrorChain(err)}`);
      process.exit(1);
    }
  }

  const planResult = computePublishPlan({ local: localHashes, remote: remoteHashes, mode });
  let targetSlugs = planResult.targetSlugs;

  // #672 — client-side short-circuit. In delta mode only, drop slugs whose
  // upstream state is already in sync with the server's stored state.
  // Detailed rationale + the source-md-only-was-buggy story lives on
  // `applySourceHashShortCircuit`.
  //
  // --force and --heal explicitly skip this layer:
  //   --force: "upload everything regardless of server state"
  //   --heal : "fix slugs the client thinks are in sync"
  if (mode === 'delta' && targetSlugs.length > 0) {
    // `channel` is defined earlier in main() as `const channel = parseChannel(process.argv)`
    // (around line 478) — same value used by the existing verify-only path.
    const cacheDirForHashes = channel === 'qa'
      ? join(process.cwd(), '.tutorial-cache-qa')
      : join(process.cwd(), '.tutorial-cache');
    const localSourceHashes = computeLocalSourceHashes(targetSlugs, cacheDirForHashes);
    let serverSourceHashes: Record<string, string> = {};
    try {
      serverSourceHashes = await fetchRemoteSourceHashes({ baseUrl: opts.baseUrl });
    } catch (err) {
      console.warn(`[publish-content] #672 short-circuit disengaged: cannot reach /content/source-hashes: ${formatErrorChain(err)}`);
    }
    const beforeCount = targetSlugs.length;
    targetSlugs = applySourceHashShortCircuit({
      targetSlugs,
      localSource: localSourceHashes,
      serverSource: serverSourceHashes,
      localHtml: localHashes,
      serverHtml: remoteHashes,
    });
    const dropped = beforeCount - targetSlugs.length;
    if (dropped > 0) log(`#672 short-circuit: dropped ${dropped} of ${beforeCount} slugs (source + html hash both match server)`);
  }
  if (targetSlugs.length === 0) {
    console.log('No changes detected. Nothing to publish.');
    process.exit(0);
  }
  console.log(`${targetSlugs.length} of ${tutorials.size} tutorials to publish (${mode} mode)`);

  if (opts.dryRun) {
    console.log('Dry run — would publish:');
    for (const slug of targetSlugs.slice().sort()) console.log(`  ${slug}`);
    process.exit(0);
  }

  // --- begin / append / commit ---
  log('Building payload + extracting metadata...');
  const startTime = Date.now();
  const payload    = buildPayload(targetSlugs, tutorials);
  const hugoContentDir = join(opts.hugoDir, '..', 'content', 'tutorials');
  // Tutorials-only extractions: metadata, bodyText, branchSpecs, and source
  // markdown all key off Tutorials.slug (or files that only exist for
  // tutorials). Concept slugs (concept-<name>) would silently produce no
  // metadata entries (no .md in hugo/content/tutorials/) but extractAllBodyTexts
  // would happily emit a body-text row keyed `concept-<name>`, orphaning it in
  // TutorialBodyText. Filter them out explicitly so the contract is clear.
  const tutorialOnlySlugs = targetSlugs.filter(s => !isConceptSlug(s));
  const metadataAll = extractMetadata(hugoContentDir, tutorialOnlySlugs);
  const bodyTextsAll = extractAllBodyTexts(tutorials, tutorialOnlySlugs);
  const branchSpecsAll = extractAllBranchSpecs(hugoContentDir, tutorialOnlySlugs);

  // PR #591: capture raw upstream markdown alongside rendered HTML. Each
  // tutorial's source lives at `.tutorial-cache/<slug>.md` (or
  // `.tutorial-cache-qa/<slug>.md` for QA), populated by fetch-tutorials.
  // Special slugs (__shell__, __nav__, __404__) have no upstream source —
  // buildSourcePayload silently skips them, and the server stores null
  // sourceContent/sourceHash for those rows. The drift workflow uses these
  // sourceHashes instead of contentHashes for clean drift detection.
  // Concept slugs are likewise tutorial-only — no upstream .md exists.
  const cacheDir = channel === 'qa'
    ? join(process.cwd(), '.tutorial-cache-qa')
    : join(process.cwd(), '.tutorial-cache');
  const { sources: sourcesAll, sourceHashes: localSourceHashes } =
    buildSourcePayload(tutorialOnlySlugs, cacheDir);
  log(`Source markdown payload: ${Object.keys(sourcesAll).length}/${tutorialOnlySlugs.length} slugs have upstream .md files`);

  // __nav__ / __404__ / __shell__ ride along on the first batch (these are
  // small and the server happily accepts them mixed with regular slugs).
  const sidecarKeys = await collectSidecars(opts.hugoDir, payload, log, channel);

  const begin = await beginSession({
    baseUrl: opts.baseUrl, apiKey: opts.apiKey,
    trigger: opts.trigger, hugoVersion: opts.hugoVersion, expectedSlugCount: targetSlugs.length,
    initiator: opts.initiator,
  });
  log(`Session ${begin.sessionId} version ${begin.version} (expires ${begin.expiresAt})`);

  const allKeys = [...targetSlugs, ...sidecarKeys];
  const batches = chunk(allKeys, opts.batchSize);
  log(`${batches.length} batches × up to ${opts.batchSize} slugs, concurrency=${opts.concurrency}`);

  try {
    await runConcurrent(
      batches.map((batch, idx) => () => withRetry(
        () => appendBatch({
          baseUrl: opts.baseUrl, apiKey: opts.apiKey,
          sessionId: begin.sessionId,
          files:     pickEntries(payload,        batch),
          metadata:  pickEntries(metadataAll,    batch),
          bodyTexts: pickEntries(bodyTextsAll,   batch),
          branchSpecs: pickEntries(branchSpecsAll, batch),
          // Sidecar keys (__shell__ etc.) won't appear in sourcesAll —
          // pickEntries returns {} for them, which the server treats as
          // "no source for this batch" and skips the source-side INSERT.
          sources:   pickEntries(sourcesAll,     batch),
        }),
        {
          attempts: 3, backoffMs: [1000, 3000, 9000],
          onAttemptFail: (attempt, err, willRetry) => {
            console.error(
              `[publish-content] append batch ${idx + 1}/${batches.length} failed (attempt ${attempt}/3)\n  ${formatErrorChain(err)}\n  ${willRetry ? 'retrying...' : 'giving up'}`
            );
          },
        }
      )),
      opts.concurrency
    );
  } catch (err) {
    console.error(`[publish-content] append failed permanently: ${formatErrorChain(err)}`);
    await abortSession({ baseUrl: opts.baseUrl, apiKey: opts.apiKey, sessionId: begin.sessionId, reason: 'append failed' });
    process.exit(1);
  }

  let commit;
  try {
    commit = await withRetry(
      () => commitSession({ baseUrl: opts.baseUrl, apiKey: opts.apiKey, sessionId: begin.sessionId }),
      {
        attempts: 3, backoffMs: [1000, 3000, 9000],
        onAttemptFail: (attempt, err, willRetry) => {
          console.error(`[publish-content] commit failed (attempt ${attempt}/3): ${formatErrorChain(err)}${willRetry ? ' — retrying' : ''}`);
        },
      }
    );
  } catch (err) {
    console.error(`[publish-content] commit failed permanently — manifest left for GC reaper: ${formatErrorChain(err)}`);
    process.exit(1);
  }

  const totalMs = Date.now() - startTime;
  console.log(`Published successfully:
  Version:    ${commit.version}
  Files:      ${commit.fileCount}
  Size:       ${(commit.totalSizeBytes / 1024 / 1024).toFixed(1)} MB
  Server:     ${commit.durationMs} ms
  Total:      ${totalMs} ms
  Idempotent retry hit?  ${commit.alreadyActive}`);

  // --- code-check spec publish (non-fatal auxiliary step) ---
  try {
    const cacheDir = channel === 'qa'
      ? join(process.cwd(), '.tutorial-cache-qa')
      : join(process.cwd(), '.tutorial-cache');
    const specs = collectCodeCheckSpecs(cacheDir);
    if (specs.length) {
      log(`Publishing ${specs.length} code-check spec(s) to /content/code-check-specs`);
      const result = await withRetry(
        () => publishCodeCheckSpecs(opts.baseUrl, opts.apiKey, specs),
        {
          attempts: 3, backoffMs: [1000, 3000],
          onAttemptFail: (attempt, err, willRetry) => {
            console.error(`[publish-content] code-check spec publish failed (attempt ${attempt}/3): ${formatErrorChain(err)}${willRetry ? ' — retrying' : ''}`);
          },
        }
      );
      log(`code-check specs upserted=${result.upserted} skipped=${result.skipped.length}`);
    }
  } catch (err) {
    console.error('[publish-content] code-check spec publish failed (non-fatal):', formatErrorChain(err));
    // Do NOT exit non-zero — content publish is the critical path; specs are auxiliary.
  }

  // --- validate-answer spec publish (non-fatal auxiliary step, issue #209 Task 9) ---
  try {
    const cacheDir = channel === 'qa'
      ? join(process.cwd(), '.tutorial-cache-qa')
      : join(process.cwd(), '.tutorial-cache');
    const veResult = await publishValidateAnswerSpecs({
      cacheDir,
      baseUrl: opts.baseUrl,
      apiKey: opts.apiKey,
    });
    log(`[validate-answer] published ${veResult.published} specs, ${veResult.failures.length} failures`);
    for (const f of veResult.failures) {
      console.warn(`[validate-answer]   - ${f.slug}: ${f.status} ${f.body.slice(0, 200)}`);
    }
    // Don't process.exit(1) on failures — non-fatal per spec.
  } catch (err) {
    console.error('[publish-content] validate-answer spec publish failed (non-fatal):', formatErrorChain(err));
  }

  // --- auto-verify ---
  log('Verifying server state matches local...');
  let postRemote: Record<string, string>;
  try { postRemote = await fetchRemoteHashes({ baseUrl: opts.baseUrl }); }
  catch (err) {
    console.error(`Auto-verify warning: cannot reach /content/hashes after commit: ${formatErrorChain(err)}`);
    process.exit(0); // commit was successful; don't punish for a transient verify-fetch error
  }
  const verifyDiff = computeDiff(localHashes, postRemote);
  if (verifyDiff.length === 0) {
    console.log(`Verify OK: ${localHashes.size} slugs match server.`);
    process.exit(0);
  }
  console.error(`Verify FAILED: commit reported success but ${verifyDiff.length} slugs still differ:`);
  for (const s of verifyDiff.slice(0, 50).sort()) console.error(`  - ${s}`);
  process.exit(2);
}

// Run CLI when executed directly
const isMain = process.argv[1]?.includes('publish-content');
if (isMain) {
  main().catch(err => {
    console.error('Fatal:', err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
