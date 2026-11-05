import { describe, it, expect, beforeEach } from 'vitest';
import {
  parseDirectives,
  tokenizeAttrs,
  DirectiveParseError,
} from '../directives.js';
import {
  registerDirective,
  resetRegistry,
  type DirectiveDef,
} from '../directive-registry.js';

// Fixture directive definition used across all tests
const ECHO_DEF: DirectiveDef = {
  name: 'echo',
  kinds: ['inline', 'leaf', 'container'],
  summary: 'Echo directive for tests',
  label: { required: false, markdown: false },
  attrs: {
    n: { type: 'number' },
    flag: { type: 'boolean' },
  },
  classes: ['big'],
  render: () => '',
  toText: () => '',
  since: '1.0.0',
};

describe('tokenizeAttrs', () => {
  it('parses number, boolean flag, id, and class', () => {
    const result = tokenizeAttrs('n=2 flag #setup-block .big');
    expect(result).toEqual({
      attrs: { n: 2, flag: true },
      id: 'setup-block',
      classes: ['big'],
    });
  });

  it('returns empty attrs/classes when given empty string', () => {
    const result = tokenizeAttrs('');
    expect(result).toEqual({ attrs: {}, classes: [] });
  });

  it('parses string attrs', () => {
    const result = tokenizeAttrs('os=mac');
    expect(result).toEqual({ attrs: { os: 'mac' }, classes: [] });
  });

  it('parses multiple classes', () => {
    const result = tokenizeAttrs('.foo .bar');
    expect(result).toEqual({ attrs: {}, classes: ['foo', 'bar'] });
  });

  it('parses quoted string value', () => {
    const result = tokenizeAttrs('msg="hello world"');
    expect(result).toEqual({ attrs: { msg: 'hello world' }, classes: [] });
  });
});

describe('parseDirectives — error handling', () => {
  beforeEach(() => {
    resetRegistry();
    registerDirective(ECHO_DEF);
  });

  it('throws DirectiveParseError with code duplicate-attr for duplicate keys', () => {
    // tokenizeAttrs with duplicate key should throw
    expect(() => tokenizeAttrs('os=mac os=win')).toThrowError(
      expect.objectContaining({ code: 'duplicate-attr' }),
    );
  });

  it('throws DirectiveParseError with code invalid-class for .class not in allowlist', () => {
    const md = '::echo[x]{.notallowed}';
    expect(() => parseDirectives(md, { slug: 'test' })).toThrowError(
      expect.objectContaining({ code: 'invalid-class' }),
    );
  });

  it('throws DirectiveParseError with code unclosed for container missing closing fence', () => {
    const md = ':::echo[t]\nbody without closing';
    expect(() => parseDirectives(md, { slug: 'test' })).toThrowError(
      expect.objectContaining({ code: 'unclosed' }),
    );
  });

  it('throws DirectiveParseError with code invalid-kind when directive used in wrong kind', () => {
    resetRegistry();
    registerDirective({ ...ECHO_DEF, name: 'only-container', kinds: ['container'] });
    const md = ':only-container[foo]';
    expect(() => parseDirectives(md, { slug: 'test' })).toThrowError(
      expect.objectContaining({ code: 'invalid-kind' }),
    );
  });

  it('throws DirectiveParseError with code missing-attr when required attr is absent', () => {
    resetRegistry();
    registerDirective({
      ...ECHO_DEF,
      name: 'required-attr-directive',
      attrs: { must: { type: 'string', required: true } },
    });
    const md = '::required-attr-directive[x]';
    expect(() => parseDirectives(md, { slug: 'test' })).toThrowError(
      expect.objectContaining({ code: 'missing-attr' }),
    );
  });

  it('throws DirectiveParseError with code missing-attr when required label is absent', () => {
    resetRegistry();
    registerDirective({
      ...ECHO_DEF,
      name: 'required-label-directive',
      label: { required: true, markdown: false },
    });
    const md = '::required-label-directive';
    expect(() => parseDirectives(md, { slug: 'test' })).toThrowError(
      expect.objectContaining({ code: 'missing-attr' }),
    );
  });

  it('DirectiveParseError is a real Error subclass with slug/line/column/directive/code', () => {
    const err = new DirectiveParseError('test error', 'my-slug', 5, 0, 'echo', 'unclosed');
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(DirectiveParseError);
    expect(err.name).toBe('DirectiveParseError');
    expect(err.slug).toBe('my-slug');
    expect(err.line).toBe(5);
    expect(err.column).toBe(0);
    expect(err.directive).toBe('echo');
    expect(err.code).toBe('unclosed');
    expect(err.message).toContain('(my-slug:5)');
  });
});

describe('parseDirectives — inline directives', () => {
  beforeEach(() => {
    resetRegistry();
    registerDirective(ECHO_DEF);
  });

  it('parses inline :echo[hi]{n=1}', () => {
    const md = 'Some prose with :echo[hi]{n=1} inside.';
    const { nodes, warnings } = parseDirectives(md, { slug: 'test' });
    expect(warnings).toHaveLength(0);
    expect(nodes).toHaveLength(1);
    expect(nodes[0]).toMatchObject({
      name: 'echo',
      kind: 'inline',
      label: 'hi',
      attrs: { n: 1 },
    });
  });

  it('returns zero nodes for false positives: 10:30', () => {
    const md = 'Time is 10:30 today.';
    const { nodes } = parseDirectives(md, { slug: 'test' });
    expect(nodes).toHaveLength(0);
  });

  it('returns zero nodes for false positives: std::vector', () => {
    const md = 'Use std::vector<int> in C++.';
    const { nodes } = parseDirectives(md, { slug: 'test' });
    expect(nodes).toHaveLength(0);
  });

  it('returns zero nodes for false positives: http://x', () => {
    const md = 'See http://x.example.com for details.';
    const { nodes } = parseDirectives(md, { slug: 'test' });
    expect(nodes).toHaveLength(0);
  });

  it('returns zero nodes for false positives: :smile: (emoji shortcode)', () => {
    const md = 'Happy :smile: face.';
    const { nodes } = parseDirectives(md, { slug: 'test' });
    expect(nodes).toHaveLength(0);
  });

  it('returns zero nodes for :echo{n=1} with no [ (not a valid inline directive)', () => {
    const md = ':echo{n=1}';
    const { nodes } = parseDirectives(md, { slug: 'test' });
    expect(nodes).toHaveLength(0);
  });

  it('returns zero nodes + directive/unknown warning for unknown :foo[bar]', () => {
    const md = ':foo[bar]';
    const { nodes, warnings } = parseDirectives(md, { slug: 'test' });
    expect(nodes).toHaveLength(0);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({
      code: 'directive/unknown',
      line: 1,
    });
  });

  it('returns zero nodes for inline code span `:echo[x]`', () => {
    const md = 'Use `:echo[x]` in your markdown.';
    const { nodes } = parseDirectives(md, { slug: 'test' });
    expect(nodes).toHaveLength(0);
  });
});

describe('parseDirectives — leaf directives', () => {
  beforeEach(() => {
    resetRegistry();
    registerDirective(ECHO_DEF);
  });

  it('parses leaf ::echo[x] alone on a line', () => {
    const md = '::echo[x]';
    const { nodes, warnings } = parseDirectives(md, { slug: 'test' });
    expect(warnings).toHaveLength(0);
    expect(nodes).toHaveLength(1);
    expect(nodes[0]).toMatchObject({
      name: 'echo',
      kind: 'leaf',
      label: 'x',
    });
  });
});

describe('parseDirectives — container directives', () => {
  beforeEach(() => {
    resetRegistry();
    registerDirective(ECHO_DEF);
  });

  it('parses container :::echo[t] with body', () => {
    const md = ':::echo[t]\nbody\n:::';
    const { nodes, warnings } = parseDirectives(md, { slug: 'test' });
    expect(warnings).toHaveLength(0);
    expect(nodes).toHaveLength(1);
    expect(nodes[0]).toMatchObject({
      name: 'echo',
      kind: 'container',
      label: 't',
      body: 'body',
    });
  });

  it('parses nested containers: exactly 1 top-level node, inner container in body source order', () => {
    const md = '::::echo\n:::echo\ninner\n:::\n::::';
    const { nodes, warnings } = parseDirectives(md, { slug: 'test' });
    expect(warnings).toHaveLength(0);
    // Recursive parse of nested containers is deferred to later tasks; only the
    // outer container is returned as a top-level node.
    expect(nodes).toHaveLength(1);
    const outer = nodes[0];
    expect(outer.kind).toBe('container');
    // Body must contain the inner container fence in source order
    expect(outer.body).toContain(':::echo');
    expect(outer.body).toContain('inner');
  });
});

describe('parseDirectives — fenced code skipping', () => {
  beforeEach(() => {
    resetRegistry();
    registerDirective(ECHO_DEF);
  });

  it('skips directives inside fenced code blocks', () => {
    const md = '```js\n:::echo\n```';
    const { nodes } = parseDirectives(md, { slug: 'test' });
    expect(nodes).toHaveLength(0);
  });
});

describe('parseDirectives — node fields', () => {
  beforeEach(() => {
    resetRegistry();
    registerDirective(ECHO_DEF);
  });

  it('node has correct line and column', () => {
    const md = 'Hello\n:echo[label] world';
    const { nodes } = parseDirectives(md, { slug: 'test' });
    expect(nodes).toHaveLength(1);
    // Line 2 (1-based), column at the ':' position
    expect(nodes[0].line).toBe(2);
    expect(nodes[0].column).toBeGreaterThanOrEqual(0);
  });

  it('leaf node has classes from attrs', () => {
    const md = '::echo[x]{.big}';
    const { nodes } = parseDirectives(md, { slug: 'test' });
    expect(nodes).toHaveLength(1);
    expect(nodes[0].classes).toContain('big');
  });

  it('node has id from attrs', () => {
    const md = '::echo[x]{#my-id}';
    const { nodes } = parseDirectives(md, { slug: 'test' });
    expect(nodes).toHaveLength(1);
    expect(nodes[0].id).toBe('my-id');
  });
});
