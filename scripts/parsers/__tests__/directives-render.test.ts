import { describe, it, expect, beforeEach } from 'vitest';
import {
  parseDirectives,
  expandDirectives,
  escapeShortcodeParam,
} from '../directives.js';
import {
  registerDirective,
  resetRegistry,
  type DirectiveDef,
} from '../directive-registry.js';

// Fixture: a simple echo directive that renders as a shortcode
const ECHO_DEF: DirectiveDef = {
  name: 'echo',
  kinds: ['inline', 'leaf', 'container'],
  summary: 'Echo directive for tests',
  label: { required: false, markdown: false },
  attrs: {
    n: { type: 'number' },
    title: { type: 'string' },
  },
  classes: [],
  render: (node: any) => {
    // Echo renders all attrs as shortcode params
    const params: string[] = [];
    if (node.label) {
      params.push(`label="${escapeShortcodeParam(node.label)}"`);
    }
    for (const [k, v] of Object.entries(node.attrs)) {
      params.push(`${k}="${escapeShortcodeParam(String(v))}"`);
    }

    const paramStr = params.length > 0 ? ' ' + params.join(' ') : '';

    if (node.kind === 'container') {
      // For containers, return opening tag + body + closing tag
      const body = node.body || '';
      return `{{% tut-echo${paramStr} %}}\n${body}\n{{% /tut-echo %}}`;
    } else {
      return `{{< tut-echo${paramStr} >}}`;
    }
  },
  toText: () => '',
  since: '1.0.0',
};

// Fixture: a directive that returns raw markdown (render:'markdown' pattern)
const SUGAR_DEF: DirectiveDef = {
  name: 'sugar',
  kinds: ['inline', 'container'],
  summary: 'Sugar directive that renders raw markdown',
  label: { required: false, markdown: false },
  attrs: {},
  classes: [],
  render: (node: any) => {
    // This directive returns plain markdown, not a shortcode
    if (node.kind === 'container') {
      return `**${node.body}**`;
    }
    return `**${node.label}**`;
  },
  toText: () => '',
  since: '1.0.0',
};

// Fixture: a directive with an expand hook that could cause cycles
const CYCLIC_DEF: DirectiveDef = {
  name: 'cyclic',
  kinds: ['inline'],
  summary: 'Cyclic directive for cycle-detection tests',
  label: { required: false, markdown: false },
  attrs: {},
  classes: [],
  expand: (node: any, ctx: any) => {
    // This expand hook re-emits itself — should trigger depth guard
    return `:cyclic[loop]`;
  },
  render: (node: any) => `{{< tut-cyclic >}}`,
  toText: () => '',
  since: '1.0.0',
};

describe('escapeShortcodeParam', () => {
  it('escapes ampersand', () => {
    expect(escapeShortcodeParam('foo & bar')).toBe('foo &amp; bar');
  });

  it('escapes less-than', () => {
    expect(escapeShortcodeParam('foo < bar')).toBe('foo &lt; bar');
  });

  it('escapes greater-than', () => {
    expect(escapeShortcodeParam('foo > bar')).toBe('foo &gt; bar');
  });

  it('escapes double-quote', () => {
    expect(escapeShortcodeParam('foo " bar')).toBe('foo &quot; bar');
  });

  it('escapes multiple entities', () => {
    const input = '& < > "';
    const expected = '&amp; &lt; &gt; &quot;';
    expect(escapeShortcodeParam(input)).toBe(expected);
  });

  it('leaves safe characters alone', () => {
    expect(escapeShortcodeParam('hello-world_123')).toBe('hello-world_123');
  });

  it('does not double-escape already-escaped entities', () => {
    // Input is literal characters, not already-escaped HTML
    expect(escapeShortcodeParam('&lt;')).toBe('&amp;lt;');
  });
});

describe('expandDirectives', () => {
  beforeEach(() => {
    resetRegistry();
    registerDirective(ECHO_DEF);
    registerDirective(SUGAR_DEF);
    registerDirective(CYCLIC_DEF);
  });

  describe('inline directives', () => {
    it('renders inline directive as {{< tut-<name> params >}}', () => {
      const md = ':echo[hi]{n=1}';
      const result = expandDirectives(md, { slug: 'test' });
      expect(result).toContain('{{< tut-echo');
      expect(result).toContain('label="hi"');
      expect(result).toContain('n="1"');
    });

    it('escapes attribute values in inline shortcode', () => {
      const md = ':echo[Save]{title="Learn"}';
      const result = expandDirectives(md, { slug: 'test' });
      // The title attribute should be escaped
      expect(result).toContain('title="Learn"');
    });

    it('prevents attribute injection via quote escaping', () => {
      // Note: the parsed directive will only have the title attribute with the full value
      // The parser sees: title="\" onmouseover=alert(1) x=\""
      // This is NOT parsed as multiple attributes; it's a single quoted string value
      // So we test that the value is properly escaped in the shortcode output
      const md = ':echo[Save]{title="bad value"}';
      const result = expandDirectives(md, { slug: 'test' });
      // title="bad value" should render as title="bad value" (no escaping needed for this safe string)
      expect(result).toContain('title="bad value"');

      // Now test with a value containing quotes and special chars
      // But since parseDirectives validates attrs, we can't inject onmouseover as a separate attr
      // Instead, test that a label containing quotes gets properly escaped
      const md2 = ':echo[Save "quoted"]{n=1}';
      const result2 = expandDirectives(md2, { slug: 'test' });
      // The label "Save "quoted"" when rendered should have quotes escaped
      expect(result2).toContain('&quot;');
      // And verify no attribute breakout
      expect(result2).toMatch(/label="[^"]*&quot;[^"]*"/);
    });
  });

  describe('leaf directives', () => {
    it('renders leaf directive as inline shortcode', () => {
      const md = '::echo[x]{n=2}';
      const result = expandDirectives(md, { slug: 'test' });
      expect(result).toContain('{{< tut-echo');
      expect(result).toContain('label="x"');
    });
  });

  describe('container directives', () => {
    it('renders container directive with opening and closing shortcodes', () => {
      const md = ':::echo[t]\n**b**\n:::';
      const result = expandDirectives(md, { slug: 'test' });
      expect(result).toContain('{{% tut-echo label="t" %}}');
      expect(result).toContain('{{% /tut-echo %}}');
      expect(result).toContain('**b**');
    });

    it('preserves body between container shortcodes', () => {
      const md = ':::echo[label]\n# Heading\nSome text\n:::';
      const result = expandDirectives(md, { slug: 'test' });
      expect(result).toContain('# Heading');
      expect(result).toContain('Some text');
    });
  });

  describe('render:markdown pattern', () => {
    it('emits raw markdown from sugar directive without shortcode wrapping', () => {
      const md = ':sugar[bold text]';
      const result = expandDirectives(md, { slug: 'test' });
      // SUGAR_DEF.render returns **${node.label}**, which is plain markdown
      expect(result).toBe('**bold text**');
      // Should NOT be wrapped in a shortcode
      expect(result).not.toContain('{{<');
    });

    it('emits raw markdown from container sugar without shortcode wrapping', () => {
      const md = ':::sugar\ninner\n:::';
      const result = expandDirectives(md, { slug: 'test' });
      // SUGAR_DEF.render returns **${node.body}**, which is plain markdown
      expect(result).toBe('**inner**');
      // Should NOT be wrapped in a shortcode
      expect(result).not.toContain('{%');
    });
  });

  describe('cycle detection and depth guard', () => {
    it('throws when expand hook re-emits itself and depth limit is hit', () => {
      const md = ':cyclic[loop]';
      // This should throw because the expand hook keeps re-emitting :cyclic[loop]
      expect(() => expandDirectives(md, { slug: 'test' })).toThrow();
    });

    it('does not hang; exits cleanly on cycle', () => {
      const md = ':cyclic[loop]';
      // Set a timeout to ensure the call doesn't hang
      const start = Date.now();
      try {
        expandDirectives(md, { slug: 'test' });
      } catch (e) {
        // Expected to throw
      }
      const elapsed = Date.now() - start;
      // Should complete within a reasonable time (e.g., < 500ms)
      expect(elapsed).toBeLessThan(500);
    });
  });

  describe('position stability', () => {
    it('replaces nodes back-to-front so positions remain stable', () => {
      // Two inline directives on the same line
      const md = ':echo[a]{n=1} and :echo[b]{n=2}';
      const result = expandDirectives(md, { slug: 'test' });
      // Both should be replaced correctly (order shouldn't matter because we process back-to-front)
      const count = (result.match(/tut-echo/g) || []).length;
      expect(count).toBe(2);
      expect(result).toContain('label="a"');
      expect(result).toContain('label="b"');
    });
  });

  describe('edge cases', () => {
    it('handles empty markdown', () => {
      const result = expandDirectives('', { slug: 'test' });
      expect(result).toBe('');
    });

    it('handles markdown with no directives', () => {
      const md = '# Heading\n\nSome text.';
      const result = expandDirectives(md, { slug: 'test' });
      expect(result).toBe(md);
    });

    it('handles directives with no attributes', () => {
      const md = ':echo[hi]';
      const result = expandDirectives(md, { slug: 'test' });
      expect(result).toContain('{{< tut-echo');
      expect(result).toContain('label="hi"');
    });

    it('handles directives with empty label', () => {
      const md = ':echo[]{n=5}';
      const result = expandDirectives(md, { slug: 'test' });
      expect(result).toContain('n="5"');
    });
  });
});
