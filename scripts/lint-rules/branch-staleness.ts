// Issue #172 PR 5 — branch staleness lint rule.
// Read-only over AuthorService with Tutorial.Author scope (see srv/author-service.cds).
// AnalyticsService is Admin-only and unsuitable for this consumer.
// Spec: §4.4 (rule), §4.4.1 (auth), §9.5 (master-spec hook).
//
// Triggers when:
//   - total ≥ 50 (denominator floor — avoid noise on cold starts)
//   - firstSeenAt ≥ 30 days ago
//   - one recommendedKey share strictly > 95%
//
// Severity: notice (non-blocking — author judgment, not a build failure).
//
// Finding shape conforms to the existing LintFinding type in
// scripts/lint-tutorial-markdown.ts (per recon: rule/slug/file/line/
// message/excerpt/severity). The new `notice` value widens the existing
// LintSeverity union from `'error' | 'warning'` to
// `'error' | 'warning' | 'notice'` — see Task 8 Step 6d for the runner-
// side audit that confirms every consumer handles it.

import { mergeBranchPerf, BranchPerfRow, BranchTopPickRow } from '../lib/merge-branch-perf';

export interface BranchInput {
  tutorialSlug: string;
  branchPointId: string;
  beginLine: number;
}

// Conforms to scripts/lint-tutorial-markdown.ts `LintFinding` (per recon).
// Severity is widened from `'error' | 'warning'` to include `'notice'`;
// the new value is added to the `LintSeverity` union in the runner.
export interface LintFinding {
  rule: string;
  slug: string;
  file: string;
  line: number;
  message: string;
  excerpt: string;
  severity: 'error' | 'warning' | 'notice';
}

const MIN_TOTAL = 50;
const MIN_AGE_DAYS = 30;
const SHARE_THRESHOLD = 0.95;
const MS_PER_DAY = 86400000;

// Sync-runner pivot (round 3): the only async surface is `prefetchBranchStaleness`
// — one bulk call before the per-file lint loop. The rule itself is sync and
// consumes the prefetched cache, so `lintTutorial`/`branchSyntaxRule`/`RULES[]`
// stay completely unchanged. See Step 6 for the integration shape.

export interface BranchStalenessCacheEntry {
  perf: BranchPerfRow[];
  top: BranchTopPickRow[];
}
export type BranchStalenessCache = Map<string, BranchStalenessCacheEntry>;

export interface PrefetchOpts {
  slugs: string[];
  env: { TUTORIAL_AUTHOR_TOKEN: string | undefined; ANALYTICS_BASE_URL: string | undefined };
  fetch: typeof globalThis.fetch;
}

export async function prefetchBranchStaleness(opts: PrefetchOpts): Promise<BranchStalenessCache> {
  const { slugs, env, fetch } = opts;
  const cache: BranchStalenessCache = new Map();
  if (!env.TUTORIAL_AUTHOR_TOKEN || !env.ANALYTICS_BASE_URL) return cache;  // offline / unconfigured
  if (slugs.length === 0) return cache;

  const headers = {
    Authorization: `Bearer ${env.TUTORIAL_AUTHOR_TOKEN}`,
    Accept: 'application/json',
  };
  // Single bulk fetch: ALL surfaces (skip-points + branches) are pulled here.
  // The rule body filters surface=tutorialBranch — keeping the surface decision
  // inside the rule (not at the fetch URL) means a future surface-broadening
  // change touches the rule, not the prefetch.
  // We do NOT filter by slug at the URL level — fetching all-time for ALL slugs in one
  // round-trip is cheaper than N round-trips, and the prod row count is small enough
  // (one row per (mission, tutorial, branchPoint, surface) tuple).
  const perfUrl = `${env.ANALYTICS_BASE_URL}/AnalyticsBranchPerformance?$top=5000`;
  const topUrl  = `${env.ANALYTICS_BASE_URL}/AnalyticsBranchTopPick?$top=10000`;
  // ANALYTICS_BASE_URL is the AuthorService base (e.g. https://.../author). DO NOT
  // point this at /admin/analytics — that surface is Admin-only and a Tutorial.Author
  // token will 403.

  let perf: BranchPerfRow[] = [];
  let top: BranchTopPickRow[] = [];
  try {
    const [perfRes, topRes] = await Promise.all([fetch(perfUrl, { headers }), fetch(topUrl, { headers })]);
    if (!perfRes.ok || !topRes.ok) {
      // Surface the status code (NOT URL/token) so a misconfigured
      // ANALYTICS_BASE_URL (e.g. pointed at /admin/analytics) is visible in CI
      // logs instead of silently degrading to a no-op for the whole run.
      // Status codes are not secret material — pass the console-leak audit.
      console.warn(`branch-staleness: prefetch returned ${perfRes.status}/${topRes.status}; rule will skip. Verify ANALYTICS_BASE_URL points at /author and the token has Tutorial.Author scope.`);
      return cache;  // 401, 5xx → skip (with diagnostic)
    }
    const [pj, tj] = await Promise.all([perfRes.json(), topRes.json()]);
    perf = pj.value || [];
    top  = tj.value || [];
  } catch {
    return cache;  // network error → silent skip
  }

  // Bucket by tutorialSlug so the per-file rule does an O(1) Map lookup.
  const slugSet = new Set(slugs);
  for (const r of perf) {
    if (!slugSet.has(r.tutorialSlug)) continue;
    const entry = cache.get(r.tutorialSlug) || { perf: [], top: [] };
    entry.perf.push(r);
    cache.set(r.tutorialSlug, entry);
  }
  for (const r of top) {
    if (!slugSet.has(r.tutorialSlug)) continue;
    const entry = cache.get(r.tutorialSlug) || { perf: [], top: [] };
    entry.top.push(r);
    cache.set(r.tutorialSlug, entry);
  }
  return cache;
}

export interface BranchStalenessOpts {
  slug: string;
  branches: BranchInput[];
  cache: BranchStalenessCache;
}

// SYNC. Looks up cache.get(slug); if absent (offline / no data for this slug),
// returns []. If parse error: caller should not invoke us — we trust `branches`
// is a valid lint-input shape, derived in main() from `extractBranchGroups`.
export function branchStalenessRule(opts: BranchStalenessOpts): LintFinding[] {
  const { slug, branches, cache } = opts;
  if (branches.length === 0) return [];
  const entry = cache.get(slug);
  if (!entry) return [];  // offline-skip / no-data-for-this-slug

  const merged = mergeBranchPerf(entry.perf, entry.top);
  const cutoff = Date.now() - MIN_AGE_DAYS * MS_PER_DAY;
  const findings: LintFinding[] = [];

  for (const row of merged) {
    if (row.surface !== 'tutorialBranch') continue;  // skip-points are out of scope for staleness
    if (row.total < MIN_TOTAL) continue;
    if (!row.firstSeenAt) continue;
    const seenMs = Date.parse(row.firstSeenAt);
    if (Number.isNaN(seenMs) || seenMs > cutoff) continue;
    if (row.pickedKeyTopShare === null) continue;
    if (row.pickedKeyTopShare <= SHARE_THRESHOLD) continue;

    const branch = branches.find(b => b.branchPointId === row.branchPointId && b.tutorialSlug === row.tutorialSlug);
    if (!branch) continue;  // markdown ↔ telemetry drift; don't blind-cite a line

    const sharePct = (row.pickedKeyTopShare * 100).toFixed(0);
    findings.push({
      rule: 'branch-staleness',
      slug,
      file: `${slug}.md`,
      line: branch.beginLine,
      message: `Branch "${row.branchPointId}" has been live ≥${MIN_AGE_DAYS}d with "${row.pickedKeyTop}" picked ${sharePct}% of ${row.total} decisions. Consider whether the branch still earns its keep.`,
      excerpt: `[BRANCH_BEGIN group="${row.branchPointId}" ...]`,
      severity: 'notice',
    });
  }
  return findings;
}
