// @vitest-environment happy-dom
//
// Task 5 + C1/I1 — tutorial-variables island
// Pure-helper unit tests for expandSentinels, applyValue, and resolveDefault.
// These import from ../substitution.ts (no DOM side-effects on import).

import { describe, it, expect, beforeEach } from 'vitest';
import { applyValue, resolveDefault, resolveInitial, expandSentinels } from '../substitution';
import type { TutorialVariable } from '../substitution';

// ──────────────────────────────────────────────────────────────────────────────
// applyValue
// ──────────────────────────────────────────────────────────────────────────────

describe('applyValue', () => {
  let root: HTMLElement;

  beforeEach(() => {
    root = document.createElement('div');
  });

  it('updates two matching spans and returns 2', () => {
    root.innerHTML = `
      <span data-tut-var="groupNumber">{{groupNumber}}</span>
      <span data-tut-var="groupNumber">{{groupNumber}}</span>
      <span data-tut-var="otherVar">{{otherVar}}</span>
    `;
    const count = applyValue('groupNumber', '007', root);
    expect(count).toBe(2);
    const spans = root.querySelectorAll('[data-tut-var="groupNumber"]');
    expect(spans[0].textContent).toBe('007');
    expect(spans[1].textContent).toBe('007');
    // unrelated var must not be touched
    expect(root.querySelector('[data-tut-var="otherVar"]')?.textContent).toBe('{{otherVar}}');
  });

  it('returns 0 when no matching spans exist', () => {
    root.innerHTML = `<span data-tut-var="foo">x</span>`;
    expect(applyValue('bar', 'val', root)).toBe(0);
  });

  it('uses document as default root when not supplied', () => {
    const span = document.createElement('span');
    span.setAttribute('data-tut-var', 'x');
    span.textContent = 'old';
    document.body.appendChild(span);
    const count = applyValue('x', 'new');
    expect(count).toBeGreaterThanOrEqual(1);
    expect(span.textContent).toBe('new');
    document.body.removeChild(span);
  });

  it('renders a value containing HTML as literal text, never parsed markup', () => {
    root.innerHTML = `<span data-tut-var="x"></span>`;
    applyValue('x', '<b>MyApp</b>', root);
    const span = root.querySelector('[data-tut-var="x"]')!;
    expect(span.textContent).toBe('<b>MyApp</b>');
    expect(span.children.length).toBe(0);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// resolveDefault
// ──────────────────────────────────────────────────────────────────────────────

describe('resolveDefault', () => {
  const varWithDefault: TutorialVariable = {
    name: 'groupNumber',
    label: 'Group Number',
    type: 'string',
    default: { from: 'email', pattern: 'da164-(\\d+)@' },
  };

  it('extracts capture group 1 when pattern matches', () => {
    const result = resolveDefault(varWithDefault, { email: 'da164-007@x.com' });
    expect(result).toBe('007');
  });

  it('returns null when identity is null', () => {
    expect(resolveDefault(varWithDefault, null)).toBeNull();
  });

  it('returns null when pattern does not match', () => {
    expect(resolveDefault(varWithDefault, { email: 'notmatching@example.com' })).toBeNull();
  });

  it('returns null when v.default is not defined', () => {
    const v: TutorialVariable = { name: 'x', label: 'X', type: 'string' };
    expect(resolveDefault(v, { email: 'da164-007@x.com' })).toBeNull();
  });

  it('does NOT throw on a bad regex pattern', () => {
    const v: TutorialVariable = {
      name: 'x',
      label: 'X',
      type: 'string',
      default: { from: 'email', pattern: '(' },
    };
    expect(() => resolveDefault(v, { email: 'da164-007@x.com' })).not.toThrow();
    expect(resolveDefault(v, { email: 'da164-007@x.com' })).toBeNull();
  });

  it('returns null when the identity field is missing', () => {
    const result = resolveDefault(varWithDefault, { givenName: 'Tom' });
    expect(result).toBeNull();
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// resolveInitial — [#2852] value overrides default overrides nothing
// ──────────────────────────────────────────────────────────────────────────────

describe('resolveInitial', () => {
  it('prefers the literal value over a matching default', () => {
    const v: TutorialVariable = {
      name: 'prod',
      type: 'string',
      value: 'FIXED',
      default: { from: 'email', pattern: 'da164-(\\d+)@' },
    };
    expect(resolveInitial(v, { email: 'da164-007@x.com' })).toBe('FIXED');
  });

  it('falls back to the regex default when no literal value', () => {
    const v: TutorialVariable = {
      name: 'g',
      type: 'string',
      default: { from: 'email', pattern: 'da164-(\\d+)@' },
    };
    expect(resolveInitial(v, { email: 'da164-007@x.com' })).toBe('007');
  });

  it('returns the literal value even when identity is null', () => {
    const v: TutorialVariable = { name: 'prod', type: 'string', value: 'FIXED' };
    expect(resolveInitial(v, null)).toBe('FIXED');
  });

  it('returns null when neither a value nor a resolvable default exists', () => {
    const v: TutorialVariable = { name: 'x', type: 'string' };
    expect(resolveInitial(v, { email: 'a@b.com' })).toBeNull();
  });

  it('ignores an empty-string value and falls through to default', () => {
    const v: TutorialVariable = {
      name: 'g',
      type: 'string',
      value: '',
      default: { from: 'email', pattern: 'da164-(\\d+)@' },
    };
    expect(resolveInitial(v, { email: 'da164-007@x.com' })).toBe('007');
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// expandSentinels
//
// These tests exercise the REAL rendered shape that inline-code produces:
// the parser emits `TUTVARxNAMEx` as safe literal text inside <code>, and
// expandSentinels() must turn that into real [data-tut-var] spans.
// This is the in-CI render-level guard for C1.
// ──────────────────────────────────────────────────────────────────────────────

describe('expandSentinels', () => {
  let root: HTMLElement;

  beforeEach(() => {
    root = document.createElement('div');
  });

  it('replaces a sentinel inside <code> with a [data-tut-var] span and returns 1', () => {
    // Simulates what Goldmark renders for `` `da164-{{var:groupNumber}}@x` ``
    // after wrapTokens emits the sentinel: <code>da164-TUTVARxgroupNumberx@x</code>
    root.innerHTML = '<p>Run <code>da164-TUTVARxgroupNumberx@x</code> to connect.</p>';

    const count = expandSentinels(root);
    expect(count).toBe(1);

    const span = root.querySelector<HTMLElement>('[data-tut-var="groupNumber"]');
    expect(span, 'a [data-tut-var="groupNumber"] span should exist').not.toBeNull();
    expect(span!.className).toBe('tut-var');

    // Surrounding literal text must be preserved as text nodes
    const code = root.querySelector('code')!;
    expect(code.textContent).toBe('da164-@x'); // sentinel replaced, placeholder empty
  });

  it('after expandSentinels + applyValue, the full inline-code value reads correctly', () => {
    root.innerHTML = '<p>Run <code>da164-TUTVARxgroupNumberx@x</code>.</p>';

    expandSentinels(root);
    applyValue('groupNumber', '007', root);

    const code = root.querySelector('code')!;
    expect(code.textContent).toBe('da164-007@x');

    const span = root.querySelector<HTMLElement>('[data-tut-var="groupNumber"]')!;
    expect(span.textContent).toBe('007');
  });

  it('handles multiple sentinels in different elements', () => {
    root.innerHTML = [
      '<code>TUTVARxgroupNumberx</code>',
      '<code>prefix-TUTVARxgroupNumberx-suffix</code>',
    ].join('');

    const count = expandSentinels(root);
    expect(count).toBe(2);

    const spans = root.querySelectorAll('[data-tut-var="groupNumber"]');
    expect(spans.length).toBe(2);
  });

  it('handles two DIFFERENT sentinels in one text node', () => {
    // Use sentinels with distinct non-overlapping names separated by a dash.
    // TUTVARxfooNamex and TUTVARxbarNamex
    root.innerHTML = '<code>TUTVARxfooNamex-TUTVARxbarNamex</code>';

    const count = expandSentinels(root);
    expect(count).toBe(2);

    expect(root.querySelector('[data-tut-var="fooName"]')).not.toBeNull();
    expect(root.querySelector('[data-tut-var="barName"]')).not.toBeNull();
  });

  it('does NOT expand already-built [data-tut-var] spans (no double-processing)', () => {
    // If a fenced-code span was already created at build time by the Hugo hook,
    // expandSentinels must leave it alone (it contains no sentinel literal).
    root.innerHTML = '<pre><code><span class="tut-var" data-tut-var="groupNumber">XXX</span></code></pre>';

    const count = expandSentinels(root);
    expect(count).toBe(0);

    // The existing span should still be there untouched
    const span = root.querySelector('[data-tut-var="groupNumber"]')!;
    expect(span.textContent).toBe('XXX');
  });

  it('returns 0 when there are no sentinels', () => {
    root.innerHTML = '<p>No tokens here.</p><code>plain code</code>';
    expect(expandSentinels(root)).toBe(0);
  });

  it('does not inject any HTML from the variable name (XSS safety)', () => {
    // Variable names are validated as [A-Za-z][A-Za-z0-9_]* so can't contain
    // angle brackets, but verify that the span is built safely regardless.
    root.innerHTML = '<code>TUTVARxmyVarx</code>';
    expandSentinels(root);

    const span = root.querySelector('[data-tut-var="myVar"]');
    expect(span).not.toBeNull();
    expect(span!.tagName).toBe('SPAN');
    // No raw HTML should be injected — only text content and a safe attribute
    expect(span!.innerHTML).toBe(''); // empty until applyValue
  });
});
