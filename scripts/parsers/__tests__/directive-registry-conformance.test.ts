// scripts/parsers/__tests__/directive-registry-conformance.test.ts
//
// Registry CONFORMANCE invariant.
//
// Goal: every DirectiveDef in the live registry must have:
//   1. A non-empty `summary` string.
//   2. A callable `toText` function.
//
// Design:
//   - At Task 9 foundation time the registry is EMPTY, so the sweep over
//     getRegistry() passes vacuously. That is intentional — no directives are
//     registered at init yet.
//   - To prove the invariant is NOT a no-op we exercise it directly:
//       a) A deliberately-COMPLETE fixture def → the invariant passes.
//       b) A deliberately-INCOMPLETE fixture def (missing summary) → the
//          invariant CATCHES the violation.
//   - resetRegistry() is called in beforeEach to isolate each test from the
//     shared module-level registry state.

import { describe, it, expect, beforeEach } from 'vitest';
import {
  registerDirective,
  getRegistry,
  resetRegistry,
  type DirectiveDef,
} from '../directive-registry.js';

// ─── Conformance checker ─────────────────────────────────────────────────────

/**
 * Assert every entry in `registry` satisfies the conformance invariant:
 *   - def.summary is a non-empty string
 *   - def.toText is a function
 *
 * Returns an array of violation messages (empty → conformant).
 */
function checkRegistryConformance(
  registry: ReadonlyMap<string, DirectiveDef>,
): string[] {
  const violations: string[] = [];
  for (const [name, def] of registry) {
    if (typeof def.summary !== 'string' || def.summary.trim() === '') {
      violations.push(`"${name}": summary must be a non-empty string`);
    }
    if (typeof def.toText !== 'function') {
      violations.push(`"${name}": toText must be a function`);
    }
  }
  return violations;
}

// ─── Fixture defs ─────────────────────────────────────────────────────────────

/** A fully-conformant fixture directive. */
const COMPLETE_DEF: DirectiveDef = {
  name: 'conformance-complete',
  kinds: ['inline'],
  summary: 'A complete test directive with summary and toText',
  attrs: {},
  render: () => ({ markdown: '' }),
  toText: (_node, _ctx) => '',
  since: '1.0.0',
};

/** An intentionally-incomplete fixture: summary is an empty string. */
const INCOMPLETE_DEF: DirectiveDef = {
  name: 'conformance-incomplete',
  kinds: ['inline'],
  summary: '',          // ← deliberate violation
  attrs: {},
  render: () => ({ markdown: '' }),
  toText: (_node, _ctx) => '',
  since: '1.0.0',
};

/** Missing toText entirely — cast to bypass TypeScript's structural check. */
const NO_TO_TEXT_DEF = {
  name: 'conformance-no-totext',
  kinds: ['inline'],
  summary: 'Has a summary but no toText',
  attrs: {},
  render: () => ({ markdown: '' }),
  // toText intentionally omitted
  since: '1.0.0',
} as unknown as DirectiveDef;

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('directive-registry conformance invariant', () => {
  beforeEach(() => {
    resetRegistry();
  });

  // ── 1. Empty registry — vacuous pass ──────────────────────────────────────

  it('vacuously passes when the registry is empty (foundation state)', () => {
    expect(getRegistry().size).toBe(0);
    const violations = checkRegistryConformance(getRegistry());
    expect(violations).toHaveLength(0);
  });

  // ── 2. Complete def passes the invariant ──────────────────────────────────

  it('passes when every registered def has a non-empty summary and a toText function', () => {
    registerDirective(COMPLETE_DEF);
    const violations = checkRegistryConformance(getRegistry());
    expect(violations).toHaveLength(0);
  });

  // ── 3. Empty summary is caught ────────────────────────────────────────────

  it('catches a def with an empty summary', () => {
    // Register via raw Map mutation to bypass registerDirective validation
    // (the registry TypeScript interface has no runtime guard on summary content).
    // We inject it directly into the registry snapshot by registering a valid
    // def and then replacing it in the underlying map.
    // Simplest approach: cast getRegistry() and mutate via Map's set method.
    registerDirective(COMPLETE_DEF);
    // Inject the incomplete def directly — bypass registerDirective (it only
    // validates the name pattern, not the summary content).
    (getRegistry() as unknown as Map<string, DirectiveDef>).set(
      INCOMPLETE_DEF.name,
      INCOMPLETE_DEF,
    );

    const violations = checkRegistryConformance(getRegistry());
    expect(violations.length).toBeGreaterThan(0);
    expect(violations.some((v) => v.includes('conformance-incomplete'))).toBe(true);
    expect(violations.some((v) => v.includes('summary'))).toBe(true);
  });

  // ── 4. Missing toText is caught ───────────────────────────────────────────

  it('catches a def that has no toText function', () => {
    registerDirective(COMPLETE_DEF);
    (getRegistry() as unknown as Map<string, DirectiveDef>).set(
      NO_TO_TEXT_DEF.name,
      NO_TO_TEXT_DEF,
    );

    const violations = checkRegistryConformance(getRegistry());
    expect(violations.length).toBeGreaterThan(0);
    expect(violations.some((v) => v.includes('conformance-no-totext'))).toBe(true);
    expect(violations.some((v) => v.includes('toText'))).toBe(true);
  });

  // ── 5. Multiple entries: only the violating one surfaces ──────────────────

  it('reports violations per-entry and ignores conformant siblings', () => {
    registerDirective(COMPLETE_DEF);
    (getRegistry() as unknown as Map<string, DirectiveDef>).set(
      INCOMPLETE_DEF.name,
      INCOMPLETE_DEF,
    );

    const violations = checkRegistryConformance(getRegistry());
    // The COMPLETE_DEF must not appear in violations
    expect(violations.some((v) => v.includes('conformance-complete'))).toBe(false);
    // The INCOMPLETE_DEF must appear
    expect(violations.some((v) => v.includes('conformance-incomplete'))).toBe(true);
  });
});
