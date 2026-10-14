// test/lib/ai-author-gate.test.ts
//
// [#2761] Deploy-pipeline efficiency: the AI-author (quiz + challenge) phase
// is the single most expensive, most wasted part of a deploy build (the
// rendered tutorial bodies are discarded by the approuter — only HANA-served
// bodies from the content rebuild keep their quizzes). This gate lets a deploy
// build skip the whole AI phase via SKIP_AI_AUTHOR, and fails open (one warning,
// no per-step throw loop) when the AI Hub binding is genuinely missing.
import { describe, it, expect, vi } from 'vitest';
import { resolveAiAuthorGate } from '../../scripts/lib/ai-author-gate.js';

// A resolver that succeeds (binding present).
const okResolver = async () => ({ modelName: 'm', deploymentId: 'd-123' });
// A resolver that throws the real "No deploymentId" error.
const missingResolver = async () => {
  throw new Error('No deploymentId for SAP AI Hub call. Set ChatSettings.deploymentId ...');
};

describe('resolveAiAuthorGate [#2761]', () => {
  it('disabled when SKIP_AI_AUTHOR is set — resolver is never called', async () => {
    const resolveSettings = vi.fn(okResolver);
    const gate = await resolveAiAuthorGate({ skip: true, resolveSettings });
    expect(gate.enabled).toBe(false);
    expect(gate.reason).toMatch(/SKIP_AI_AUTHOR/);
    // Short-circuit: a skipped build must not even probe the binding.
    expect(resolveSettings).not.toHaveBeenCalled();
  });

  it('enabled when not skipped and the AI Hub binding resolves', async () => {
    const resolveSettings = vi.fn(okResolver);
    const gate = await resolveAiAuthorGate({ skip: false, resolveSettings });
    expect(gate.enabled).toBe(true);
    // Probed exactly once — the gate is resolved per build, not per step.
    expect(resolveSettings).toHaveBeenCalledTimes(1);
  });

  it('fails open (disabled, one probe) when the binding is missing', async () => {
    const resolveSettings = vi.fn(missingResolver);
    const gate = await resolveAiAuthorGate({ skip: false, resolveSettings });
    expect(gate.enabled).toBe(false);
    expect(gate.reason).toMatch(/No deploymentId|binding/i);
    // The whole point: resolve ONCE, not once per step (no 200x throw loop).
    expect(resolveSettings).toHaveBeenCalledTimes(1);
  });

  it('fails open when the resolver returns a null deploymentId without throwing', async () => {
    const resolveSettings = vi.fn(async () => ({ modelName: 'm', deploymentId: null }));
    const gate = await resolveAiAuthorGate({ skip: false, resolveSettings });
    expect(gate.enabled).toBe(false);
    expect(gate.reason).toMatch(/deploymentId|binding/i);
  });

  it('reads SKIP_AI_AUTHOR from the environment when skip is omitted', async () => {
    const resolveSettings = vi.fn(okResolver);
    const gate = await resolveAiAuthorGate({ env: { SKIP_AI_AUTHOR: '1' }, resolveSettings });
    expect(gate.enabled).toBe(false);
    expect(resolveSettings).not.toHaveBeenCalled();
  });
});
