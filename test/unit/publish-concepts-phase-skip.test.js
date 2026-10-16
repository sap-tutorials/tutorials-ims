import { describe, it, expect, vi } from 'vitest';
import { createHash } from 'node:crypto';
import * as mod from '../../srv/lib/publish-concepts.js';

const shell = { before: '<html><head>CSS1</head><body>', after: '</body></html>' };
const shell2 = { before: '<html><head>CSS2</head><body>', after: '</body></html>' };

// Mirror the production shellHash + computePhaseToken formulae so the organic-path
// test can derive the expected token without injecting it.
function sha256(s) { return createHash('sha256').update(s, 'utf-8').digest('hex'); }
function shellHash({ before, after }) { return sha256(`${before}\u0000${after}`); }
function computePhaseToken(digest, sh) { return sha256(`${digest}\u0000${shellHash(sh)}`); }

describe('render-concepts phase skip', () => {
  it('skips the whole phase when phaseToken matches, shell unchanged, carry-forward active', async () => {
    const buildConceptsPayload = vi.fn(); // must NOT be called on skip
    const r = await mod.renderConceptsIntoSession({
      db: {}, sessionId: 's', helpers: { appendToSession: vi.fn() }, shell,
      priorPhaseToken: 'TOKEN', computedPhaseToken: 'TOKEN', carryForwardActive: true,
      deps: { buildConceptsPayload, computeConceptInputDigest: async () => 'DIGEST' },
    });
    expect(r.phaseSkipped).toBe(true);
    expect(buildConceptsPayload).not.toHaveBeenCalled();
  });
  it('does NOT skip when the shell changed (token would differ)', async () => {
    const buildConceptsPayload = vi.fn().mockResolvedValue({ concepts: [] });
    const r = await mod.renderConceptsIntoSession({
      db: {}, sessionId: 's', helpers: { appendToSession: vi.fn() }, shell: shell2,
      priorPhaseToken: 'TOKEN', computedPhaseToken: 'DIFFERENT', carryForwardActive: true,
      deps: { buildConceptsPayload, computeConceptInputDigest: async () => 'DIGEST' },
    });
    expect(r.phaseSkipped).toBe(false);
    expect(buildConceptsPayload).toHaveBeenCalled();
  });
  it('does NOT skip when carry-forward is disabled', async () => {
    const buildConceptsPayload = vi.fn().mockResolvedValue({ concepts: [] });
    const r = await mod.renderConceptsIntoSession({
      db: {}, sessionId: 's', helpers: { appendToSession: vi.fn() }, shell,
      priorPhaseToken: 'TOKEN', computedPhaseToken: 'TOKEN', carryForwardActive: false,
      deps: { buildConceptsPayload, computeConceptInputDigest: async () => 'DIGEST' },
    });
    expect(r.phaseSkipped).toBe(false);
  });

  // --- Additional coverage for correctness-critical paths ---

  it('organic shell-change: real hashing path skips on shell1, does NOT skip on shell2', async () => {
    // Drive the real computePhaseToken formula (no injected computedPhaseToken) with a
    // stubbed computeConceptInputDigest returning a fixed digest. Proves shellHash is
    // genuinely folded into the organic token — the anti-stale-chrome guarantee.
    const DIGEST = 'fixed-digest-for-organic-test';
    const tokenForShell1 = computePhaseToken(DIGEST, shell);

    const buildConceptsPayload = vi.fn().mockResolvedValue({ concepts: [] });
    const computeConceptInputDigest = vi.fn().mockResolvedValue(DIGEST);

    // Run with shell1 — priorPhaseToken matches the token the function will compute.
    const r1 = await mod.renderConceptsIntoSession({
      db: {}, sessionId: 's', helpers: { appendToSession: vi.fn() }, shell,
      priorPhaseToken: tokenForShell1, carryForwardActive: true,
      deps: { buildConceptsPayload, computeConceptInputDigest },
    });
    expect(r1.phaseSkipped).toBe(true);
    expect(buildConceptsPayload).not.toHaveBeenCalled();

    buildConceptsPayload.mockClear();
    computeConceptInputDigest.mockClear();

    // Run with shell2 — same digest, same priorPhaseToken, but shell changed.
    // The organic formula will produce a DIFFERENT token → must NOT skip.
    const r2 = await mod.renderConceptsIntoSession({
      db: {}, sessionId: 's', helpers: { appendToSession: vi.fn() }, shell: shell2,
      priorPhaseToken: tokenForShell1, carryForwardActive: true,
      deps: { buildConceptsPayload, computeConceptInputDigest },
    });
    expect(r2.phaseSkipped).toBe(false);
    expect(buildConceptsPayload).toHaveBeenCalled();
  });

  it('NULL prior token: does NOT skip even when carry-forward active', async () => {
    const buildConceptsPayload = vi.fn().mockResolvedValue({ concepts: [] });
    const r = await mod.renderConceptsIntoSession({
      db: {}, sessionId: 's', helpers: { appendToSession: vi.fn() }, shell,
      priorPhaseToken: null, carryForwardActive: true,
      deps: { buildConceptsPayload, computeConceptInputDigest: async () => 'DIGEST' },
    });
    expect(r.phaseSkipped).toBe(false);
    expect(buildConceptsPayload).toHaveBeenCalled();
  });

  it('fail-open: computeConceptInputDigest throws → falls through, buildConceptsPayload called, conceptPhaseToken null', async () => {
    const buildConceptsPayload = vi.fn().mockResolvedValue({ concepts: [] });
    const computeConceptInputDigest = vi.fn().mockRejectedValue(new Error('DB exploded'));
    const r = await mod.renderConceptsIntoSession({
      db: {}, sessionId: 's', helpers: { appendToSession: vi.fn() }, shell,
      priorPhaseToken: 'ANY-TOKEN', carryForwardActive: true,
      deps: { buildConceptsPayload, computeConceptInputDigest },
    });
    expect(r.phaseSkipped).toBe(false);
    expect(buildConceptsPayload).toHaveBeenCalled();
    expect(r.conceptPhaseToken).toBeNull();
  });
});
