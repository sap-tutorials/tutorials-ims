// test/scripts/check-fragment-binding-mode.test.ts
//
// Lint-style guard against the `%{...}` vs `${...}` binding-mode confusion
// inside UI5 fragment expression bindings (#426).
//
// THE BUG CLASS: UI5 supports two interpolation forms inside expression
// bindings:
//
//   ${path}    — resolves against the CURRENT binding context (e.g. the
//                row context inside a LineItem cell). This is what row-
//                level cell templates need.
//   %{path}    — resolves against the model ROOT (the OP-level model,
//                used for top-level Object Page state like header
//                IsActiveEntity in FE V4).
//
// In a `core:FragmentDefinition` used as a custom column template
// (`controlConfiguration: { columns: { ... template: "..." } }` in
// manifest.json), the fragment is rendered ONCE PER ROW with the row as
// its binding context. So row fields like `taskType` and the inherited
// `IsActiveEntity` MUST be referenced via `${...}`. Using `%{...}` causes
// UI5's expression engine to resolve the binding to undefined, collapsing
// the host expression to a default that often DISABLES the feature
// silently:
//
//   showValueHelp="{= %{taskType} !== 'CHECKPOINT' }"
//   → resolves to `{= undefined !== 'CHECKPOINT' }` which engine treats
//     as false → no F4 icon rendered
//
// SURFACED: 2026-06-22 issue #426. Mission's CompletionPath path-items
// table showed plain text input with no value-help icon. Fix flipped
// `%{}` → `${}` in app/admin/missions/webapp/ext/TaskColumn.fragment.xml.
//
// THIS TEST: scans every *.fragment.xml under app/admin/ and asserts no
// expression binding `{= ... %{IDENTIFIER} ... }` references a known
// row-context field. An exemption list lets us whitelist any future
// fragment that genuinely needs `%{}` for OP-level state (none today).
//
// Related: feedback_ui5_dollar_vs_percent_binding memory, #538 (categories
// admin same pattern latent), #539 (extend linter to catch inverse).
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

// Set of identifiers that are row-context fields (LineItem cell state).
// `%{...}` referencing any of these inside a `{= ... }` expression binding
// is almost certainly a misuse — these never refer to OP-level state.
const ROW_CONTEXT_IDENTIFIERS = new Set([
  'IsActiveEntity',
  'HasActiveEntity',
  'IsActiveDocument',
  'taskType',
  'taskName',
]);

// Optional whitelist for legitimate exemptions (e.g. an OP-header binding
// that intentionally reads model-root state). Empty today.
const EXEMPT_PATHS = new Set<string>([]);

function walkFragments(dir: string, out: string[] = []): string[] {
  for (const ent of readdirSync(dir)) {
    const p = join(dir, ent);
    const stat = statSync(p);
    if (stat.isDirectory()) walkFragments(p, out);
    else if (p.endsWith('.fragment.xml')) out.push(p);
  }
  return out;
}

interface Finding {
  file: string;
  line: number;
  identifier: string;
  snippet: string;
}

export function scanFragments(roots: string[]): Finding[] {
  const findings: Finding[] = [];
  // Match `%{IDENT}` inside any `{= ... }` expression binding context.
  // The outer context is required so we don't false-positive on regular
  // `{path:'%foo'}` (which never happens) or plain text content. A simple
  // approach: scan line-by-line; if a line contains `{=` and `%{IDENT}`,
  // flag it.
  for (const root of roots) {
    let files: string[];
    try { files = walkFragments(root); }
    catch { continue; }
    for (const f of files) {
      if (EXEMPT_PATHS.has(f)) continue;
      const src = readFileSync(f, 'utf8');
      const lines = src.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (!line.includes('{=')) continue;
        for (const ident of ROW_CONTEXT_IDENTIFIERS) {
          const needle = '%{' + ident + '}';
          if (line.includes(needle)) {
            findings.push({
              file: f, line: i + 1, identifier: ident, snippet: line.trim(),
            });
          }
        }
      }
    }
  }
  return findings;
}

describe('UI5 fragment binding-mode lint (#426 regression guard)', () => {
  it('no fragment under app/admin/ uses %{rowField} in {= ... } expression bindings', () => {
    const findings = scanFragments(['app/admin']);
    if (findings.length > 0) {
      const msg = findings.map(f =>
        `  ${f.file}:${f.line}\n    identifier: ${f.identifier}\n    snippet:    ${f.snippet}`
      ).join('\n');
      throw new Error(
        '\nFragment expression binding uses %{IDENT} where ${IDENT} is required.\n' +
        '\n' +
        'UI5 expression bindings inside FE V4 LineItem column templates render in ROW context.\n' +
        'Use ${field} to read row-cell values; %{field} resolves against the model root and\n' +
        'collapses to undefined inside a row cell, silently disabling the host expression.\n' +
        '\n' +
        'See: test/scripts/check-fragment-binding-mode.test.ts top-of-file comment.\n' +
        'Memory: feedback_ui5_dollar_vs_percent_binding.\n' +
        '\n' +
        'Offending lines:\n' + msg + '\n'
      );
    }
    expect(findings).toEqual([]);
  });
});
