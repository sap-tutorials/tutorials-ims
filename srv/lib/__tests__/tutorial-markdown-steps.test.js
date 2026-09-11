import { describe, it, expect } from 'vitest';
import { parseMarkdownSteps } from '../tutorial-markdown-steps.js';

// Fixture mirrors the parser-v2 authoring shape: `###` step headings, an intro
// region before the first step (dropped), fenced code, [VALIDATE_n]/[DONE]
// markers, image-directive comments, and a commented-out step.
const V2_BODY = [
  '---',
  'title: Hello CAP',
  'parser: v2',
  '---',
  '',
  'Intro prose before the first step — not a step.',
  '',
  '### Install CAP',
  '',
  'Run `npm install -g @sap/cds-dk`.',
  '',
  '### Init the project',
  '',
  '<!-- border -->',
  '![screenshot](init.png)',
  '',
  '```bash',
  '### this heading is inside a fence, not a step',
  'cds init bookshop',
  '```',
  '',
  '[VALIDATE_1]',
  '[DONE]',
  '',
  '### Start the server',
  '',
  'Run `cds watch`.',
].join('\n');

describe('parseMarkdownSteps', () => {
  it('splits on H3 headings, 1-indexed in document order', () => {
    const steps = parseMarkdownSteps(V2_BODY);
    expect(steps.map((s) => s.number)).toEqual([1, 2, 3]);
    expect(steps.map((s) => s.title)).toEqual([
      'Install CAP',
      'Init the project',
      'Start the server',
    ]);
  });

  it('ignores H3 quoted inside a fenced code block (no phantom step)', () => {
    const steps = parseMarkdownSteps(V2_BODY);
    expect(steps).toHaveLength(3);
    // The fenced heading stays as literal content of step 2.
    expect(steps[1].markdown).toContain('### this heading is inside a fence');
    expect(steps[1].markdown).toContain('cds init bookshop');
  });

  it('per-step markdown is self-contained: leads with its own H3 heading', () => {
    const steps = parseMarkdownSteps(V2_BODY);
    expect(steps[0].markdown.startsWith('### Install CAP')).toBe(true);
    expect(steps[0].markdown).toContain('npm install -g @sap/cds-dk');
  });

  it('strips image-directive comments and [VALIDATE_n]/[DONE] markers', () => {
    const steps = parseMarkdownSteps(V2_BODY);
    expect(steps[1].markdown).not.toContain('<!-- border -->');
    expect(steps[1].markdown).toContain('![screenshot](init.png)');
    expect(steps[1].markdown).not.toContain('[VALIDATE_1]');
    expect(steps[1].markdown).not.toContain('[DONE]');
  });

  it('drops intro prose before the first step', () => {
    const steps = parseMarkdownSteps(V2_BODY);
    for (const s of steps) {
      expect(s.markdown).not.toContain('Intro prose before the first step');
    }
  });

  it('does not lift a commented-out H3 as a phantom step', () => {
    const body = [
      '### Real Step One',
      'content',
      '<!--',
      '### Disabled Step',
      'hidden content',
      '-->',
      '### Real Step Two',
      'more content',
    ].join('\n');
    const steps = parseMarkdownSteps(body);
    expect(steps.map((s) => s.title)).toEqual(['Real Step One', 'Real Step Two']);
  });

  it('provides a plaintext .text projection with markdown syntax stripped', () => {
    const steps = parseMarkdownSteps(V2_BODY);
    expect(steps[0].text).toContain('npm install -g @sap/cds-dk');
    expect(steps[0].text).not.toContain('`');
    expect(steps[0].text).not.toContain('#');
  });

  it('normalizes CRLF line endings before splitting', () => {
    const crlf = V2_BODY.replace(/\n/g, '\r\n');
    const steps = parseMarkdownSteps(crlf);
    expect(steps.map((s) => s.title)).toEqual([
      'Install CAP',
      'Init the project',
      'Start the server',
    ]);
    expect(steps[0].markdown).not.toContain('\r');
  });

  it('returns an empty array for a body with no H3 steps', () => {
    expect(parseMarkdownSteps('# Title\n\nJust prose, no steps.')).toEqual([]);
    expect(parseMarkdownSteps('')).toEqual([]);
    expect(parseMarkdownSteps(null)).toEqual([]);
  });
});
