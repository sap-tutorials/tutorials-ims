// Integration tests: expandDirectives wired into the composeTutorial pipeline.
//
// Each test uses composeTutorial directly and verifies pipeline-position
// semantics:
//   - directives run AFTER wrapTokens   → {{var:X}} in a label is already a
//     span/sentinel by the time the directive is expanded
//   - directives run BEFORE convertOptionBlocks → a directive inside an
//     [OPTION BEGIN] panel is rendered before the panel is converted to
//     tab shortcodes
//
// A fixture 'echo' directive is registered in beforeEach and cleared in
// afterEach, so it has no side-effect on any other test suite.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  registerDirective,
  resetRegistry,
  type DirectiveDef,
  type DirectiveRenderOutput,
} from '../directive-registry.js';
import { composeTutorial } from '../compose.js';

// ─── Fixture directive ────────────────────────────────────────────────────────

const ECHO_DEF: DirectiveDef = {
  name: 'echo',
  kinds: ['inline', 'leaf', 'container'],
  summary: 'Echo directive for pipeline-integration tests',
  label: { required: false, markdown: false },
  attrs: {},
  classes: [],
  render: (node: any): DirectiveRenderOutput => ({
    params: {},
  }),
  toText: () => '',
  since: '1.0.0',
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeFm(extra = ''): string {
  return [
    '---',
    'parser: v2',
    'title: Directive Compose Test',
    'time: 5',
    'tags: [tutorial>beginner]',
    'primary_tag: tutorial>beginner',
    'author_name: Tester',
    'author_profile: https://example.com',
    extra,
    '---',
    '',
  ]
    .filter((l) => l !== '')
    .join('\n') + '\n';
}

const BASE_OPTS = {
  repo: 'test-repo',
  branch: 'main',
  slug: 'test-directive-compose',
  target: 'hugo' as const,
  rewriteImages: false,
};

// ─── Test suite ───────────────────────────────────────────────────────────────

describe('directives-compose: expandDirectives is wired into composeTutorial', () => {
  beforeEach(() => {
    registerDirective(ECHO_DEF);
  });

  afterEach(() => {
    resetRegistry();
  });

  // ── 1. Basic directive in a plain step ────────────────────────────────────

  it('renders a directive in a plain step body to its tut-* shortcode', () => {
    const md = makeFm() + [
      '# Directive Compose Test',
      '',
      '### Step 1 — Hello',
      '',
      'Before :echo[world] after.',
    ].join('\n');

    const result = composeTutorial(md, BASE_OPTS);

    // result.body must contain the shortcode
    expect(result.body).toContain('{{< tut-echo');
    // step content must also have the shortcode (body feeds into step parsing)
    expect(result.steps[0].content).toContain('{{< tut-echo');
    // original directive syntax must be gone
    expect(result.body).not.toContain(':echo[world]');
  });

  // ── 2. Variable in label: proves directives run AFTER wrapTokens ──────────

  it('variable token in directive label is already wrapped when the shortcode is built (AFTER wrapTokens)', () => {
    // Frontmatter declares a variable "groupNumber".
    // The directive label references it: :echo[dev-{{var:groupNumber}}]
    // After wrapTokens the token becomes a <span class="tut-var"> in prose.
    // The directive must see the WRAPPED form, so the shortcode label= param
    // must contain the span (or at minimum the "tut-var" attribute marker).
    const fm = makeFm([
      'variables:',
      '  - name: groupNumber',
      '    label: Your BTP Trial Group Number',
      '    type: string',
      '    maxLength: 6',
      '    placeholder: XXX',
    ].join('\n'));

    const md = fm + [
      '# Directive Compose Test',
      '',
      '### Step 1 — Variable in Label',
      '',
      'Connect to :echo[dev-{{var:groupNumber}}].',
    ].join('\n');

    const result = composeTutorial(md, BASE_OPTS);

    // The shortcode must exist
    expect(result.body).toContain('{{< tut-echo');

    // The label param must carry the wrapped variable form.
    // wrapTokens emits <span class="tut-var" data-tut-var="groupNumber">XXX</span>
    // for prose occurrences.  The shortcode parameter will HTML-escape the span,
    // so look for the data-tut-var attribute name (which survives escaping).
    expect(result.body).toContain('data-tut-var=');
    // The raw {{var:...}} token must be gone — it was wrapped before directives ran
    expect(result.body).not.toContain('{{var:groupNumber}}');
  });

  // ── 3. Directive inside an OPTION panel: proves directives run BEFORE convertOptionBlocks

  it('directive inside an OPTION panel renders inside the tab shortcode (BEFORE convertOptionBlocks)', () => {
    const md = makeFm() + [
      '# Directive Compose Test',
      '',
      '### Step 1 — Options',
      '',
      '[OPTION BEGIN [Windows]]',
      'Windows step: :echo[win-content].',
      '[OPTION END]',
      '',
      '[OPTION BEGIN [Mac]]',
      'Mac step: no directive here.',
      '[OPTION END]',
    ].join('\n');

    const result = composeTutorial(md, BASE_OPTS);

    // The OPTION blocks should have been converted to tab shortcodes
    // and the echo directive inside Windows should be rendered
    expect(result.body).toContain('{{< tut-echo');
    // The raw directive syntax must be gone
    expect(result.body).not.toContain(':echo[win-content]');
    // The Windows panel content should contain the rendered shortcode
    // (it appears BEFORE the Mac panel in the linearised body)
    const winIdx = result.body.indexOf('{{< tut-echo');
    const macIdx = result.body.indexOf('Mac step');
    expect(winIdx).toBeGreaterThanOrEqual(0);
    // The echo shortcode comes before the Mac content, confirming correct panel scoping
    expect(winIdx).toBeLessThan(macIdx);
  });

  // ── 4. Directive inside a code fence → unchanged ──────────────────────────

  it('directive syntax inside a fenced code block is left unchanged', () => {
    const md = makeFm() + [
      '# Directive Compose Test',
      '',
      '### Step 1 — Code fence',
      '',
      'Do not expand inside a fence:',
      '```bash',
      ':echo[should-not-expand]',
      '```',
    ].join('\n');

    const result = composeTutorial(md, BASE_OPTS);

    // The literal string inside the fence must survive intact
    expect(result.body).toContain(':echo[should-not-expand]');
    // No shortcode should appear (the directive was masked)
    expect(result.body).not.toContain('{{< tut-echo');
  });

  // ── 5. Empty registry: no-op identity ─────────────────────────────────────

  it('with an empty registry a step with no directives composes identically', () => {
    // Reset registry to empty state for this sub-case
    resetRegistry();

    const md = makeFm() + [
      '# Directive Compose Test',
      '',
      '### Step 1 — Plain',
      '',
      'No directives here, just plain text.',
    ].join('\n');

    const result = composeTutorial(md, BASE_OPTS);

    // Re-run with the echo directive registered — result should be identical
    // because the step body has no :echo[...] occurrences
    registerDirective(ECHO_DEF);
    const result2 = composeTutorial(md, BASE_OPTS);

    expect(result.body).toBe(result2.body);
    expect(result.steps[0].content).toBe(result2.steps[0].content);
  });

  // ── 6. Empty registry: bare :::foo line is byte-identical (I-1 container fix) ──

  it('a bare :::foo line (no closing fence) composes identically with empty registry — no throw, line preserved', () => {
    resetRegistry();
    // Registry is empty — :::foo is unknown, has no closing fence

    const md = makeFm() + [
      '# Directive Compose Test',
      '',
      '### Step 1 — Container no-close',
      '',
      ':::foo',
      '',
      'Some text after.',
    ].join('\n');

    // Must not throw
    let result: ReturnType<typeof composeTutorial>;
    expect(() => {
      result = composeTutorial(md, BASE_OPTS);
    }).not.toThrow();

    // The :::foo line must be preserved as literal text (byte-identity)
    expect(result!.body).toContain(':::foo');
    // No shortcode should have been emitted
    expect(result!.body).not.toContain('tut-foo');
  });
});
