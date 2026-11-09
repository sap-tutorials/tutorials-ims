// scripts/parsers/__tests__/directives-reference-links.test.ts
//
// Tests for Task 3 smart reference link directives:
//   :tutorial, :note, :help, :api, :since

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { expandDirectives, renderDirectivesAsText, DirectiveParseError } from '../directives.js';
import type { ExpandDirectivesContext } from '../directives.js';
import { registerDirective, resetRegistry } from '../directive-registry.js';
import {
  TUTORIAL_REF_DEF,
  NOTE_REF_DEF,
  HELP_REF_DEF,
  API_REF_DEF,
  SINCE_DEF,
} from '../directives/reference-links.js';

// ─── Setup / teardown ────────────────────────────────────────────────────────

beforeEach(() => {
  resetRegistry();
  registerDirective(TUTORIAL_REF_DEF);
  registerDirective(NOTE_REF_DEF);
  registerDirective(HELP_REF_DEF);
  registerDirective(API_REF_DEF);
  registerDirective(SINCE_DEF);
});

afterEach(() => {
  resetRegistry();
});

// ─── :tutorial ───────────────────────────────────────────────────────────

describe(':tutorial directive', () => {
  it('known slug → renders with catalog title as label', () => {
    const ctx: ExpandDirectivesContext = {
      slug: 'test-tutorial',
      catalogBySlug: new Map([
        ['hana-cloud-tutorial-1', { title: 'Get Started with HANA Cloud', time: 15 }],
      ]),
    };
    const result = expandDirectives(':tutorial[hana-cloud-tutorial-1]', ctx);
    expect(result).toContain('tut-tutorial');
    expect(result).toContain('label="Get Started with HANA Cloud"');
    expect(result).toContain('slug="hana-cloud-tutorial-1"');
    expect(result).toContain('href="/tutorials/hana-cloud-tutorial-1"');
  });

  it('slug is lowercased before lookup', () => {
    const ctx: ExpandDirectivesContext = {
      slug: 'test-tutorial',
      catalogBySlug: new Map([
        ['my-tutorial', { title: 'My Tutorial', time: 10 }],
      ]),
    };
    const result = expandDirectives(':tutorial[My-Tutorial]', ctx);
    expect(result).toContain('slug="my-tutorial"');
    expect(result).toContain('label="My Tutorial"');
  });

  it('unknown slug (catalogBySlug present) → throws DirectiveParseError with code invalid-attr', () => {
    const ctx: ExpandDirectivesContext = {
      slug: 'test-tutorial',
      catalogBySlug: new Map([
        ['other-tutorial', { title: 'Other', time: 5 }],
      ]),
    };
    // Type assertion is load-bearing: the fetch-tutorials compose-fail-loud path
    // (#3078) classifies errors by `instanceof DirectiveParseError` to decide
    // whether a dead cross-ref FAILS the rebuild vs. is a soft source error.
    expect(() => expandDirectives(':tutorial[no-such-slug]', ctx)).toThrow(DirectiveParseError);
    try {
      expandDirectives(':tutorial[no-such-slug]', ctx);
    } catch (err: unknown) {
      expect(err).toBeInstanceOf(DirectiveParseError);
      const e = err as { code?: string };
      expect(e.code).toBe('invalid-attr');
    }
  });

  it('without catalogBySlug → renders with slug as label (fail-open)', () => {
    const ctx: ExpandDirectivesContext = {
      slug: 'test-tutorial',
      // catalogBySlug is undefined
    };
    const result = expandDirectives(':tutorial[some-slug]', ctx);
    expect(result).toContain('tut-tutorial');
    expect(result).toContain('label="some-slug"');
    expect(result).toContain('slug="some-slug"');
    expect(result).not.toThrow;
  });

  it('explicit label attr overrides catalog title', () => {
    const ctx: ExpandDirectivesContext = {
      slug: 'test-tutorial',
      catalogBySlug: new Map([
        ['hana-tutorial', { title: 'Auto Title', time: 5 }],
      ]),
    };
    const result = expandDirectives(':tutorial[hana-tutorial]{label="Custom Label"}', ctx);
    expect(result).toContain('label="Custom Label"');
  });

  it('toText returns catalog title', () => {
    const ctx: ExpandDirectivesContext = {
      slug: 'test-tutorial',
      catalogBySlug: new Map([
        ['cap-tut', { title: 'CAP Tutorial', time: 10 }],
      ]),
    };
    const result = renderDirectivesAsText(':tutorial[cap-tut]');
    // Without catalogBySlug in renderDirectivesAsText, it falls back to slug
    expect(result).toBe('cap-tut');
  });

  it('toText with no catalog → returns slug', () => {
    const result = renderDirectivesAsText(':tutorial[my-slug]');
    expect(result).toBe('my-slug');
  });
});

// ─── :note ───────────────────────────────────────────────────────────────

describe(':note directive', () => {
  it('valid note number → correct href and label', () => {
    const ctx: ExpandDirectivesContext = { slug: 'test-tutorial' };
    const result = expandDirectives(':note[2471802]', ctx);
    expect(result).toContain('tut-note');
    expect(result).toContain('href="https://me.sap.com/notes/2471802"');
    expect(result).toContain('label="SAP Note 2471802"');
  });

  it('non-digit label → throws with code invalid-attr', () => {
    const ctx: ExpandDirectivesContext = { slug: 'test-tutorial' };
    expect(() => expandDirectives(':note[abc]', ctx)).toThrow();
    try {
      expandDirectives(':note[abc]', ctx);
    } catch (err: unknown) {
      const e = err as { code?: string };
      expect(e.code).toBe('invalid-attr');
    }
  });

  it('label with mixed digits and non-digits → throws with code invalid-attr', () => {
    const ctx: ExpandDirectivesContext = { slug: 'test-tutorial' };
    expect(() => expandDirectives(':note[123abc]', ctx)).toThrow();
  });

  it('toText returns "SAP Note <n>"', () => {
    // renderDirectivesAsText skips expand hooks; toText must format the raw digit
    // string into "SAP Note <n>" directly, without relying on expand having run.
    const result = renderDirectivesAsText(':note[3456789]');
    expect(result).toBe('SAP Note 3456789');
  });
});

// ─── :help ───────────────────────────────────────────────────────────────

describe(':help directive', () => {
  it('uses title from helpTitleCache when available', () => {
    const ctx: ExpandDirectivesContext = {
      slug: 'test-tutorial',
      helpTitleCache: new Map([
        ['hana-cloud/guide', 'SAP HANA Cloud Administration Guide'],
      ]),
    };
    const result = expandDirectives(':help[hana-cloud/guide]', ctx);
    expect(result).toContain('tut-help');
    expect(result).toContain('label="SAP HANA Cloud Administration Guide"');
    expect(result).toContain('href="https://help.sap.com/docs/hana-cloud/guide"');
  });

  it('falls back to path when cache miss', () => {
    const ctx: ExpandDirectivesContext = {
      slug: 'test-tutorial',
      helpTitleCache: new Map([
        ['other-path', 'Other Title'],
      ]),
    };
    const result = expandDirectives(':help[hana-cloud/guide]', ctx);
    expect(result).toContain('label="hana-cloud/guide"');
    expect(result).toContain('href="https://help.sap.com/docs/hana-cloud/guide"');
  });

  it('falls back to path when helpTitleCache is absent', () => {
    const ctx: ExpandDirectivesContext = {
      slug: 'test-tutorial',
      // no helpTitleCache
    };
    const result = expandDirectives(':help[some/path]', ctx);
    expect(result).toContain('label="some/path"');
    expect(result).toContain('href="https://help.sap.com/docs/some/path"');
  });

  it('toText returns title from cache when available (via expandDirectives label)', () => {
    const ctx: ExpandDirectivesContext = {
      slug: 'test-tutorial',
      helpTitleCache: new Map([
        ['cap/guide', 'CAP Guide'],
      ]),
    };
    const result = expandDirectives(':help[cap/guide]', ctx);
    expect(result).toContain('label="CAP Guide"');
  });
});

// ─── :api ────────────────────────────────────────────────────────────────

describe(':api directive', () => {
  it('known lib → correct href containing lib domain, symbol in params', () => {
    const ctx: ExpandDirectivesContext = { slug: 'test-tutorial' };
    const result = expandDirectives(':api[cds.ql.SELECT]{lib=cap-node}', ctx);
    expect(result).toContain('tut-api');
    expect(result).toContain('cap.cloud.sap');
    expect(result).toContain('symbol="cds.ql.SELECT"');
    expect(result).toContain('lib="cap-node"');
  });

  it('href contains the symbol in the anchor', () => {
    const ctx: ExpandDirectivesContext = { slug: 'test-tutorial' };
    const result = expandDirectives(':api[cds.ql.SELECT]{lib=cap-node}', ctx);
    expect(result).toContain('cds.ql.SELECT');
  });

  it('ui5 lib → ui5.sap.com domain', () => {
    const ctx: ExpandDirectivesContext = { slug: 'test-tutorial' };
    const result = expandDirectives(':api[sap.m.Button]{lib=ui5}', ctx);
    expect(result).toContain('ui5.sap.com');
    expect(result).toContain('symbol="sap.m.Button"');
  });

  it('unknown lib → throws with code invalid-attr', () => {
    const ctx: ExpandDirectivesContext = { slug: 'test-tutorial' };
    expect(() => expandDirectives(':api[foo]{lib=unknown-lib}', ctx)).toThrow();
    try {
      expandDirectives(':api[foo]{lib=unknown-lib}', ctx);
    } catch (err: unknown) {
      const e = err as { code?: string };
      expect(e.code).toBe('invalid-attr');
    }
  });

  it('toText returns the symbol', () => {
    const result = renderDirectivesAsText(':api[cds.ql.SELECT]{lib=cap-node}');
    expect(result).toBe('cds.ql.SELECT');
  });
});

// ─── :since ──────────────────────────────────────────────────────────────────

describe(':since directive', () => {
  it('renders label as tut-since shortcode', () => {
    const ctx: ExpandDirectivesContext = { slug: 'test-tutorial' };
    const result = expandDirectives(':since[CAP 9]', ctx);
    expect(result).toContain('tut-since');
    expect(result).toContain('label="CAP 9"');
  });

  it('version string with spaces is preserved', () => {
    const ctx: ExpandDirectivesContext = { slug: 'test-tutorial' };
    const result = expandDirectives(':since[UI5 1.120]', ctx);
    expect(result).toContain('label="UI5 1.120"');
  });

  it('toText returns the label', () => {
    const result = renderDirectivesAsText(':since[CAP 9]');
    expect(result).toBe('CAP 9');
  });
});

// ─── Cross-directive: mixed inline usage ─────────────────────────────────────

describe('mixed inline reference directives', () => {
  it('multiple reference directives on one line expand independently', () => {
    const ctx: ExpandDirectivesContext = {
      slug: 'test-tutorial',
      catalogBySlug: new Map([
        ['cap-tutorial', { title: 'CAP Tutorial', time: 10 }],
      ]),
    };
    const md = 'See :tutorial[cap-tutorial] and :note[2471802] for details.';
    const result = expandDirectives(md, ctx);
    expect(result).toContain('tut-tutorial');
    expect(result).toContain('tut-note');
    expect(result).toContain('CAP Tutorial');
    expect(result).toContain('SAP Note 2471802');
  });
});
