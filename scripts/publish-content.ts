import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { parse as parseYaml } from 'yaml';
import { parseChannel, type Channel } from './fetch-tutorials.js';
import { beginSession, appendBatch, commitSession, abortSession, fetchRemoteHashes } from './lib/publish-client.js';
import { withRetry, formatErrorChain } from './lib/publish-retry.js';
import { chunk, runConcurrent } from './lib/publish-batcher.js';
import { collectCodeCheckSpecs, publishCodeCheckSpecs } from './lib/publish-codecheck.js';
import { publishValidateAnswerSpecs } from './lib/publish-validate-answer.js';

export type { Channel };

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

export function validateFlagCombo(flags: { force: boolean; heal: boolean; verifyOnly: boolean }) {
  const modes = [flags.force && 'force', flags.heal && 'heal', flags.verifyOnly && 'verify-only'].filter(Boolean);
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

interface PublishOptions {
  hugoDir: string;
  baseUrl: string;
  apiKey: string;
  trigger: string;
  hugoVersion: string;
  dryRun: boolean;
  force: boolean;
  heal: boolean;
  verifyOnly: boolean;
  verbose: boolean;
  concurrency: number;
  batchSize: number;
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
    dryRun:    has('--dry-run'),
    force:     has('--force'),
    heal:      has('--heal'),
    verifyOnly: has('--verify-only'),
    verbose:   has('--verbose'),
    concurrency: parseInt(get('--concurrency', '6'), 10),
    batchSize:   parseInt(get('--batch-size', '50'), 10),
  };
}

function pickEntries<T>(src: Record<string, T>, keys: string[]): Record<string, T> {
  const out: Record<string, T> = {};
  for (const k of keys) if (k in src) out[k] = src[k];
  return out;
}

async function collectSidecars(hugoDir: string, payload: Record<string, string>, log: (s: string) => void): Promise<string[]> {
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

  if (!opts.apiKey) {
    const envHint = channel === 'qa' ? 'CONTENT_API_KEY_QA' : 'CONTENT_API_KEY';
    console.error(`Error: No API key. Set ${envHint} env var or pass --api-key`);
    process.exit(1);
  }

  const log = opts.verbose ? console.log : () => {};

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

  validateFlagCombo({ force: opts.force, heal: opts.heal, verifyOnly: opts.verifyOnly });

  log('Computing local hashes...');
  const localHashes = computeLocalHashes(tutorials);

  // --- verify-only short-circuit ---
  if (opts.verifyOnly) {
    let remote: Record<string, string>;
    try {
      remote = await fetchRemoteHashes({ baseUrl: opts.baseUrl });
    } catch (err) {
      console.error('Verify failed: cannot reach /content/hashes:', formatErrorChain(err));
      process.exit(1);
    }
    const diff = computeDiff(localHashes, remote);
    if (diff.length === 0) {
      console.log(`Verify OK: ${localHashes.size} slugs match server.`);
      process.exit(0);
    }
    console.error(`Verify FAILED: ${diff.length} slugs differ:`);
    for (const s of diff.slice(0, 50).sort()) console.error(`  - ${s}`);
    if (diff.length > 50) console.error(`  ... (+${diff.length - 50} more)`);
    process.exit(2);
  }

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

  const { targetSlugs } = computePublishPlan({ local: localHashes, remote: remoteHashes, mode });
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
  const metadataAll = extractMetadata(hugoContentDir, targetSlugs);
  const bodyTextsAll = extractAllBodyTexts(tutorials, targetSlugs);
  const branchSpecsAll = extractAllBranchSpecs(hugoContentDir, targetSlugs);

  // __nav__ / __404__ / __shell__ ride along on the first batch (these are
  // small and the server happily accepts them mixed with regular slugs).
  const sidecarKeys = await collectSidecars(opts.hugoDir, payload, log);

  const begin = await beginSession({
    baseUrl: opts.baseUrl, apiKey: opts.apiKey,
    trigger: opts.trigger, hugoVersion: opts.hugoVersion, expectedSlugCount: targetSlugs.length,
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
