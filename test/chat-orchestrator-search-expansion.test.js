// Unit test for #943 Task 4: chat-orchestrator flag-gates the
// expandSearchConcepts tool registration on ChatSettings.kgSearchExpansionEnabled.
//
// Uses the pure/synchronous `buildToolRegistry` + `buildSystemPromptLines`
// seams so the test doesn't need to boot CAP or seed a DB — the underlying
// wiring in `toolsForContext` (which DOES read ChatSettings) is exercised
// separately by the existing test/chat-orchestrator-tools.test.js.

import { describe, it, expect } from 'vitest';
import {
  buildToolRegistry,
  buildSystemPromptLines,
  dispatchTool,
} from '../srv/lib/chat-orchestrator.js';

describe('chat-orchestrator kgSearchExpansionEnabled gating', () => {
  it('does NOT include expandSearchConcepts when the flag is false', () => {
    const tools = buildToolRegistry({ settings: { kgSearchExpansionEnabled: false } });
    expect(tools.some(t => t.function?.name === 'expandSearchConcepts')).toBe(false);
  });

  it('includes expandSearchConcepts when the flag is true', () => {
    const tools = buildToolRegistry({ settings: { kgSearchExpansionEnabled: true } });
    expect(tools.some(t => t.function?.name === 'expandSearchConcepts')).toBe(true);
  });

  it('does NOT include expandSearchConcepts when settings is missing', () => {
    const tools = buildToolRegistry({});
    expect(tools.some(t => t.function?.name === 'expandSearchConcepts')).toBe(false);
  });

  it('does NOT include expandSearchConcepts on the devtoberfest early-return path even when the flag is true', () => {
    const tools = buildToolRegistry({
      settings: { kgSearchExpansionEnabled: true },
      pageContext: { kind: 'devtoberfest' },
    });
    expect(tools.some(t => t.function?.name === 'expandSearchConcepts')).toBe(false);
  });

  it('does NOT include expandSearchConcepts on the advocates early-return path even when the flag is true', () => {
    const tools = buildToolRegistry({
      settings: { kgSearchExpansionEnabled: true },
      pageContext: { kind: 'advocates' },
    });
    expect(tools.some(t => t.function?.name === 'expandSearchConcepts')).toBe(false);
  });
});

describe('chat-orchestrator buildSystemPromptLines — search-expansion guidance', () => {
  it('omits the expandSearchConcepts guidance when the flag is false', () => {
    const lines = buildSystemPromptLines({ settings: { kgSearchExpansionEnabled: false } });
    expect(lines.join('\n')).not.toMatch(/expandSearchConcepts/);
  });

  it('includes the expandSearchConcepts guidance when the flag is true', () => {
    const lines = buildSystemPromptLines({ settings: { kgSearchExpansionEnabled: true } });
    expect(lines.join('\n')).toMatch(/expandSearchConcepts/);
  });

  it('omits the guidance on the devtoberfest / advocates paths regardless of flag', () => {
    for (const kind of ['devtoberfest', 'advocates']) {
      const lines = buildSystemPromptLines({
        settings: { kgSearchExpansionEnabled: true },
        pageContext: { kind },
      });
      expect(lines.join('\n')).not.toMatch(/expandSearchConcepts/);
    }
  });
});

describe('#1125 findRelatedContent gating', () => {
  it('registers findRelatedContent when kgRelatedContentEnabled=true', () => {
    const tools = buildToolRegistry({ settings: { kgRelatedContentEnabled: true } });
    expect(tools.some(t => t.function?.name === 'findRelatedContent')).toBe(true);
  });
  it('omits findRelatedContent when kgRelatedContentEnabled=false', () => {
    const tools = buildToolRegistry({ settings: { kgRelatedContentEnabled: false } });
    expect(tools.some(t => t.function?.name === 'findRelatedContent')).toBe(false);
  });
  it('omits findRelatedContent on devtoberfest pages regardless of flag', () => {
    const tools = buildToolRegistry({ settings: { kgRelatedContentEnabled: true }, pageContext: { kind: 'devtoberfest' } });
    expect(tools.some(t => t.function?.name === 'findRelatedContent')).toBe(false);
  });
  it('omits findRelatedContent on advocates pages regardless of flag', () => {
    const tools = buildToolRegistry({ settings: { kgRelatedContentEnabled: true }, pageContext: { kind: 'advocates' } });
    expect(tools.some(t => t.function?.name === 'findRelatedContent')).toBe(false);
  });
  it('adds a system-prompt line when flag on, none when off', () => {
    const on = buildSystemPromptLines({ settings: { kgRelatedContentEnabled: true } });
    expect(on.some(l => /findRelatedContent/.test(l))).toBe(true);
    const off = buildSystemPromptLines({ settings: { kgRelatedContentEnabled: false } });
    expect(off.some(l => /findRelatedContent/.test(l))).toBe(false);
  });
});

describe('#1125 dispatchTool findRelatedContent', () => {
  it('returns an empty-content envelope for an empty query without throwing', async () => {
    const out = await dispatchTool('findRelatedContent', { query: '   ' }, { id: 'u1' });
    expect(out).toHaveProperty('externalContent');
    expect(Array.isArray(out.externalContent)).toBe(true);
    expect(out.externalContent).toEqual([]);
  });
});
