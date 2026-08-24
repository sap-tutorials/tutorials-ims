// test/unit/freshness-prompt-guard.test.js
// Task 5: Asserts the FRESHNESS_TOOL_SPEC JSON-schema shape is correct.
// Confidence enum and groundingSource must be present on every finding item.

import { describe, it, expect } from 'vitest';
import { FRESHNESS_TOOL_SPEC, SYSTEM_PROMPT, buildUserMessage } from '../../srv/lib/freshness-detector.js';

describe('FRESHNESS_TOOL_SPEC', () => {
  it('requires confidence and groundingSource on every finding', () => {
    const item = FRESHNESS_TOOL_SPEC.function.parameters.properties.findings.items;
    expect(item.required).toEqual(expect.arrayContaining(['confidence', 'groundingSource', 'category', 'severity', 'stepRef', 'codeBlockIndex']));
    expect(item.properties.confidence.enum).toEqual(['High', 'Medium', 'Low']);
  });
});

describe('SYSTEM_PROMPT context + SAP guidance', () => {
  it('tells the model to judge blocks in context, not isolation', () => {
    expect(SYSTEM_PROMPT).toMatch(/in the context|in isolation/i);
    expect(SYSTEM_PROMPT).toMatch(/prerequisites/i);
    expect(SYSTEM_PROMPT).toMatch(/GitHub Codespaces|dev container/i);
  });

  it('tells the model to respect intentional teaching artifacts', () => {
    expect(SYSTEM_PROMPT).toMatch(/intentional|on purpose|deliberately/i);
    expect(SYSTEM_PROMPT).toMatch(/base64|demo|illustrative|placeholder/i);
  });

  it('forbids anti-CAP advice such as pinning @sap package versions', () => {
    expect(SYSTEM_PROMPT).toMatch(/@sap/);
    expect(SYSTEM_PROMPT).toMatch(/pin/i);
  });
});

describe('buildUserMessage', () => {
  const blocks = [
    { stepRef: 1, codeBlockIndex: 0, lang: 'bash', code: 'cds watch',
      contextBefore: 'Run the command:', contextAfter: 'You will see the error on purpose.' },
  ];

  it('prepends tutorial context and inlines adjacent prose', () => {
    const msg = buildUserMessage(blocks, [[]], {
      frontmatter: 'title: Demo',
      prerequisites: '- A dev container in GitHub Codespaces',
    });
    expect(msg).toContain('## Tutorial context');
    expect(msg).toContain('title: Demo');
    expect(msg).toContain('dev container in GitHub Codespaces');
    expect(msg).toContain('Text before this block:\nRun the command:');
    expect(msg).toContain('Text after this block:\nYou will see the error on purpose.');
    expect(msg).toContain('cds watch');
  });

  it('omits the context preamble when no frontmatter/prerequisites exist', () => {
    const msg = buildUserMessage(blocks, [[]], {});
    expect(msg).not.toContain('## Tutorial context');
    expect(msg).toContain('cds watch');
  });
});

