import { describe, it, expect } from 'vitest';
import { buildSystemPrompt } from '../srv/lib/chat-context.js';

describe('buildSystemPrompt — puzzle kind', () => {
  const user = { firstName: 'Tom', lastName: 'Jung' };

  it('uses the puzzle persona when kind=puzzle', async () => {
    const out = await buildSystemPrompt({ kind: 'puzzle', slug: 'devtoberfest-cryptic-crossword' }, user);
    expect(out).toMatch(/crossword/i);
    expect(out).toMatch(/puzzleHint/);
    // Never-reveal guard is the whole point of the persona.
    expect(out).toMatch(/NEVER REVEAL THE ANSWER/);
  });

  it('does NOT include the default-tutorial refusal copy', async () => {
    // The base PERSONA's "I can only help with SAP tutorials" line is exactly
    // what caused Joule to refuse crossword help — the puzzle persona REPLACES
    // it, so it must not appear.
    const out = await buildSystemPrompt({ kind: 'puzzle', slug: 'x' }, user);
    expect(out).not.toMatch(/I can only help with SAP tutorials/);
  });

  it('layer mentions the slug when provided', async () => {
    const out = await buildSystemPrompt({ kind: 'puzzle', slug: 'devtoberfest-cryptic-crossword' }, user);
    expect(out).toMatch(/PAGE: Crossword puzzle — devtoberfest-cryptic-crossword/);
    expect(out).toMatch(/slug="devtoberfest-cryptic-crossword"/);
  });

  it('handles a missing slug gracefully', async () => {
    const out = await buildSystemPrompt({ kind: 'puzzle' }, user);
    expect(out).toMatch(/PAGE: Crossword puzzle\./);
    expect(out).not.toMatch(/slug="/);
  });

  it('does NOT include RAG_GUIDANCE or PROGRESS_GUIDANCE for puzzle kind', async () => {
    // The puzzle tool set is searchTutorials + puzzleHint only — no
    // getRelevantSteps and no getUserProgress, so their guidance would dangle.
    const out = await buildSystemPrompt({ kind: 'puzzle', slug: 'x' }, user);
    expect(out).not.toMatch(/getRelevantSteps tool returns step excerpts/);
    expect(out).not.toMatch(/getUserProgress/);
  });

  it("regression: kind='tutorial' prompt still uses the base persona", async () => {
    const out = await buildSystemPrompt({ kind: 'tutorial', title: 'Build with CAP', stepCount: 7 }, user);
    expect(out).toMatch(/I can only help with SAP tutorials/);
    expect(out).not.toMatch(/NEVER REVEAL THE ANSWER/);
  });
});
