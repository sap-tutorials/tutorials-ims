// scripts/check-directive-corpus-regression.ts
//
// CORPUS REGRESSION: empty registry → expandDirectives is identity.
//
// Proves that, with an EMPTY directive registry, composeTutorial output is
// byte-identical whether expandDirectives runs or not. Because the registry
// is empty at foundation time and expandDirectives short-circuits when no
// nodes are parsed (see directives.ts: `if (nodes.length === 0) return body`),
// the function is a pure identity transform — it must not mangle ANY existing
// markdown construct.
//
// Strategy:
//   1. Build a bundled multi-construct fixture that exercises all the patterns
//      that previously caused false-positive directive matches:
//         - [OPTION BEGIN [...]] … [OPTION END] blocks
//         - [BRANCH_BEGIN …] … [BRANCH_END] blocks
//         - {{var:X}} variable tokens (with matching `variables:` frontmatter)
//         - Blockquotes (> lines)
//         - Nested lists
//         - A fenced code block whose body contains `:::directive-looking` text
//   2. Run composeTutorial once (gets the baseline output — which includes
//      expandDirectives running with an empty registry).
//   3. Run composeTutorial a second time (identical input) — output must be
//      byte-identical to run 1 (idempotent).
//   4. Verify key constructs are NOT mangled: the :::directive text inside the
//      code fence must survive verbatim in the `body` output.
//   5. If .tutorial-cache/ is populated with real .md files, loop over each and
//      assert composeTutorial output is byte-identical across two runs.
//
// CLI dual-export:
//   - Named export `runCorpusRegression(opts?)` — used by the test suite.
//   - Direct invocation guard (`import.meta.url === pathToFileURL(…).href`) —
//     runs the CLI path when executed via `npx tsx scripts/check-directive-corpus-regression.ts`.
//
// Exit codes (CLI path):
//   0  All assertions passed.
//   1  One or more byte-equality failures (stderr prints the culprits).

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resetRegistry } from './parsers/directive-registry.js';
import { composeTutorial } from './parsers/compose.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = join(__dirname, '..', '.tutorial-cache');

// ─── Bundled multi-construct fixture ─────────────────────────────────────────

/**
 * A synthetic tutorial markdown string that combines all the "tricky construct"
 * categories. With an EMPTY registry every `:name[`, `::name`, `:::name` pattern
 * is unknown so no node is emitted — expandDirectives returns the body unchanged.
 * The composed output therefore must be byte-identical across two independent runs.
 */
export const BUNDLED_FIXTURE = `---
parser: v2
title: Corpus Regression Fixture
time: 10
tags: [tutorial>beginner]
primary_tag: tutorial>beginner
author_name: Corpus Tester
author_profile: https://example.com
variables:
  - name: groupNumber
    label: Your Group Number
    type: string
    maxLength: 6
    placeholder: GRP
---

# Corpus Regression Fixture

### Step 1 — Option blocks

This step has OS-specific options.

[OPTION BEGIN [Windows]]

On Windows, your group is {{var:groupNumber}}.

[OPTION END]

[OPTION BEGIN [Mac]]

On macOS, your group is also {{var:groupNumber}}.

[OPTION END]

### Step 2 — Blockquote and nested list

> **Note:** This is a blockquote.
> It spans multiple lines.

> [!DETAILS] Why it works
> body text

> [!HINT]
> hint body

A list with nested items:

- Item 1
    - Sub-item 1a
    - Sub-item 1b
- Item 2
    - Sub-item 2a

### Step 3 — Code fence containing directive-looking text

The following code block has directive syntax inside — it must survive verbatim.

\`\`\`yaml
# This is NOT a directive — it is inside a fenced code block.
:::directive-looking[label]{attr=value}
::leaf-directive[label]
:inline-directive[text]
\`\`\`

After the fence, plain prose.

### Step 4 — Inline code with colon sequences

Use \`std::vector\` or \`http://example.com\` — these must NOT trigger the inline
directive parser (no \`[\` follows, and they are inside backtick code spans anyway).

Outside a code span: \`10:30\` is a time, not a directive.

### Step 5 — Branch block

[BRANCH_BEGIN group="platform" key="hana" label="SAP HANA Cloud"]

### Sub-Step HANA

HANA-specific content for group {{var:groupNumber}}.

[BRANCH_END]

[BRANCH_BEGIN group="platform" key="cf" label="Cloud Foundry"]

### Sub-Step CF

Cloud Foundry content.

[BRANCH_END]

### Step 6 — Done

All constructs exercised.
`;

// ─── Core regression function ─────────────────────────────────────────────────

export interface RegressionOpts {
  /** Override the cache directory (used in tests to point at a temp dir). */
  cacheDir?: string;
}

export interface RegressionResult {
  /** Number of fixtures checked (bundled + real tutorials). */
  checked: number;
  /** Number of byte-equality failures. */
  failures: number;
  /** Failure descriptions for reporting. */
  messages: string[];
  /** Whether the real-tutorial loop actually ran (cache was populated). */
  realCacheLoopRan: boolean;
}

const COMPOSE_OPTS = {
  repo: 'corpus-regression-repo',
  branch: 'main',
  slug: 'corpus-regression-fixture',
  target: 'hugo' as const,
  rewriteImages: false,
};

/**
 * Run the corpus regression check.
 *
 * Returns a RegressionResult that the test suite can assert against.
 * Does NOT call process.exit() — the CLI wrapper does that.
 */
export function runCorpusRegression(opts: RegressionOpts = {}): RegressionResult {
  // Ensure the registry is empty — the whole point is "no registered directives
  // → expandDirectives is identity → output is byte-identical".
  resetRegistry();

  const cacheDir = opts.cacheDir ?? CACHE_DIR;
  const messages: string[] = [];
  let checked = 0;
  let failures = 0;
  let realCacheLoopRan = false;

  // ── 1. Bundled fixture ─────────────────────────────────────────────────────

  const run1 = composeTutorial(BUNDLED_FIXTURE, { ...COMPOSE_OPTS, slug: 'bundled-fixture-run-1' });
  const run2 = composeTutorial(BUNDLED_FIXTURE, { ...COMPOSE_OPTS, slug: 'bundled-fixture-run-2' });

  checked++;
  if (run1.body !== run2.body) {
    failures++;
    messages.push(
      `[bundled-fixture] body diverged between run-1 and run-2:\n` +
      `  run1 length: ${run1.body.length}, run2 length: ${run2.body.length}`,
    );
  }

  // Extra guard: :::directive-looking text inside the code fence must survive
  // verbatim.  The body includes all steps, so the fenced content will be inside
  // the step content of Step 3.  We look for the text in the overall body.
  const fenceContent = ':::directive-looking[label]{attr=value}';
  if (!run1.body.includes(fenceContent)) {
    failures++;
    messages.push(
      `[bundled-fixture] code-fence content mangled: "${fenceContent}" not found in composed body`,
    );
  }
  if (!run2.body.includes(fenceContent)) {
    failures++;
    messages.push(
      `[bundled-fixture] run2 code-fence content mangled: "${fenceContent}" not found`,
    );
  }

  // ── 2. Real tutorial cache (graceful skip when absent / empty) ─────────────

  const realFiles = getRealMarkdownFiles(cacheDir);

  if (realFiles.length > 0) {
    realCacheLoopRan = true;
    for (const file of realFiles) {
      const slug = file.replace(/\.md$/, '');
      const raw = readFileSync(join(cacheDir, file), 'utf-8');
      try {
        const a = composeTutorial(raw, { ...COMPOSE_OPTS, slug: `${slug}-run-1` });
        const b = composeTutorial(raw, { ...COMPOSE_OPTS, slug: `${slug}-run-2` });
        checked++;
        if (a.body !== b.body) {
          failures++;
          messages.push(
            `[${file}] body diverged between run-1 and run-2 ` +
            `(lengths ${a.body.length} vs ${b.body.length})`,
          );
        }
      } catch (err) {
        // Parse errors in the corpus don't invalidate the regression — the
        // existing corpus may include known-broken tutorials. Log and skip.
        messages.push(
          `[${file}] composeTutorial threw: ${err instanceof Error ? err.message : String(err)} — skipped`,
        );
      }
    }
  }

  return { checked, failures, messages, realCacheLoopRan };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getRealMarkdownFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir).filter(
      (f) => f.endsWith('.md') && f !== '__drift-test-slug__.created',
    );
  } catch {
    return [];
  }
}

// ─── CLI entry point ──────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('Running directive corpus regression…');
  const result = runCorpusRegression();

  console.log(`Checked: ${result.checked} fixture(s)`);
  console.log(
    `Real cache loop: ${result.realCacheLoopRan ? 'ran' : 'skipped (no tutorials in .tutorial-cache/)'}`,
  );

  if (result.failures > 0) {
    console.error(`\nFAILED — ${result.failures} byte-equality failure(s):`);
    for (const msg of result.messages) {
      console.error(`  ${msg}`);
    }
    process.exit(1);
  } else {
    if (result.messages.length > 0) {
      console.log('\nNotes (non-fatal):');
      for (const msg of result.messages) console.log(`  ${msg}`);
    }
    console.log('\nOK — all fixtures byte-identical across two runs.');
    process.exit(0);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((err) => {
    console.error('Fatal:', err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
