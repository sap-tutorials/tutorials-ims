// @vitest-environment happy-dom
//
// Task 5 — tutorial-variables island
// Pure-helper unit tests for applyValue and resolveDefault.
// These import from ../substitution.ts (no DOM side-effects on import).

import { describe, it, expect, beforeEach } from 'vitest';
import { applyValue, resolveDefault } from '../substitution';
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
