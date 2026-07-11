import { describe, it, expect } from 'vitest';
import { buildSystemPrompt } from '../srv/lib/chat-context.js';

describe('buildSystemPrompt — devtoberfest kind', () => {
  const user = { firstName: 'Tom', lastName: 'Jung' };

  it('uses the Devtoberfest persona when kind=devtoberfest', async () => {
    const out = await buildSystemPrompt({ kind: 'devtoberfest' }, user);
    expect(out).toMatch(/Devtoberfest/);
    expect(out).toMatch(/SAP TechEd/);
    expect(out).toMatch(/SCOPE — STRICT/);
    expect(out).toMatch(/getDevtoberfestInfo/);
    // Persona-side rule: always pass the devtoberfest tag
    expect(out).toMatch(/searchTutorials.*tags.*devtoberfest/s);
    // Refusal copy
    expect(out).toMatch(/That's outside Devtoberfest/);
  });

  it('does NOT include the default-tutorial persona scope guard verbatim', async () => {
    const out = await buildSystemPrompt({ kind: 'devtoberfest' }, user);
    // The base PERSONA's "I can only help with SAP tutorials" line must
    // NOT appear — the Devtoberfest persona REPLACES it (not stacks).
    expect(out).not.toMatch(/I can only help with SAP tutorials/);
  });

  it("layer mentions the slug when provided", async () => {
    const out = await buildSystemPrompt({ kind: 'devtoberfest', slug: 'rules' }, user);
    expect(out).toMatch(/PAGE: Devtoberfest — rules/);
  });

  it("falls back to 'homepage' label when slug is empty or _index", async () => {
    const a = await buildSystemPrompt({ kind: 'devtoberfest', slug: '' }, user);
    const b = await buildSystemPrompt({ kind: 'devtoberfest', slug: '_index' }, user);
    expect(a).toMatch(/PAGE: Devtoberfest — homepage/);
    expect(b).toMatch(/PAGE: Devtoberfest — homepage/);
  });

  it("does NOT include RAG_GUIDANCE or PROGRESS_GUIDANCE for devtoberfest kind", async () => {
    // These layers exist for tutorial/search/etc.; on Devtoberfest pages
    // there are no RAG-eligible embeddings and no progress-aware
    // recommendations, so the guidance is omitted to keep the prompt tight.
    const out = await buildSystemPrompt({ kind: 'devtoberfest' }, user);
    expect(out).not.toMatch(/getRelevantSteps tool returns step excerpts/);
    expect(out).not.toMatch(/getUserProgress/);
  });

  it("regression: kind='tutorial' prompt is unchanged", async () => {
    const out = await buildSystemPrompt({ kind: 'tutorial', title: 'Build with CAP', stepCount: 7 }, user);
    expect(out).toMatch(/Build with CAP/);
    expect(out).toMatch(/I can only help with SAP tutorials/); // base PERSONA still in effect
    expect(out).not.toMatch(/Devtoberfest/);
  });

  it("regression: kind='admin' prompt is unchanged", async () => {
    const out = await buildSystemPrompt({ kind: 'admin', tool: 'analytics-builder' }, user);
    expect(out).toMatch(/Admin Console/);
    expect(out).not.toMatch(/Devtoberfest/);
    expect(out).not.toMatch(/getUserProgress/);
  });
});
