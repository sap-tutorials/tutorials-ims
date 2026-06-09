import { describe, it, expect, vi } from 'vitest';
import { pickBranch, evaluateSkip } from '../../../srv/lib/branch/engine.js';

const STATE_CLOUD = Object.freeze({
  completedSlugs: new Set(['hana-intro']),
  completedMissionSlugs: new Set(),
  profile: Object.freeze({ deployment: 'cloud', role: 'developer', cloud: 'btp' })
});

const ANON = Object.freeze({
  completedSlugs: new Set(),
  completedMissionSlugs: new Set(),
  profile: Object.freeze({ deployment: null, role: null, cloud: null })
});

const NULL_RANKER = async () => [];

describe('pickBranch — author conditions', () => {
  it('first matching condition wins (declaration order)', async () => {
    const bp = {
      id: 'bp1', surface: 'tutorialBranch',
      branches: [
        { key: 'hana',     condition: "profile.deployment == 'cloud'" },
        { key: 'postgres', condition: null },
      ],
    };
    const out = await pickBranch(bp, STATE_CLOUD, {}, { rankBranches: NULL_RANKER });
    expect(out.picked).toBe('hana');
    expect(out.reason.kind).toBe('condition');
    expect(out.confidence).toBe(1.0);
  });

  it('skips conditions that evaluate false', async () => {
    const bp = {
      id: 'bp2', surface: 'tutorialBranch',
      branches: [
        { key: 'onprem',   condition: "profile.deployment == 'onprem'" },
        { key: 'cloud',    condition: "profile.deployment == 'cloud'" },
      ],
    };
    const out = await pickBranch(bp, STATE_CLOUD, {}, { rankBranches: NULL_RANKER });
    expect(out.picked).toBe('cloud');
  });
});

describe('pickBranch — ranker fallback', () => {
  it('uses ranker when no condition matches', async () => {
    const bp = {
      id: 'bp3', surface: 'tutorialBranch',
      branches: [
        { key: 'a', condition: null, embeddingHint: 'tut-a' },
        { key: 'b', condition: null, embeddingHint: 'tut-b' },
      ],
    };
    const ranker = async () => [{ key: 'b', score: 0.8 }, { key: 'a', score: 0.3 }];
    const out = await pickBranch(bp, STATE_CLOUD, {}, { rankBranches: ranker });
    expect(out.picked).toBe('b');
    expect(out.reason.kind).toBe('ranker');
    expect(out.confidence).toBe(0.8);
  });

  it('ignores low-confidence ranker output (< 0.05) and returns default', async () => {
    const bp = {
      id: 'bp4', surface: 'tutorialBranch',
      branches: [
        { key: 'a', condition: null, embeddingHint: 'tut-a' },
        { key: 'b', condition: null, embeddingHint: 'tut-b' },
      ],
    };
    const ranker = async () => [{ key: 'b', score: 0.01 }, { key: 'a', score: 0.005 }];
    const out = await pickBranch(bp, STATE_CLOUD, {}, { rankBranches: ranker });
    expect(out.picked).toBe('a');
    expect(out.reason.kind).toBe('default');
    expect(out.confidence).toBe(0);
  });

  it('skips ranker entirely when no embeddingHint is present on any branch', async () => {
    const bp = {
      id: 'bp5', surface: 'tutorialBranch',
      branches: [
        { key: 'a', condition: null },
        { key: 'b', condition: null },
      ],
    };
    const rankerCalled = vi.fn();
    await pickBranch(bp, STATE_CLOUD, {}, { rankBranches: rankerCalled });
    expect(rankerCalled).not.toHaveBeenCalled();
  });
});

describe('pickBranch — anonymous user', () => {
  it('falls back to deterministic default when no condition matches and no ranker hits', async () => {
    const bp = {
      id: 'bp6', surface: 'missionAltGroup',
      branches: [
        { key: 'cloud',  condition: "profile.deployment == 'cloud'" },
        { key: 'onprem', condition: "profile.deployment == 'onprem'" },
      ],
    };
    const out = await pickBranch(bp, ANON, {}, { rankBranches: NULL_RANKER });
    expect(out.picked).toBe('cloud');
    expect(out.reason.kind).toBe('default');
  });
});

describe('pickBranch — failure mode', () => {
  it('on engine throw inside ranker, returns deterministic default and logs', async () => {
    const bp = {
      id: 'bp7', surface: 'tutorialBranch',
      branches: [
        { key: 'a', condition: null, embeddingHint: 'tut-a' },
        { key: 'b', condition: null, embeddingHint: 'tut-b' },
      ],
    };
    const broken = async () => { throw new Error('embedding service down'); };
    const out = await pickBranch(bp, STATE_CLOUD, {}, { rankBranches: broken });
    expect(out.picked).toBe('a');
    expect(out.reason.kind).toBe('default');
  });
});

describe('evaluateSkip', () => {
  it('returns skip:true when condition is true', () => {
    const out = evaluateSkip('completed:hana-intro', STATE_CLOUD);
    expect(out.skip).toBe(true);
    expect(out.reason.kind).toBe('condition');
  });
  it('returns skip:false when condition is false', () => {
    const out = evaluateSkip('completed:never-completed', STATE_CLOUD);
    expect(out.skip).toBe(false);
  });
  it('returns skip:false on parse error (logs and degrades)', () => {
    const out = evaluateSkip('this is not valid', STATE_CLOUD);
    expect(out.skip).toBe(false);
  });
});

describe('pickBranch — no-LLM guarantee', () => {
  it('does not call fetch (proxy for LLM HTTP calls)', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
      throw new Error('fetch should not be called');
    });
    try {
      const bp = {
        id: 'bp-nollm', surface: 'tutorialBranch',
        branches: [
          { key: 'a', condition: "profile.deployment == 'cloud'" },
          { key: 'b', condition: null },
        ],
      };
      await pickBranch(bp, STATE_CLOUD, {}, { rankBranches: NULL_RANKER });
      const aiCalls = fetchSpy.mock.calls.filter(([url]) =>
        typeof url === 'string' && /openai|aicore|anthropic/i.test(url));
      expect(aiCalls).toHaveLength(0);
    } finally {
      fetchSpy.mockRestore();
    }
  });
});
