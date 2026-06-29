// scripts/__tests__/cds-entities-requires-load.test.ts
//
// Regression guard for #757: any operator script under scripts/ that calls
// `cds.entities(...)` must FIRST populate the CDS model (either by assigning
// `cds.model = await cds.load(...)` or by `await cds.load(...)` for its side
// effects). The serving lifecycle (`cds-serve`) does this for you; a bare
// `cds.connect.to('db')` under `cds bind --exec` does not, and the result is
// a confusing `TypeError: cds.entities is not a function` at runtime.
//
// We scan every .cjs/.js file directly under scripts/ (non-recursive — sub-
// directories like scripts/__tests__, scripts/parsers, scripts/lib, scripts/
// spike contain test helpers / parsers / spike code and have different
// lifecycles). The guard is purely lexical:
//
//   If a file mentions `cds.entities(`, it MUST also mention `cds.load(`
//   somewhere in the same file (comments stripped).
//
// We don't enforce ordering: in real scripts `cds.entities(...)` is
// frequently called from inside a function that runs AFTER an `await
// cds.load(...)` at module top level. That's safe at runtime even though
// the textual order is reversed. A file that contains BOTH primitives is
// almost certainly written by someone who knew what they were doing; the
// bug we're guarding against is the one that bit #757 — a script that
// FORGOT cds.load entirely.

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const SCRIPTS_DIR = join(__dirname, '..');

function listShallowScripts(): string[] {
  return readdirSync(SCRIPTS_DIR)
    .filter(name => name.endsWith('.cjs') || name.endsWith('.js'))
    .filter(name => statSync(join(SCRIPTS_DIR, name)).isFile());
}

/**
 * Strip `//`-line comments and block comments from a source so a
 * "cds.entities(" mentioned in a comment doesn't trip the guard.
 *
 * Best-effort string-aware: doesn't try to be a full lexer, but skips over
 * single/double/backtick strings so comment markers inside a literal aren't
 * eaten. Scripts under scripts/ are CommonJS/ESM with conventional syntax;
 * this is plenty.
 */
export function stripComments(source: string): string {
  let out = '';
  let i = 0;
  const n = source.length;
  while (i < n) {
    const c = source[i];
    const next = source[i + 1];
    // Line comment
    if (c === '/' && next === '/') {
      while (i < n && source[i] !== '\n') i++;
      continue;
    }
    // Block comment
    if (c === '/' && next === '*') {
      i += 2;
      while (i < n - 1 && !(source[i] === '*' && source[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    // String literal — copy through (preserving line breaks for line numbers)
    if (c === "'" || c === '"' || c === '`') {
      const quote = c;
      out += c; i++;
      while (i < n && source[i] !== quote) {
        if (source[i] === '\\' && i + 1 < n) { out += source[i] + source[i + 1]; i += 2; continue; }
        out += source[i]; i++;
      }
      if (i < n) { out += source[i]; i++; }
      continue;
    }
    out += c; i++;
  }
  return out;
}

/**
 * Returns null if the file is safe (no `cds.entities(` usage, OR a `cds.load(`
 * call appears anywhere else in the file). Returns a human-readable reason
 * string when the file calls `cds.entities(` but never calls `cds.load(`.
 * Comments are stripped first so a docstring example doesn't count.
 */
export function auditScript(source: string): string | null {
  const stripped = stripComments(source);
  const lines = stripped.split(/\r?\n/);
  const firstEntitiesIdx = lines.findIndex(l => /\bcds\.entities\s*\(/.test(l));
  if (firstEntitiesIdx < 0) return null; // doesn't touch cds.entities — fine

  if (/\bcds\.load\s*\(/.test(stripped)) return null; // load is present somewhere — fine

  return `calls cds.entities(...) at line ${firstEntitiesIdx + 1} but never calls cds.load(...). ` +
    `Add \`cds.model = await cds.load('*');\` before the first cds.connect.to('db') call. See #757.`;
}

describe('cds.entities() callers require cds.load() (regression #757)', () => {
  const files = listShallowScripts();

  it('discovers at least a handful of scripts', () => {
    // Sanity guard: if the glob returned 0 entries, the test would silently
    // pass — and the fixed scripts wouldn't be checked. Pin a floor.
    expect(files.length).toBeGreaterThan(10);
  });

  for (const name of files) {
    it(`scripts/${name} loads the CDS model when it touches cds.entities()`, () => {
      const src = readFileSync(join(SCRIPTS_DIR, name), 'utf8');
      const reason = auditScript(src);
      if (reason) {
        throw new Error(`scripts/${name}: ${reason}`);
      }
    });
  }
});

describe('auditScript pure-function unit tests', () => {
  it('returns null when the file does not touch cds.entities', () => {
    expect(auditScript("const cds = require('@sap/cds');\nawait cds.connect.to('db');")).toBeNull();
  });

  it('returns null when cds.load and cds.entities are both present', () => {
    const src = [
      "const cds = require('@sap/cds');",
      "await cds.load('*');",
      "const db = await cds.connect.to('db');",
      "const { Tutorials } = cds.entities('com.sap.developers.ims');",
    ].join('\n');
    expect(auditScript(src)).toBeNull();
  });

  it('returns null for the cds.model = await cds.load(...) pattern', () => {
    const src = [
      "const cds = require('@sap/cds');",
      "cds.model = await cds.load('*');",
      "const { Tutorials } = cds.entities('com.sap.developers.ims');",
    ].join('\n');
    expect(auditScript(src)).toBeNull();
  });

  it('accepts cds.load AFTER cds.entities (function-scoped reads are fine at runtime)', () => {
    const src = [
      "function readEntities() { return cds.entities('com.sap.developers.ims'); }",
      "(async () => {",
      "  await cds.load('*');",
      "  readEntities();",
      "})();",
    ].join('\n');
    expect(auditScript(src)).toBeNull();
  });

  it('returns a reason when cds.entities is called and cds.load is never called', () => {
    const src = [
      "const cds = require('@sap/cds');",
      "await cds.connect.to('db');",
      "const { Tutorials } = cds.entities('com.sap.developers.ims');",
    ].join('\n');
    const reason = auditScript(src);
    expect(reason).toMatch(/cds\.entities/);
    expect(reason).toMatch(/cds\.load/);
    expect(reason).toMatch(/#757/);
  });

  it('does not see cds.entities/load mentions inside comments', () => {
    const src = [
      "// Sample: cds.entities('foo') needs cds.load('*') first.",
      "const cds = require('@sap/cds');",
      "await cds.connect.to('db');",
    ].join('\n');
    expect(auditScript(src)).toBeNull();
  });
});

