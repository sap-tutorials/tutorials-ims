import { describe, it, expect } from 'vitest';
import { buildQueries, shapeResults, formatMarkdown } from '../../scripts/lib/codecheck-eval/telemetry.js';

describe('buildQueries', () => {
  it('emits five named queries with the same single-element params (sinceIso)', () => {
    const q = buildQueries('2026-06-08T00:00:00Z');
    const names = ['verdictDistribution', 'latency', 'tokens', 'errors', 'perStepCoverage'];
    for (const n of names) {
      expect(q[n]).toBeDefined();
      expect(typeof q[n].sql).toBe('string');
      expect(q[n].sql.length).toBeGreaterThan(0);
      expect(q[n].params).toEqual(['2026-06-08T00:00:00Z']);
    }
  });

  it('latency query references PERCENTILE_CONT (HANA-only)', () => {
    expect(buildQueries('x').latency.sql).toMatch(/PERCENTILE_CONT/);
  });

  it('errors query filters by verdict = error (lowercase, source-faithful)', () => {
    const sql = buildQueries('x').errors.sql;
    expect(sql).toMatch(/verdict\s*=\s*'error'/i);
  });
});

describe('shapeResults', () => {
  it('builds the canonical JSON output object', () => {
    const raw = {
      verdictDistribution: [{ VERDICT: 'pass', N: 24 }, { VERDICT: 'partial', N: 12 }],
      latency: [{ P_MIN: 340, P50: 1240, P95: 2890, P99: 3410, P_MAX: 3520 }],
      tokens: [{ AVG_PROMPT: 612, AVG_COMPLETION: 188, TOTAL_TOKENS: 24000, N_WITH_TOKENS: 30 }],
      errors: [{ ERRORREASON: 'upstream', N: 1 }],
      perStepCoverage: [{ TUTORIALSLUG: 's', STEPNUMBER: 3, VERDICT: 'pass', N: 10 }],
    };
    const out = shapeResults(raw, '2026-06-08T00:00:00Z');
    expect(out.since).toBe('2026-06-08T00:00:00Z');
    expect(out.verdictDistribution).toHaveLength(2);
    expect(out.verdictDistribution[0]).toEqual({ verdict: 'pass', n: 24 });
    expect(out.latency.p95).toBe(2890);
    expect(out.tokens.avg_prompt).toBe(612);
    expect(out.errors[0].errorReason).toBe('upstream');
    expect(out.perStepCoverage[0].stepNumber).toBe(3);
  });

  it('handles empty result arrays without crashing', () => {
    const out = shapeResults({
      verdictDistribution: [], latency: [], tokens: [], errors: [], perStepCoverage: [],
    }, 'x');
    expect(out.verdictDistribution).toEqual([]);
    expect(out.latency).toEqual({ p_min: null, p50: null, p95: null, p99: null, p_max: null });
    expect(out.tokens).toEqual({ avg_prompt: null, avg_completion: null, total_tokens: null, n_with_tokens: 0 });
  });
});

describe('formatMarkdown', () => {
  it('renders verdict mix and latency rows even with zero rows', () => {
    const md = formatMarkdown({
      since: '2026-06-08T00:00:00Z',
      verdictDistribution: [], latency: { p_min: null, p50: null, p95: null, p99: null, p_max: null },
      tokens: { avg_prompt: null, avg_completion: null, total_tokens: null, n_with_tokens: 0 },
      errors: [], perStepCoverage: [],
    });
    expect(md).toMatch(/since/i);
    expect(md).toMatch(/Verdict/);
  });
});
