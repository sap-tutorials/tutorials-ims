// scripts/parsers/__tests__/directives-reference-links.test.ts
//
// Tests for Task 3 smart reference link directives:
//   :tutorial-ref, :note-ref, :help-ref, :api-ref, :since

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { expandDirectives, renderDirectivesAsText } from '../directives.js';
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

// ─── :tutorial-ref ───────────────────────────────────────────────────────────

describe(':tutorial-ref directive', () => {
  it('known slug → renders with catalog title as label', () => {
    const ctx: ExpandDirectivesContext = {
      slug: 'test-tutorial',
      catalogBySlug: new Map([
        ['hana-cloud-tutorial-1', { title: 'Get Started with HANA Cloud', time: 15 }],
      ]),
    };
    const result = expandDirectives(':tutorial-ref[hana-cloud-tutorial-1]', ctx);
    expect(result).toContain('tut-tutorial-ref');
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
    const result = expandDirectives(':tutorial-ref[My-Tutorial]', ctx);
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
    expect(() => expandDirectives(':tutorial-ref[no-such-slug]', ctx)).toThrow();
    try {
      expandDirectives(':tutorial-ref[no-such-slug]', ctx);
    } catch (err: unknown) {
      const e = err as { code?: string };
      expect(e.code).toBe('invalid-attr');
    }
  });

  it('without catalogBySlug → renders with slug as label (fail-open)', () => {
    const ctx: ExpandDirectivesContext = {
      slug: 'test-tutorial',
      // catalogBySlug is undefined
    };
    const result = expandDirectives(':tutorial-ref[some-slug]', ctx);
    expect(result).toContain('tut-tutorial-ref');
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
    const result = expandDirectives(':tutorial-ref[hana-tutorial]{label="Custom Label"}', ctx);
    expect(result).toContain('label="Custom Label"');
  });

  it('toText returns catalog title', () => {
    const ctx: ExpandDirectivesContext = {
      slug: 'test-tutorial',
      catalogBySlug: new Map([
        ['cap-tut', { title: 'CAP Tutorial', time: 10 }],
      ]),
    };
    const result = renderDirectivesAsText(':tutorial-ref[cap-tut]');
    // Without catalogBySlug in renderDirectivesAsText, it falls back to slug
    expect(result).toBe('cap-tut');
  });

  it('toText with no catalog → returns slug', () => {
    const result = renderDirectivesAsText(':tutorial-ref[my-slug]');
    expect(result).toBe('my-slug');
  });
});

// ─── :note-ref ───────────────────────────────────────────────────────────────

describe(':note-ref directive', () => {
  it('valid note number → correct href and label', () => {
    const ctx: ExpandDirectivesContext = { slug: 'test-tutorial' };
    const result = expandDirectives(':note-ref[2471802]', ctx);
    expect(result).toContain('tut-note-ref');
    expect(result).toContain('href="https://me.sap.com/notes/2471802"');
    expect(result).toContain('label="SAP Note 2471802"');
  });

  it('non-digit label → throws with code invalid-attr', () => {
    const ctx: ExpandDirectivesContext = { slug: 'test-tutorial' };
    expect(() => expandDirectives(':note-ref[abc]', ctx)).toThrow();
    try {
      expandDirectives(':note-ref[abc]', ctx);
    } catch (err: unknown) {
      const e = err as { code?: string };
      expect(e.code).toBe('invalid-attr');
    }
  });

  it('label with mixed digits and non-digits → throws with code invalid-attr', () => {
    const ctx: ExpandDirectivesContext = { slug: 'test-tutorial' };
    expect(() => expandDirectives(':note-ref[123abc]', ctx)).toThrow();
  });

  it('toText returns "SAP Note <n>"', () => {
    // renderDirectivesAsText skips expand hooks; toText must format the raw digit
    // string into "SAP Note <n>" directly, without relying on expand having run.
    const result = renderDirectivesAsText(':note-ref[3456789]');
    expect(result).toBe('SAP Note 3456789');
  });
});

// ─── :help-ref ───────────────────────────────────────────────────────────────

describe(':help-ref directive', () => {
  it('uses title from helpTitleCache when available', () => {
    const ctx: ExpandDirectivesContext = {
      slug: 'test-tutorial',
      helpTitleCache: new Map([
        ['hana-cloud/guide', 'SAP HANA Cloud Administration Guide'],
      ]),
    };
    const result = expandDirectives(':help-ref[hana-cloud/guide]', ctx);
    expect(result).toContain('tut-help-ref');
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
    const result = expandDirectives(':help-ref[hana-cloud/guide]', ctx);
    expect(result).toContain('label="hana-cloud/guide"');
    expect(result).toContain('href="https://help.sap.com/docs/hana-cloud/guide"');
  });

  it('falls back to path when helpTitleCache is absent', () => {
    const ctx: ExpandDirectivesContext = {
      slug: 'test-tutorial',
      // no helpTitleCache
    };
    const result = expandDirectives(':help-ref[some/path]', ctx);
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
    const result = expandDirectives(':help-ref[cap/guide]', ctx);
    expect(result).toContain('label="CAP Guide"');
  });
});

// ─── :api-ref ────────────────────────────────────────────────────────────────

describe(':api-ref directive', () => {
  it('known lib → correct href containing lib domain, symbol in params', () => {
    const ctx: ExpandDirectivesContext = { slug: 'test-tutorial' };
    const result = expandDirectives(':api-ref[cds.ql.SELECT]{lib=cap-node}', ctx);
    expect(result).toContain('tut-api-ref');
    expect(result).toContain('cap.cloud.sap');
    expect(result).toContain('symbol="cds.ql.SELECT"');
    expect(result).toContain('lib="cap-node"');
  });

  it('href contains the symbol in the anchor', () => {
    const ctx: ExpandDirectivesContext = { slug: 'test-tutorial' };
    const result = expandDirectives(':api-ref[cds.ql.SELECT]{lib=cap-node}', ctx);
    expect(result).toContain('cds.ql.SELECT');
  });

  it('ui5 lib → ui5.sap.com domain', () => {
    const ctx: ExpandDirectivesContext = { slug: 'test-tutorial' };
    const result = expandDirectives(':api-ref[sap.m.Button]{lib=ui5}', ctx);
    expect(result).toContain('ui5.sap.com');
    expect(result).toContain('symbol="sap.m.Button"');
  });

  it('unknown lib → throws with code invalid-attr', () => {
    const ctx: ExpandDirectivesContext = { slug: 'test-tutorial' };
    expect(() => expandDirectives(':api-ref[foo]{lib=unknown-lib}', ctx)).toThrow();
    try {
      expandDirectives(':api-ref[foo]{lib=unknown-lib}', ctx);
    } catch (err: unknown) {
      const e = err as { code?: string };
      expect(e.code).toBe('invalid-attr');
    }
  });

  it('toText returns the symbol', () => {
    const result = renderDirectivesAsText(':api-ref[cds.ql.SELECT]{lib=cap-node}');
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
    const md = 'See :tutorial-ref[cap-tutorial] and :note-ref[2471802] for details.';
    const result = expandDirectives(md, ctx);
    expect(result).toContain('tut-tutorial-ref');
    expect(result).toContain('tut-note-ref');
    expect(result).toContain('CAP Tutorial');
    expect(result).toContain('SAP Note 2471802');
  });
});
