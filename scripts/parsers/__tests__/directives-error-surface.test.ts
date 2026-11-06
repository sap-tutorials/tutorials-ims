// scripts/parsers/__tests__/directives-error-surface.test.ts
//
// Verifies that DirectiveParseError.message embeds both slug and line number
// so the fetch-tutorials generic catch at ~line 1624 records a useful string
// in .tutorial-cache/errors.json.
//
// Pattern: the generic catch does:
//   const message = err instanceof Error ? err.message : String(err)
//   errors.push({ slug, repo, error: message, timestamp })
//
// For the error entry to be actionable, err.message must already contain
// both the slug and the line number — no special-casing of DirectiveParseError
// exists in the catch block.
//
// A fixture 'req-label' directive (label.required = true) is registered in
// beforeEach and cleared in afterEach; it forces a missing-attr error when
// :req-label[] is written with an empty label.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  registerDirective,
  resetRegistry,
  type DirectiveDef,
  type DirectiveRenderOutput,
} from '../directive-registry.js';
import { DirectiveParseError } from '../directives.js';
import { composeTutorial } from '../compose.js';

// ─── Fixture directive ────────────────────────────────────────────────────────

// A minimal directive that REQUIRES a non-empty label.
// Using :req-label[] (empty label) at parse time forces a DirectiveParseError
// with code 'missing-attr'.
const REQ_LABEL_DEF: DirectiveDef = {
  name: 'req-label',
  kinds: ['inline'],
  summary: 'Fixture directive requiring a label (error-surface tests)',
  label: { required: true, markdown: false },
  attrs: {},
  classes: [],
  render: (_node: any): DirectiveRenderOutput => ({ params: {} }),
  toText: () => '',
  since: '0.0.0',
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeFm(): string {
  return [
    '---',
    'parser: v2',
    'title: Error Surface Test',
    'time: 5',
    'tags: [tutorial>beginner]',
    'primary_tag: tutorial>beginner',
    'author_name: Tester',
    'author_profile: https://example.com',
    '---',
    '',
  ].join('\n');
}

const TEST_SLUG = 'error-surface-fixture';
const BASE_OPTS = {
  repo: 'test-repo',
  branch: 'main',
  slug: TEST_SLUG,
  target: 'hugo' as const,
  rewriteImages: false,
};

// ─── Test suite ───────────────────────────────────────────────────────────────

describe('directives-error-surface: DirectiveParseError.message embeds slug and line', () => {
  beforeEach(() => {
    registerDirective(REQ_LABEL_DEF);
  });

  afterEach(() => {
    resetRegistry();
  });

  // ── 1. DirectiveParseError constructor embeds (slug:line) ─────────────────

  it('DirectiveParseError.message contains the slug and the line number', () => {
    const err = new DirectiveParseError(
      'Directive "req-label" requires a label',
      'my-tutorial-slug',
      42,
      0,
      'req-label',
      'missing-attr',
    );

    expect(err.message).toContain('my-tutorial-slug');
    expect(err.message).toContain('42');
    // The canonical format is (slug:line) — pin the pattern to catch regressions
    expect(err.message).toContain('(my-tutorial-slug:42)');
  });

  // ── 2. The generic catch in fetch-tutorials sees a useful message ─────────
  //
  // Simulate what fetch-tutorials does:
  //   const message = err instanceof Error ? err.message : String(err)
  //   errors.push({ slug, repo, error: message, timestamp })
  //
  // The resulting `error` field must contain both the slug and the line number.

  it('generic-catch simulation: message includes slug and line for fetch-tutorials errors.json', () => {
    const err = new DirectiveParseError(
      'Directive "req-label" requires a label',
      'tutorial-abc-slug',
      7,
      5,
      'req-label',
      'missing-attr',
    );

    // Mimic the fetch-tutorials generic catch
    const message = err instanceof Error ? err.message : String(err);

    expect(message).toContain('tutorial-abc-slug');
    expect(message).toContain('7');
    expect(message).toContain('(tutorial-abc-slug:7)');
  });

  // ── 3. DirectiveParseError propagates through composeTutorial ────────────
  //
  // When :req-label[] (empty label) appears in tutorial markdown, composeTutorial
  // must throw a DirectiveParseError whose message contains both the slug and
  // the line number.  This verifies the full pipeline path, not just the constructor.

  it('composeTutorial throws DirectiveParseError with slug and line in .message', () => {
    // Line 5 of the body (after frontmatter + title + blank) — line number in the
    // step body text that expandDirectives sees.
    const md =
      makeFm() +
      [
        '# Error Surface Test',
        '',
        '### Step 1 — Error trigger',
        '',
        'This directive has an empty label: :req-label[].',
      ].join('\n');

    expect(() => composeTutorial(md, BASE_OPTS)).toThrow(DirectiveParseError);

    let caughtErr: DirectiveParseError | undefined;
    try {
      composeTutorial(md, BASE_OPTS);
    } catch (e) {
      if (e instanceof DirectiveParseError) {
        caughtErr = e;
      }
    }

    expect(caughtErr).toBeDefined();
    if (!caughtErr) return; // narrow type for TS

    // The message must embed the slug so the fetch-tutorials error entry is actionable
    expect(caughtErr.message).toContain(TEST_SLUG);
    // The message must embed the line number
    expect(caughtErr.message).toMatch(/\d+/);
    // The canonical (slug:line) format must be present
    expect(caughtErr.message).toContain(`(${TEST_SLUG}:`);

    // Structured fields on the error must also be consistent
    expect(caughtErr.slug).toBe(TEST_SLUG);
    expect(typeof caughtErr.line).toBe('number');
    expect(caughtErr.line).toBeGreaterThan(0);
    expect(caughtErr.code).toBe('missing-attr');
  });
});
