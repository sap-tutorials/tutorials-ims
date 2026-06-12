import { describe, it, expect, vi } from 'vitest';
import { branchStalenessRule, prefetchBranchStaleness, type BranchStalenessCache } from '../branch-staleness';

describe('branchStalenessRule (sync, cache-driven)', () => {
  // Helper: build a BranchStalenessCache shaped like prefetchBranchStaleness's output.
  function buildCache(slug: string, perf: any[], top: any[]): BranchStalenessCache {
    return new Map([[slug, { perf, top }]]);
  }

  it('skips silently when the cache has no entry for the slug (offline / no data)', () => {
    const findings = branchStalenessRule({
      slug: 't1',
      branches: [{ tutorialSlug: 't1', branchPointId: 'b1', beginLine: 12 }],
      cache: new Map(),  // empty cache (e.g. prefetch silently failed)
    });
    expect(findings).toEqual([]);
  });

  it('skips silently when branches[] is empty', () => {
    const cache = buildCache('t1', [
      { missionSlug: null, tutorialSlug: 't1', branchPointId: 'b1', surface: 'tutorialBranch',
        total: 100, byCondition: 100, byRanker: 0, byDefault: 0, clickedTotal: 50, followed: 50,
        avgConfidence: 1, bySrcJouleTool: 0, bySrcPageLoad: 100, bySrcClick: 0,
        firstSeenAt: new Date(Date.now() - 60 * 86400000).toISOString() },
    ], [
      { missionSlug: null, tutorialSlug: 't1', branchPointId: 'b1', surface: 'tutorialBranch',
        recommendedKey: 'hana', pickedCount: 100 },
    ]);
    const findings = branchStalenessRule({ slug: 't1', branches: [], cache });
    expect(findings).toEqual([]);  // can't cite a line if the markdown has no branches
  });

  it('emits no findings when total < 50', () => {
    const cache = buildCache('t1', [
      { missionSlug: null, tutorialSlug: 't1', branchPointId: 'b1', surface: 'tutorialBranch',
        total: 10, byCondition: 10, byRanker: 0, byDefault: 0, clickedTotal: 0, followed: 0,
        avgConfidence: 1, bySrcJouleTool: 0, bySrcPageLoad: 10, bySrcClick: 0,
        firstSeenAt: new Date(Date.now() - 60 * 86400000).toISOString() },
    ], [
      { missionSlug: null, tutorialSlug: 't1', branchPointId: 'b1', surface: 'tutorialBranch',
        recommendedKey: 'hana', pickedCount: 10 },
    ]);
    const findings = branchStalenessRule({
      slug: 't1',
      branches: [{ tutorialSlug: 't1', branchPointId: 'b1', beginLine: 12 }],
      cache,
    });
    expect(findings).toEqual([]);
  });

  it('emits no findings when firstSeenAt < 30 days ago', () => {
    const cache = buildCache('t1', [
      { missionSlug: null, tutorialSlug: 't1', branchPointId: 'b1', surface: 'tutorialBranch',
        total: 100, byCondition: 100, byRanker: 0, byDefault: 0, clickedTotal: 0, followed: 0,
        avgConfidence: 1, bySrcJouleTool: 0, bySrcPageLoad: 100, bySrcClick: 0,
        firstSeenAt: new Date(Date.now() - 5 * 86400000).toISOString() },
    ], [
      { missionSlug: null, tutorialSlug: 't1', branchPointId: 'b1', surface: 'tutorialBranch',
        recommendedKey: 'hana', pickedCount: 100 },
    ]);
    const findings = branchStalenessRule({
      slug: 't1',
      branches: [{ tutorialSlug: 't1', branchPointId: 'b1', beginLine: 12 }],
      cache,
    });
    expect(findings).toEqual([]);
  });

  it('emits a notice when total ≥ 50, age ≥ 30 days, and one branch ≥ 95%', () => {
    const cache = buildCache('t1', [
      { missionSlug: null, tutorialSlug: 't1', branchPointId: 'b1', surface: 'tutorialBranch',
        total: 100, byCondition: 100, byRanker: 0, byDefault: 0, clickedTotal: 50, followed: 50,
        avgConfidence: 1, bySrcJouleTool: 0, bySrcPageLoad: 100, bySrcClick: 0,
        firstSeenAt: new Date(Date.now() - 60 * 86400000).toISOString() },
    ], [
      { missionSlug: null, tutorialSlug: 't1', branchPointId: 'b1', surface: 'tutorialBranch',
        recommendedKey: 'hana',     pickedCount: 96 },
      { missionSlug: null, tutorialSlug: 't1', branchPointId: 'b1', surface: 'tutorialBranch',
        recommendedKey: 'postgres', pickedCount: 4 },
    ]);
    const findings = branchStalenessRule({
      slug: 't1',
      branches: [{ tutorialSlug: 't1', branchPointId: 'b1', beginLine: 42 }],
      cache,
    });
    expect(findings).toHaveLength(1);
    // Must conform to existing LintFinding shape (per recon: rule/slug/file/line/message/excerpt/severity).
    expect(findings[0]).toMatchObject({
      severity: 'notice',
      rule: 'branch-staleness',
      slug: 't1',
      file: 't1.md',
      line: 42,
    });
    expect(findings[0].message).toMatch(/96%|hana/);
    expect(typeof findings[0].excerpt).toBe('string');
  });

  it('emits no findings when share is exactly 95% (strict > threshold)', () => {
    const cache = buildCache('t1', [
      { missionSlug: null, tutorialSlug: 't1', branchPointId: 'b1', surface: 'tutorialBranch',
        total: 100, byCondition: 100, byRanker: 0, byDefault: 0, clickedTotal: 50, followed: 50,
        avgConfidence: 1, bySrcJouleTool: 0, bySrcPageLoad: 100, bySrcClick: 0,
        firstSeenAt: new Date(Date.now() - 60 * 86400000).toISOString() },
    ], [
      { missionSlug: null, tutorialSlug: 't1', branchPointId: 'b1', surface: 'tutorialBranch',
        recommendedKey: 'hana',     pickedCount: 95 },
      { missionSlug: null, tutorialSlug: 't1', branchPointId: 'b1', surface: 'tutorialBranch',
        recommendedKey: 'postgres', pickedCount: 5  },
    ]);
    const findings = branchStalenessRule({
      slug: 't1',
      branches: [{ tutorialSlug: 't1', branchPointId: 'b1', beginLine: 42 }],
      cache,
    });
    expect(findings).toEqual([]);
  });

  it('skips silently when the cache entry has no perf/top rows for this branch', () => {
    // E.g. branch is in markdown but no telemetry yet (cold start, never rendered).
    const cache = buildCache('t1', [], []);
    const findings = branchStalenessRule({
      slug: 't1',
      branches: [{ tutorialSlug: 't1', branchPointId: 'b1', beginLine: 12 }],
      cache,
    });
    expect(findings).toEqual([]);
  });
});

describe('prefetchBranchStaleness (async, bulk fetch)', () => {
  function mockFetch(rows: { perf: any[]; top: any[] }) {
    return vi.fn(async (url: string) => ({
      ok: true,
      json: async () => ({
        value: url.includes('TopPick') ? rows.top : rows.perf,
      }),
    } as any));
  }

  it('returns empty cache when token is missing (offline CI)', async () => {
    const fetchMock = mockFetch({ perf: [], top: [] });
    const cache = await prefetchBranchStaleness({
      slugs: ['t1', 't2'],
      env: { TUTORIAL_AUTHOR_TOKEN: undefined, ANALYTICS_BASE_URL: 'https://example' },
      fetch: fetchMock,
    });
    expect(cache.size).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();  // offline guard short-circuits before any I/O
  });

  it('returns empty cache when fetch throws (network error / 401 / 5xx)', async () => {
    const cache = await prefetchBranchStaleness({
      slugs: ['t1'],
      env: { TUTORIAL_AUTHOR_TOKEN: 'tok', ANALYTICS_BASE_URL: 'https://example' },
      fetch: vi.fn(async () => { throw new Error('network down'); }) as any,
    });
    expect(cache.size).toBe(0);
  });

  it('never logs the bearer token via console (regardless of fetch outcome)', async () => {
    const SECRET = 'SECRET-TOKEN-XYZ';
    const logSpy   = vi.spyOn(console, 'log').mockImplementation(() => {});
    const warnSpy  = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    // Run twice: once with 5xx, once with throw — neither path may surface the secret.
    await prefetchBranchStaleness({
      slugs: ['t1'],
      env: { TUTORIAL_AUTHOR_TOKEN: SECRET, ANALYTICS_BASE_URL: 'https://example' },
      fetch: vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) } as any)),
    });
    await prefetchBranchStaleness({
      slugs: ['t1'],
      env: { TUTORIAL_AUTHOR_TOKEN: SECRET, ANALYTICS_BASE_URL: 'https://example' },
      fetch: vi.fn(async () => { throw new Error('boom'); }),
    });

    const allCalls = [
      ...logSpy.mock.calls,
      ...warnSpy.mock.calls,
      ...errorSpy.mock.calls,
    ].map(args => args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ')).join('\n');

    expect(allCalls).not.toContain(SECRET);
    expect(allCalls).not.toMatch(/Bearer/);

    // Positive assertion (B-NEW-3 round-4 fix): on the 5xx path the prefetch
    // MUST surface the status code via console.warn so a misconfigured
    // ANALYTICS_BASE_URL is visible in CI logs. Status codes are not secret
    // material — passes the leak audit above.
    const warnCalls = warnSpy.mock.calls.map(args =>
      args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ')
    ).join('\n');
    expect(warnCalls).toMatch(/500/);              // status from the 5xx mock
    expect(warnCalls).toMatch(/branch-staleness/); // identifies the rule

    logSpy.mockRestore();
    warnSpy.mockRestore();
    errorSpy.mockRestore();
  });

  // Runner-integration smoke test (subtask 6f). Catches drift between
  // BranchGroup field names (parser output) and BranchInput field names
  // (rule input) — the original v1 of this rule consumed `g.branchPointId`
  // which doesn't exist on BranchGroup (the field is `g.id`). This test
  // builds a synthetic markdown body, runs the REAL parser, runs the prefetch
  // against a mock backend, then feeds REAL parser output → sync rule using
  // the prefetched cache. If the integration mapping drifts, this test fails
  // loudly because `cache.get(slug)` finds rows with `branchPointId: '1-deployment'`
  // but `branches[].branchPointId` would be `undefined` and never match.
  it('integrates with extractBranchGroups + prefetchBranchStaleness end-to-end', async () => {
    const { extractBranchGroups } = await import('../../parsers/branches');
    const body = [
      '### Step 1',                                        // line 1
      '',
      '[BRANCH_BEGIN group="deployment" key="hana" label="HANA"]',  // line 3
      '### sub-a',
      '[BRANCH_END]',
      '[BRANCH_BEGIN group="deployment" key="postgres" label="PostgreSQL"]',
      '### sub-b',
      '[BRANCH_END]',
    ].join('\n');
    const { branchGroups } = extractBranchGroups(body, 't1');
    expect(branchGroups).toHaveLength(1);

    // The integration MUST map g.id (the BranchGroup field) → branchPointId
    // (the BranchInput field). NOT g.branchPointId (which doesn't exist).
    const branches = branchGroups.map(g => ({
      tutorialSlug: 't1',
      branchPointId: g.id,
      beginLine: g.beginLine,
    }));
    expect(branches[0].branchPointId).toBe('1-deployment');  // ${parentStepNumber}-${groupKey}
    expect(branches[0].beginLine).toBe(3);

    // Prefetch returns rows for the same branchPointId.
    const cache = await prefetchBranchStaleness({
      slugs: ['t1'],
      env: { TUTORIAL_AUTHOR_TOKEN: 'tok', ANALYTICS_BASE_URL: 'https://example' },
      fetch: mockFetch({
        perf: [{ missionSlug: null, tutorialSlug: 't1', branchPointId: '1-deployment', surface: 'tutorialBranch',
                 total: 100, byCondition: 100, byRanker: 0, byDefault: 0, clickedTotal: 50, followed: 50,
                 avgConfidence: 1, bySrcJouleTool: 0, bySrcPageLoad: 100, bySrcClick: 0,
                 firstSeenAt: new Date(Date.now() - 60 * 86400000).toISOString() }],
        top:  [{ missionSlug: null, tutorialSlug: 't1', branchPointId: '1-deployment', surface: 'tutorialBranch',
                 recommendedKey: 'hana',     pickedCount: 96 },
               { missionSlug: null, tutorialSlug: 't1', branchPointId: '1-deployment', surface: 'tutorialBranch',
                 recommendedKey: 'postgres', pickedCount: 4 }],
      }),
    });

    const findings = branchStalenessRule({ slug: 't1', branches, cache });
    expect(findings).toHaveLength(1);
    expect(findings[0].line).toBe(3);  // citation lands on the [BRANCH_BEGIN] line, not the # heading
    expect(findings[0].rule).toBe('branch-staleness');
  });
});
