import { describe, it, expect, vi } from 'vitest';
import * as mod from '../../srv/lib/publish-concepts.js';

const shell = { before: '<html><head>CSS1</head><body>', after: '</body></html>' };
const shell2 = { before: '<html><head>CSS2</head><body>', after: '</body></html>' };

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
});
