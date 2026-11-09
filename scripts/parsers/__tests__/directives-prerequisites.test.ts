// scripts/parsers/__tests__/directives-prerequisites.test.ts
//
// Tests for Task 5: ::requires prerequisite cards directive.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { expandDirectives, renderDirectivesAsText, DirectiveParseError } from '../directives.js';
import type { ExpandDirectivesContext } from '../directives.js';
import { registerDirective, resetRegistry } from '../directive-registry.js';
import { REQUIRES_DEF } from '../directives/prerequisites.js';

// ─── Setup / teardown ────────────────────────────────────────────────────────

beforeEach(() => {
  resetRegistry();
  registerDirective(REQUIRES_DEF);
});

afterEach(() => {
  resetRegistry();
});

// ─── ::requires directive ────────────────────────────────────────────────────

describe('::requires directive', () => {
  it('1: single slug with catalog → title and time from catalog', () => {
    const ctx: ExpandDirectivesContext = {
      slug: 'test-tutorial',
      catalogBySlug: new Map([
        ['hana-cloud-tutorial-1', { title: 'Get Started with HANA Cloud', time: 15 }],
      ]),
    };
    const result = expandDirectives('::requires[hana-cloud-tutorial-1]', ctx);
    expect(result).toContain('tut-requires');
    expect(result).toContain('slug="hana-cloud-tutorial-1"');
    expect(result).toContain('title="Get Started with HANA Cloud"');
    expect(result).toContain('time="15"');
  });

  it('2: single slug without catalog → slug used as title (fail-open)', () => {
    const ctx: ExpandDirectivesContext = {
      slug: 'test-tutorial',
      // no catalogBySlug
    };
    const result = expandDirectives('::requires[my-prereq-tutorial]', ctx);
    expect(result).toContain('tut-requires');
    expect(result).toContain('slug="my-prereq-tutorial"');
    expect(result).toContain('title="my-prereq-tutorial"');
    expect(result).toContain('time="0"');
  });

  it('3: two separate ::requires directives each render their own card', () => {
    const ctx: ExpandDirectivesContext = {
      slug: 'test-tutorial',
      catalogBySlug: new Map([
        ['tutorial-a', { title: 'Tutorial A', time: 10 }],
        ['tutorial-b', { title: 'Tutorial B', time: 20 }],
      ]),
    };
    const md = '::requires[tutorial-a]\n::requires[tutorial-b]';
    const result = expandDirectives(md, ctx);
    expect(result).toContain('slug="tutorial-a"');
    expect(result).toContain('slug="tutorial-b"');
    expect(result).toContain('title="Tutorial A"');
    expect(result).toContain('title="Tutorial B"');
  });

  it('4: slug present in catalog → title from catalog used', () => {
    const ctx: ExpandDirectivesContext = {
      slug: 'test-tutorial',
      catalogBySlug: new Map([
        ['cap-getting-started', { title: 'CAP Getting Started', time: 30 }],
      ]),
    };
    const result = expandDirectives('::requires[cap-getting-started]', ctx);
    expect(result).toContain('title="CAP Getting Started"');
    expect(result).toContain('time="30"');
  });

  it('5: unknown slug with catalog present → throws DirectiveParseError with code invalid-attr', () => {
    const ctx: ExpandDirectivesContext = {
      slug: 'test-tutorial',
      catalogBySlug: new Map([
        ['known-tutorial', { title: 'Known Tutorial', time: 5 }],
      ]),
    };
    // Type assertion is load-bearing: the fetch-tutorials compose-fail-loud path
    // (#3078) classifies by `instanceof DirectiveParseError` to turn a dead
    // ::requires cross-ref into a hard rebuild failure.
    expect(() => expandDirectives('::requires[no-such-slug]', ctx)).toThrow(DirectiveParseError);
    try {
      expandDirectives('::requires[no-such-slug]', ctx);
    } catch (err: unknown) {
      expect(err).toBeInstanceOf(DirectiveParseError);
      const e = err as { code?: string };
      expect(e.code).toBe('invalid-attr');
    }
  });

  it('6: slug is lowercased before lookup', () => {
    const ctx: ExpandDirectivesContext = {
      slug: 'test-tutorial',
      catalogBySlug: new Map([
        ['my-tutorial', { title: 'My Tutorial', time: 10 }],
      ]),
    };
    // Directive label is case-sensitive input from author; slug lookup normalises to lowercase
    const result = expandDirectives('::requires[my-tutorial]', ctx);
    expect(result).toContain('slug="my-tutorial"');
    expect(result).toContain('title="My Tutorial"');
  });

  it('7: shortcode format contains {{< tut-requires ... >}}', () => {
    const ctx: ExpandDirectivesContext = {
      slug: 'test-tutorial',
      catalogBySlug: new Map([
        ['prereq-one', { title: 'Prereq One', time: 5 }],
      ]),
    };
    const result = expandDirectives('::requires[prereq-one]', ctx);
    // Framework emits {{< tut-requires ... >}} for leaf directives
    expect(result).toMatch(/\{\{<\s*tut-requires/);
    expect(result).toMatch(/>\}\}/);
  });

  it('8: optional attr true → optional="true" in shortcode', () => {
    const ctx: ExpandDirectivesContext = {
      slug: 'test-tutorial',
      catalogBySlug: new Map([
        ['opt-tutorial', { title: 'Optional Tutorial', time: 8 }],
      ]),
    };
    const result = expandDirectives('::requires[opt-tutorial]{optional}', ctx);
    expect(result).toContain('optional="true"');
  });

  it('9: optional attr absent → optional="false" in shortcode', () => {
    const ctx: ExpandDirectivesContext = {
      slug: 'test-tutorial',
      catalogBySlug: new Map([
        ['required-tutorial', { title: 'Required Tutorial', time: 12 }],
      ]),
    };
    const result = expandDirectives('::requires[required-tutorial]', ctx);
    expect(result).toContain('optional="false"');
  });

  it('10: toText returns slug as text when no catalog available', () => {
    // renderDirectivesAsText skips expand hooks; toText receives node with unresolved label
    const result = renderDirectivesAsText('::requires[some-prereq-tutorial]');
    expect(result).toBe('some-prereq-tutorial');
  });

  it('11: toText returns slug (label) directly when expand has not been run', () => {
    // renderDirectivesAsText bypasses expand — _title attr is not set
    // toText must fall back to node.label (the raw slug)
    const result = renderDirectivesAsText('::requires[hana-prereq]');
    expect(result).toBe('hana-prereq');
  });

  it('12: time=0 emitted when catalog entry has no time field', () => {
    const ctx: ExpandDirectivesContext = {
      slug: 'test-tutorial',
      catalogBySlug: new Map([
        // Entry with time explicitly 0
        ['zero-time-tutorial', { title: 'Zero Time Tutorial', time: 0 }],
      ]),
    };
    const result = expandDirectives('::requires[zero-time-tutorial]', ctx);
    expect(result).toContain('time="0"');
    expect(result).toContain('title="Zero Time Tutorial"');
  });
});
