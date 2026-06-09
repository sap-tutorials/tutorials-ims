# Issue #173 — OS-conditional content with AI-assisted authoring — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a global OS toggle (Windows/macOS/Linux/BAS) that drives every OS-conditional block on a tutorial page, plus a stable `POST /author/generateOsVariants` API the VS Code authoring plugin uses to AI-generate missing OS variants.

**Architecture:** Three layers with strict boundaries.
1. **Build pipeline** — `scripts/parsers/os-classifier.ts` fuzzy-matches author tab labels against a curated dictionary; OS groups emit a new `{{< os-options >}}` shortcode. Author override via `osOverrides:` frontmatter.
2. **Hugo runtime** — picker as a `ui5-segmented-button` at the top of the OP, `os-toggle.ts` activates panels via `data-os-active` attribute, persists via `localStorage`. Mirrors the `codetabs.ts` pattern.
3. **Authoring API** — `POST /author/generateOsVariants` action on the existing `AuthorService` (already gated on `Tutorial.Author` scope). Calls SAP Gen AI Hub via `OrchestrationClient.chatCompletion`. Persists request + response to a new `AuthorAiRequests` entity for future eval.

**Tech Stack:** TypeScript (build + Hugo JS), Hugo shortcodes, UI5 Web Components, CAP Node.js, `@sap-ai-sdk/orchestration`, Vitest.

**Spec:** [docs/superpowers/specs/2026-06-09-173-os-conditional-content-design.md](../specs/2026-06-09-173-os-conditional-content-design.md)

**Branch:** `feat/173-os-conditional-content` (already created with the spec commit)

**Cross-cutting reminders for every task:**
- Verify line endings with `file <path>` after multi-section edits — see [[feedback_crlf_regression_on_windows]]
- Always run `git branch --show-current` in the same Bash invocation as `git commit` — see [[feedback_verify_branch_before_commit]]
- All commits go to `feat/173-os-conditional-content` until explicitly merged

---

## Phase 1 — Build pipeline (Tasks 1-3)

### Task 1: `os-classifier.ts` — pure label-matching module

**Files:**
- Create: `scripts/parsers/os-classifier.ts`
- Test: `scripts/__tests__/os-classifier.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// scripts/__tests__/os-classifier.test.ts
import { describe, expect, it } from 'vitest';
import { classifyTab, classifyGroup, OS_VALUES } from '../parsers/os-classifier';

describe('classifyTab — single-label canonicalization', () => {
  it.each([
    ['Windows', ['Windows']],
    ['windows', ['Windows']],
    ['Win', ['Windows']],
    ['Win32', ['Windows']],
    ['macOS', ['macOS']],
    ['Mac OS', ['macOS']],
    ['Mac', ['macOS']],
    ['OS X', ['macOS']],
    ['darwin', ['macOS']],
    ['Linux', ['Linux']],
    ['Ubuntu', ['Linux']],
    ['BAS', ['BAS']],
    ['Business Application Studio', ['BAS']],
    ['SAP BAS', ['BAS']],
  ])('classifies %s as %j', (label, expected) => {
    expect(classifyTab(label)).toEqual(expected);
  });

  it.each([
    ['Mac and Linux',     ['macOS', 'Linux']],
    ['Mac & Linux',       ['macOS', 'Linux']],
    ['MacOS / Linux',     ['macOS', 'Linux']],
    ['Linux & MacOS',     ['Linux', 'macOS']],
    ['MacOS and Linux',   ['macOS', 'Linux']],
    ['Linux and Mac OS',  ['Linux', 'macOS']],
  ])('classifies combined label %s as %j', (label, expected) => {
    expect(classifyTab(label)).toEqual(expected);
  });

  it.each([
    'Cloud',
    'On-premise',
    'JSON',
    'XML',
    'Java',
    'Node.js',
    'SAP S/4HANA Cloud, ABAP Environment',
    'Create Individual Employee Record',
  ])('returns null for non-OS label %s', (label) => {
    expect(classifyTab(label)).toBeNull();
  });
});

describe('classifyGroup — group-level classification', () => {
  it('classifies all-OS group as os', () => {
    const r = classifyGroup(['Windows', 'Mac and Linux']);
    expect(r.kind).toBe('os');
    expect(r.assignments.get('Windows')).toEqual(['Windows']);
    expect(r.assignments.get('Mac and Linux')).toEqual(['macOS', 'Linux']);
  });

  it('returns regular when any tab is non-OS', () => {
    const r = classifyGroup(['Windows', 'Cloud']);
    expect(r.kind).toBe('regular');
    expect(r.assignments.size).toBe(0);
  });

  it('returns regular when only one canonical OS is covered (single-OS sanity)', () => {
    const r = classifyGroup(['Windows']);
    expect(r.kind).toBe('regular');
  });

  it('classifies as os when 2+ canonical OSes covered via combined labels', () => {
    const r = classifyGroup(['Windows', 'Mac and Linux']);
    expect(r.kind).toBe('os');
  });
});

describe('OS_VALUES constant', () => {
  it('exports the four canonical OS values in fixed order', () => {
    expect(OS_VALUES).toEqual(['Windows', 'macOS', 'Linux', 'BAS']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run scripts/__tests__/os-classifier.test.ts
```

Expected: FAIL with "Cannot find module '../parsers/os-classifier'".

- [ ] **Step 3: Write minimal implementation**

```ts
// scripts/parsers/os-classifier.ts

export const OS_VALUES = ['Windows', 'macOS', 'Linux', 'BAS'] as const;
export type OS = typeof OS_VALUES[number];

// Order matters — multi-OS labels must match before single-OS labels.
const RULES: Array<{ pattern: RegExp; oses: OS[] }> = [
  { pattern: /^(mac\s*(?:os)?|os\s*x)\s*(?:and|&|\/|,)\s*linux$/i,        oses: ['macOS', 'Linux'] },
  { pattern: /^linux\s*(?:and|&|\/|,)\s*(?:mac\s*(?:os)?|os\s*x)$/i,      oses: ['Linux', 'macOS'] },
  { pattern: /^(?:windows|win)\s*(?:and|&|\/|,)\s*(?:mac\s*(?:os)?|linux)$/i, oses: ['Windows', 'macOS', 'Linux'] },
  { pattern: /^(?:mac\s*os|macos|mac|os\s*x|darwin)$/i,                    oses: ['macOS'] },
  { pattern: /^(?:windows|win|win32|win64)$/i,                             oses: ['Windows'] },
  { pattern: /^(?:linux|ubuntu|debian|fedora|unix)$/i,                     oses: ['Linux'] },
  { pattern: /^(?:bas|business\s*application\s*studio|sap\s*bas)$/i,       oses: ['BAS'] },
];

export interface ClassifyResult {
  kind: 'os' | 'regular';
  /** Source tab label → list of canonical OSes that label maps to. */
  assignments: Map<string, OS[]>;
}

export function classifyTab(label: string): OS[] | null {
  const trimmed = label.trim();
  for (const rule of RULES) {
    if (rule.pattern.test(trimmed)) return [...rule.oses];
  }
  return null;
}

export function classifyGroup(labels: string[]): ClassifyResult {
  const assignments = new Map<string, OS[]>();
  for (const label of labels) {
    const oses = classifyTab(label);
    if (!oses) return { kind: 'regular', assignments: new Map() };
    assignments.set(label, oses);
  }
  // Sanity: at least 2 distinct canonical OSes covered. A lone "[Windows]"
  // block with no peer doesn't deserve a global picker.
  const distinct = new Set([...assignments.values()].flat());
  if (distinct.size < 2) return { kind: 'regular', assignments: new Map() };
  return { kind: 'os', assignments };
}

/**
 * Force-classify when an author override marks a group as `os`. Skips the
 * sanity rejection that `classifyGroup` enforces, but still rejects labels
 * that don't match any rule (returns kind: 'regular' if any label fails to
 * classify — author override can override the heuristic but cannot invent
 * OS semantics for unrecognized labels).
 */
export function forceClassify(labels: string[]): ClassifyResult {
  const assignments = new Map<string, OS[]>();
  for (const label of labels) {
    const oses = classifyTab(label);
    if (!oses) return { kind: 'regular', assignments: new Map() };
    assignments.set(label, oses);
  }
  return { kind: 'os', assignments };
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npx vitest run scripts/__tests__/os-classifier.test.ts
```

Expected: PASS, all cases green.

- [ ] **Step 5: Verify line endings**

```bash
file scripts/parsers/os-classifier.ts scripts/__tests__/os-classifier.test.ts
```

Expected: no "CRLF line terminators" callout.

- [ ] **Step 6: Commit**

```bash
git branch --show-current  # must show feat/173-os-conditional-content
git add scripts/parsers/os-classifier.ts scripts/__tests__/os-classifier.test.ts
git commit -m "feat(173): add os-classifier — fuzzy-match OS option labels

Canonicalizes the messy real-world OS labels in tutorial OPTION blocks
(Windows/Win, Mac OS/MacOS/Mac/OS X/Darwin, Linux/Ubuntu, BAS/Business
Application Studio) into the four canonical values Windows/macOS/Linux/BAS.

Combined labels like 'Mac and Linux' map to multiple canonical OSes; the
emitter (Task 2) uses this to produce one panel per canonical OS.

classifyGroup() rejects groups containing any non-OS tab (so Cloud/On-premise
and Java/Node.js groups stay as regular option-tabs). forceClassify() is the
escape hatch for the osOverrides frontmatter (Task 3).

Tests cover every distinct OS-shaped label currently in .tutorial-cache/
plus negatives. Spec §3.1."
```

---

### Task 2: Wire classifier into `options.ts` emitter

**Files:**
- Modify: `scripts/parsers/options.ts`
- Test: `scripts/__tests__/options-hugo.test.ts` (extend existing)

**Background:** `scripts/parsers/options.ts` today emits `{{% option-tabs %}}` for every detected OPTION group. We extend it to consult the classifier and emit a new `{{< os-options >}}` shortcode for OS groups while leaving the existing path untouched for non-OS groups.

- [ ] **Step 1: Read existing emitter to understand structure**

Read [scripts/parsers/options.ts](../../../scripts/parsers/options.ts) (only ~66 lines). Note: `convertOptionBlocks` accepts `target: 'vitepress' | 'hugo'`; we change only the `target === 'hugo'` branch.

- [ ] **Step 2: Write the failing test**

Append to `scripts/__tests__/options-hugo.test.ts`:

```ts
import { convertOptionBlocks } from '../parsers/options';

describe('convertOptionBlocks (hugo) — OS groups', () => {
  it('emits os-options shortcode for an OS-shaped group', () => {
    const input = `[OPTION BEGIN [Windows]]
PowerShell stuff
[OPTION END]

[OPTION BEGIN [Mac and Linux]]
bash stuff
[OPTION END]
`;
    const out = convertOptionBlocks(input, 'hugo');
    expect(out).toContain('{{< os-options >}}');
    expect(out).toContain('{{< os-panel os="Windows" >}}');
    expect(out).toContain('{{< os-panel os="macOS" >}}');
    expect(out).toContain('{{< os-panel os="Linux" >}}');
    expect(out).toContain('{{< /os-options >}}');
    expect(out).not.toContain('option-tabs'); // OS group does NOT use the legacy shortcode
  });

  it('combined-label group duplicates body across canonical OSes', () => {
    const input = `[OPTION BEGIN [Windows]]
WIN_BODY
[OPTION END]

[OPTION BEGIN [Mac and Linux]]
NIX_BODY
[OPTION END]
`;
    const out = convertOptionBlocks(input, 'hugo');
    // macOS and Linux both get the same NIX_BODY content
    expect(out.match(/NIX_BODY/g)?.length).toBe(2);
    expect(out.match(/WIN_BODY/g)?.length).toBe(1);
  });

  it('keeps non-OS groups on the legacy option-tabs shortcode', () => {
    const input = `[OPTION BEGIN [JSON]]
json stuff
[OPTION END]

[OPTION BEGIN [XML]]
xml stuff
[OPTION END]
`;
    const out = convertOptionBlocks(input, 'hugo');
    expect(out).toContain('option-tabs');
    expect(out).not.toContain('os-options');
  });

  it('mixed page: one OS group + one non-OS group → both shortcodes coexist', () => {
    const input = `[OPTION BEGIN [Windows]]
W
[OPTION END]

[OPTION BEGIN [Mac and Linux]]
ML
[OPTION END]

Some prose between groups.

[OPTION BEGIN [JSON]]
J
[OPTION END]

[OPTION BEGIN [XML]]
X
[OPTION END]
`;
    const out = convertOptionBlocks(input, 'hugo');
    expect(out).toContain('os-options');
    expect(out).toContain('option-tabs');
  });

  it('single-OS group (Windows alone, no peer) stays as legacy option-tabs', () => {
    const input = `[OPTION BEGIN [Windows]]
only windows
[OPTION END]
`;
    const out = convertOptionBlocks(input, 'hugo');
    expect(out).toContain('option-tabs');
    expect(out).not.toContain('os-options');
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

```bash
npx vitest run scripts/__tests__/options-hugo.test.ts
```

Expected: FAIL — output still uses `option-tabs` for OS groups.

- [ ] **Step 4: Implement the OS branch in `options.ts`**

Replace the Hugo replacement block. Full file diff (replacing the existing function body, NOT the function signature or VitePress branch):

```ts
import { classifyGroup, forceClassify, type OS, type ClassifyResult } from './os-classifier';

interface OptionEntry {
  matchIndex: number
  tabName: string
  content: string
}

export type OptionsTarget = 'vitepress' | 'hugo'

/**
 * Optional override map: { stepSlug: 'os' | 'regular' }.
 * Caller (fetch-tutorials.ts) is responsible for slugifying the step heading
 * and passing the matching key when present. Task 3 wires this through.
 */
export interface ConvertOptions {
  /** Step slug for the current step being processed. */
  stepSlug?: string;
  /** Per-step overrides keyed by step slug. */
  osOverrides?: Record<string, 'os' | 'regular'>;
  /** Out-param: set to true if any OS group was emitted (frontmatter side-effect). */
  hasOsOptionsOut?: { value: boolean };
}

export function convertOptionBlocks(
  content: string,
  target: OptionsTarget = 'vitepress',
  opts: ConvertOptions = {}
): string {
  const optionPattern = /\[OPTION BEGIN \[([^\]]+)\]\]\s*\n([\s\S]*?)\[OPTION END\]/g

  const matches = [...content.matchAll(optionPattern)]
  if (matches.length === 0) return content

  const groups: OptionEntry[][] = []
  let currentGroup: OptionEntry[] = []

  for (let i = 0; i < matches.length; i++) {
    const entry: OptionEntry = {
      matchIndex: i,
      tabName: matches[i][1],
      content: matches[i][2].trim(),
    }
    if (currentGroup.length > 0) {
      const prevMatch = matches[i - 1]
      const prevEnd = prevMatch.index! + prevMatch[0].length
      const gap = content.slice(prevEnd, matches[i].index!).trim()
      if (gap.length > 0) {
        groups.push(currentGroup)
        currentGroup = []
      }
    }
    currentGroup.push(entry)
  }
  if (currentGroup.length > 0) groups.push(currentGroup)

  let result = content
  for (const group of groups.reverse()) {
    const firstMatch = matches[group[0].matchIndex]
    const lastMatch = matches[group[group.length - 1].matchIndex]
    const start = firstMatch.index!
    const end = lastMatch.index! + lastMatch[0].length

    let replacement: string

    if (target === 'hugo') {
      const labels = group.map(g => g.tabName);
      const override = opts.stepSlug ? opts.osOverrides?.[opts.stepSlug] : undefined;

      const decision: ClassifyResult =
        override === 'regular' ? { kind: 'regular', assignments: new Map() } :
        override === 'os'      ? forceClassify(labels) :
                                  classifyGroup(labels);

      if (decision.kind === 'os') {
        if (opts.hasOsOptionsOut) opts.hasOsOptionsOut.value = true;
        // Emit one os-panel per CANONICAL OS — combined labels duplicate content.
        const panels: string[] = [];
        for (const entry of group) {
          const oses = decision.assignments.get(entry.tabName)!;
          for (const os of oses) {
            panels.push(`{{< os-panel os="${os}" >}}\n\n${entry.content}\n\n{{< /os-panel >}}`);
          }
        }
        replacement = `{{< os-options >}}\n${panels.join('\n')}\n{{< /os-options >}}`;
      } else {
        // Existing legacy path — option-tabs shortcode.
        const tabNames = group.map(b => b.tabName).join(',')
        const tabs = group.map((b, i) =>
          `{{% tab index="${i}" name="${b.tabName}" %}}\n\n${b.content}\n\n{{% /tab %}}`
        ).join('\n')
        replacement = `{{% option-tabs tabs="${tabNames}" %}}\n${tabs}\n{{% /option-tabs %}}`;
      }
    } else {
      // VitePress branch unchanged.
      const tabNames = group.map(b => `'${b.tabName}'`).join(',')
      const slots = group.map((b, i) =>
        `<template #tab-${i}>\n\n${b.content}\n\n</template>`
      ).join('\n')
      replacement = `<OptionTabs :tabs="[${tabNames}]">\n${slots}\n</OptionTabs>`
    }

    result = result.slice(0, start) + replacement + result.slice(end)
  }

  return result
}
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
npx vitest run scripts/__tests__/options-hugo.test.ts scripts/__tests__/os-classifier.test.ts
```

Expected: PASS, all cases.

- [ ] **Step 6: Run the full unit suite to confirm no regressions**

```bash
npm test -- --run scripts/
```

Expected: All scripts/ tests green. (The full `npm test` may hang on this Windows worktree — see [[feedback_worktree_tests_hang]]; scope to scripts/ to keep it fast.)

- [ ] **Step 7: Commit**

```bash
git branch --show-current
git add scripts/parsers/options.ts scripts/__tests__/options-hugo.test.ts
git commit -m "feat(173): emit os-options shortcode for OS-flavored option groups

When the Hugo target is active and every tab in an option group fuzzy-matches
an OS label (Task 1), emit the new os-options/os-panel shortcode pair instead
of option-tabs. Combined labels (Mac and Linux) produce one panel per canonical
OS sharing the same body.

Non-OS groups (Cloud/On-premise, Java/Node.js, JSON/XML) stay on the legacy
option-tabs shortcode — fully backward compatible.

The new ConvertOptions accepts a stepSlug + osOverrides map for the author-
override path; Task 3 wires that through fetch-tutorials.ts. The
hasOsOptionsOut out-param signals whether any OS group was emitted on this
page so the page layout (Task 5) can conditionally inject the picker.

Spec §3.3."
```

---

### Task 3: Wire `osOverrides` frontmatter + `hasOsOptions` page flag through `compose.ts` and `fetch-tutorials.ts`

**Files:**
- Modify: `scripts/parsers/options.ts` (refine — resolve step slug internally)
- Modify: `scripts/parsers/compose.ts`
- Modify: `scripts/fetch-tutorials.ts`
- Modify: `scripts/parsers/types.ts` (add `osOverrides` to `TutorialFrontmatter`)
- Test: `scripts/__tests__/options-hugo.test.ts` (extend)

**Background — pipeline ordering insight:** `convertOptionBlocks` runs in [scripts/parsers/compose.ts](../../../scripts/parsers/compose.ts) BEFORE step parsing. To resolve which step's slug an OPTION block lives under, we scan the body for the most-recent `^### ` H3 heading preceding the match's index and slugify it. This avoids reordering the pipeline.

- [ ] **Step 1: Add slug-from-prior-heading resolution to `options.ts`**

Update the `ConvertOptions` interface and resolve slugs internally:

```ts
// scripts/parsers/options.ts (refinement on top of Task 2)

export interface ConvertOptions {
  /** Per-step overrides keyed by slugified step heading. */
  osOverrides?: Record<string, 'os' | 'regular'>;
  /** Out-param: set true if any OS group was emitted. */
  hasOsOptionsOut?: { value: boolean };
}

function slugifyHeading(text: string): string {
  return text.trim().toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** Find the slugified ### heading immediately preceding `index` in `content`. */
function priorStepSlug(content: string, index: number): string | undefined {
  const before = content.slice(0, index);
  const re = /^###\s+(.+?)\s*$/gm;
  let last: RegExpExecArray | null = null;
  let m: RegExpExecArray | null;
  while ((m = re.exec(before)) !== null) last = m;
  return last ? slugifyHeading(last[1]) : undefined;
}
```

In the Hugo branch, replace the `opts.stepSlug` lookup with:

```ts
const stepSlug = priorStepSlug(content, firstMatch.index!);
const override = stepSlug ? opts.osOverrides?.[stepSlug] : undefined;
```

Drop `stepSlug` from `ConvertOptions` (no longer caller-supplied).

- [ ] **Step 2: Write the failing test for override behavior**

Append to `scripts/__tests__/options-hugo.test.ts`:

```ts
describe('convertOptionBlocks (hugo) — osOverrides', () => {
  it('respects osOverrides: regular to demote a heuristic-OS group', () => {
    const input = `### My Step

[OPTION BEGIN [Windows]]
W
[OPTION END]

[OPTION BEGIN [Mac and Linux]]
ML
[OPTION END]
`;
    const out = convertOptionBlocks(input, 'hugo', {
      osOverrides: { 'my-step': 'regular' },
    });
    expect(out).toContain('option-tabs');
    expect(out).not.toContain('os-options');
  });

  it('respects osOverrides: os to promote an unrecognized-as-OS group', () => {
    const input = `### Solo Step

[OPTION BEGIN [Windows]]
W
[OPTION END]
`;
    const out = convertOptionBlocks(input, 'hugo', {
      osOverrides: { 'solo-step': 'os' },
    });
    expect(out).toContain('os-options');
    expect(out).toContain('os-panel os="Windows"');
  });

  it('hasOsOptionsOut out-param flips when any OS group is emitted', () => {
    const input = `[OPTION BEGIN [Windows]]
W
[OPTION END]

[OPTION BEGIN [Mac and Linux]]
ML
[OPTION END]
`;
    const flag = { value: false };
    convertOptionBlocks(input, 'hugo', { hasOsOptionsOut: flag });
    expect(flag.value).toBe(true);
  });

  it('hasOsOptionsOut stays false when only non-OS groups are emitted', () => {
    const input = `[OPTION BEGIN [JSON]]
J
[OPTION END]

[OPTION BEGIN [XML]]
X
[OPTION END]
`;
    const flag = { value: false };
    convertOptionBlocks(input, 'hugo', { hasOsOptionsOut: flag });
    expect(flag.value).toBe(false);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

```bash
npx vitest run scripts/__tests__/options-hugo.test.ts
```

Expected: FAIL — overrides not yet honored OR `hasOsOptionsOut` not set.

- [ ] **Step 4: Apply the refinement to `options.ts`** (see Step 1 code)

- [ ] **Step 5: Run test to verify it passes**

```bash
npx vitest run scripts/__tests__/options-hugo.test.ts
```

Expected: PASS.

- [ ] **Step 6: Pass overrides through `compose.ts`**

```ts
// scripts/parsers/compose.ts
export interface ComposeResult {
  // ... existing fields
  hasOsOptions: boolean;
}

export function composeTutorial(rawMd: string, opts: ComposeOpts): ComposeResult {
  const { title, description, youWillLearn, prerequisites, level, frontmatter, body } =
    extractFrontmatter(rawMd)

  const isV2 = frontmatter.parser === 'v2'
  let processedBody = resolveImageURLs(body, {
    repo: opts.repo, branch: opts.branch, slug: opts.slug,
    rewriteImages: opts.rewriteImages,
  })

  const hasOsOptionsFlag = { value: false };
  processedBody = convertOptionBlocks(processedBody, opts.target, {
    osOverrides: frontmatter.osOverrides,
    hasOsOptionsOut: hasOsOptionsFlag,
  });

  processedBody = processedBody.replace(/^<{4,7} .+\n[\s\S]*?^={4,7}\n([\s\S]*?)^>{4,7} .+\n?/gm, '$1')
  const steps = isV2 ? parseV2Steps(processedBody) : parseV1Steps(processedBody)

  return {
    title, description, youWillLearn, prerequisites, level, frontmatter, steps,
    body: processedBody,
    hasOsOptions: hasOsOptionsFlag.value,
  };
}
```

- [ ] **Step 7: Update `TutorialFrontmatter` type**

```ts
// scripts/parsers/types.ts — add to TutorialFrontmatter
osOverrides?: Record<string, 'os' | 'regular'>;
```

- [ ] **Step 8: Inject `hasOsOptions` into the Hugo page frontmatter**

In `scripts/fetch-tutorials.ts`, find the existing `fm` object that gets serialized via `yamlStringify`. Add (using `composed.hasOsOptions` from the `composeTutorial(...)` result):

```ts
if (composed.hasOsOptions) {
  fm.hasOsOptions = true;
}
```

- [ ] **Step 9: Run unit suite for scripts/**

```bash
npx vitest run scripts/__tests__/
```

Expected: All scripts tests green.

- [ ] **Step 10: Commit**

```bash
git branch --show-current
git add scripts/parsers/options.ts scripts/parsers/compose.ts scripts/parsers/types.ts \
        scripts/fetch-tutorials.ts scripts/__tests__/options-hugo.test.ts
git commit -m "feat(173): wire osOverrides frontmatter + hasOsOptions page flag

Resolves the step slug for each OPTION group by scanning back to the most-
recent ### heading at conversion time (compose.ts runs before step parsing,
so we can't rely on the parsed step list). Author override via:

  osOverrides:
    step-slug: os | regular

flows through ComposeOpts -> convertOptionBlocks. The hasOsOptionsOut
out-param bubbles up to ComposeResult.hasOsOptions, which fetch-tutorials.ts
injects into Hugo page frontmatter so layouts (Task 5) can conditionally
render the picker.

Spec §3.2-3.3."
```

---

## Phase 2 — Hugo runtime (Tasks 4-8)

### Task 4: New Hugo shortcodes (`os-options.html`, `os-panel.html`)

**Files:**
- Create: `hugo/layouts/shortcodes/os-options.html`
- Create: `hugo/layouts/shortcodes/os-panel.html`

- [ ] **Step 1: Create `os-options.html`**

```html
{{/*
  OS-conditional group wrapper. Renders all panels by default (no-JS fallback).
  os-toggle.ts adds [data-os-options-hydrated] on mount; CSS scoped to the
  hydrated wrapper hides non-active panels via the data-os-active attribute.
*/}}
<div class="os-options" data-os-options>
  {{ .Inner }}
</div>
```

- [ ] **Step 2: Create `os-panel.html`**

```html
{{ $os := .Get "os" }}
<div class="os-panel" data-os="{{ $os }}">
  {{ .Inner }}
</div>
```

- [ ] **Step 3: Verify Hugo renders without errors**

Run a one-shot Hugo build and inspect the generated HTML for a known OS-tabbed tutorial:

```bash
npm run fetch-tutorials
npx hugo --source hugo --destination public-test --quiet
grep -E 'os-options|os-panel' hugo/public-test/tutorials/btp-cli-setup-kyma-cluster/index.html | head
rm -rf hugo/public-test
```

Expected: HTML contains `class="os-options"` and `class="os-panel"` divs.

- [ ] **Step 4: Commit**

```bash
git branch --show-current
git add hugo/layouts/shortcodes/os-options.html hugo/layouts/shortcodes/os-panel.html
git commit -m "feat(173): add os-options + os-panel Hugo shortcodes

Static panel renderer for OS-conditional content. The wrapper div carries
data-os-options for JS hydration; each panel carries data-os=<canonical>
for the toggle (Task 6) to activate via data-os-active. No-JS fallback
shows all panels stacked.

Spec §4.1."
```

---

### Task 5: Object Page picker injection + CSS

**Files:**
- Modify: `hugo/layouts/tutorials/u1-object-page.html`
- Create: `hugo/assets/css/os-toggle.css`
- Modify: existing main CSS bundle (find via `grep -l 'codetabs.css\|@import' hugo/assets/css/*.css`)

- [ ] **Step 1: Locate the OP layout's pre-step injection point**

```bash
grep -n "step-list\|class=\"steps\"\|range \.Params\|TutorialStep" hugo/layouts/tutorials/u1-object-page.html | head
```

Identify the line just BEFORE the step list begins.

- [ ] **Step 2: Inject the picker template gated on `hasOsOptions`**

```html
{{ if .Params.hasOsOptions }}
<div class="os-picker" data-os-picker>
  <ui5-segmented-button accessible-name="Operating system">
    <ui5-segmented-button-item data-os="Windows">Windows</ui5-segmented-button-item>
    <ui5-segmented-button-item data-os="macOS">macOS</ui5-segmented-button-item>
    <ui5-segmented-button-item data-os="Linux">Linux</ui5-segmented-button-item>
    <ui5-segmented-button-item data-os="BAS">BAS</ui5-segmented-button-item>
  </ui5-segmented-button>
</div>
{{ end }}
```

- [ ] **Step 3: Create `os-toggle.css`**

```css
/* hugo/assets/css/os-toggle.css
   Scoped to [data-os-options-hydrated] so the no-JS fallback (all panels
   visible) survives if os-toggle.ts fails to mount. */
.os-picker {
  margin: 1rem 0 1.5rem;
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.os-options[data-os-options-hydrated] .os-panel[data-os] {
  display: none;
}

.os-options[data-os-options-hydrated] .os-panel[data-os][data-os-active] {
  display: block;
}

.os-options ui5-message-strip {
  margin-bottom: 0.75rem;
}
```

- [ ] **Step 4: Wire `os-toggle.css` into the main CSS bundle**

Inspect the existing main CSS file (find via the grep in Files above) and add an `@import './os-toggle.css';` line following the existing import convention.

- [ ] **Step 5: Verify picker renders for OS tutorials and is absent for non-OS ones**

```bash
npm run fetch-tutorials
npx hugo --source hugo --destination public-test --quiet
grep -c 'os-picker' hugo/public-test/tutorials/btp-cli-setup-kyma-cluster/index.html  # expect: >= 1
grep -c 'os-picker' hugo/public-test/tutorials/cap-getting-started/index.html         # expect: 0
rm -rf hugo/public-test
```

- [ ] **Step 6: Commit**

```bash
git branch --show-current
git add hugo/layouts/tutorials/u1-object-page.html hugo/assets/css/os-toggle.css hugo/assets/css/main.css
git commit -m "feat(173): inject OS picker on tutorials with hasOsOptions

UI5 segmented-button with the four canonical OSes (Windows/macOS/Linux/BAS),
rendered inline at the top of the Object Page only when the page frontmatter
flags hasOsOptions. CSS scopes the panel show/hide to the hydrated wrapper
so a JS-off reader sees all panels stacked (honest fallback).

Spec §4.2, §4.4."
```

---

### Task 6: `os-toggle.ts` runtime (detect, activate, persist)

**Files:**
- Create: `hugo/assets/js/os-toggle.ts`
- Create: `hugo/assets/js/__tests__/os-toggle.test.ts`

**Background:** Modeled on [hugo/assets/js/codetabs.ts](../../../hugo/assets/js/codetabs.ts) — same listen-for-change + apply-to-every-group + cross-tab-sync pattern. The OS variant adds: default-OS detection, fallback chain (Task 7), and the `data-os-options-hydrated` flip that gates the CSS hide rule.

- [ ] **Step 1: Write the failing test (jsdom)**

Use `createElement` + `appendChild` for fixture construction (avoid the JS DOM HTML-write property — hook rule, see [[feedback_html_property_blocked_by_hook]]).

```ts
// hugo/assets/js/__tests__/os-toggle.test.ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { __test__ } from '../os-toggle';

const { detectDefaultOs, activate, OS_VALUES } = __test__;

function buildOsOptions(panels: Array<{ os: string; body: string }>): HTMLElement {
  const wrapper = document.createElement('div');
  wrapper.className = 'os-options';
  wrapper.setAttribute('data-os-options', '');
  for (const p of panels) {
    const el = document.createElement('div');
    el.className = 'os-panel';
    el.setAttribute('data-os', p.os);
    el.textContent = p.body;
    wrapper.appendChild(el);
  }
  return wrapper;
}

function resetBody() {
  while (document.body.firstChild) document.body.removeChild(document.body.firstChild);
}

describe('detectDefaultOs', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('returns the localStorage preference when set', () => {
    localStorage.setItem('os-preference', 'macOS');
    expect(detectDefaultOs()).toBe('macOS');
  });

  it('returns Windows from userAgent when no preference', () => {
    Object.defineProperty(navigator, 'userAgent', { value: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', configurable: true });
    expect(detectDefaultOs()).toBe('Windows');
  });

  it('returns macOS from userAgent', () => {
    Object.defineProperty(navigator, 'userAgent', { value: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', configurable: true });
    expect(detectDefaultOs()).toBe('macOS');
  });

  it('returns Linux from userAgent', () => {
    Object.defineProperty(navigator, 'userAgent', { value: 'Mozilla/5.0 (X11; Linux x86_64)', configurable: true });
    expect(detectDefaultOs()).toBe('Linux');
  });

  it('returns BAS when document.referrer matches BAS host', () => {
    Object.defineProperty(document, 'referrer', { value: 'https://my-org.applicationstudio.cloud.sap/', configurable: true });
    expect(detectDefaultOs()).toBe('BAS');
  });

  it('falls back to Windows when nothing matches', () => {
    Object.defineProperty(navigator, 'userAgent', { value: '', configurable: true });
    Object.defineProperty(document, 'referrer', { value: '', configurable: true });
    expect(detectDefaultOs()).toBe('Windows');
  });
});

describe('activate', () => {
  beforeEach(() => {
    resetBody();
    document.body.appendChild(buildOsOptions([
      { os: 'Windows', body: 'W' },
      { os: 'macOS',   body: 'M' },
      { os: 'Linux',   body: 'L' },
    ]));
  });

  it('sets data-os-options-hydrated on the wrapper', () => {
    activate('Windows');
    const wrapper = document.querySelector('[data-os-options]');
    expect(wrapper?.hasAttribute('data-os-options-hydrated')).toBe(true);
  });

  it('flags only the matching panel with data-os-active', () => {
    activate('macOS');
    const active = document.querySelectorAll('[data-os-active]');
    expect(active).toHaveLength(1);
    expect((active[0] as HTMLElement).dataset.os).toBe('macOS');
  });

  it('updates active panel on subsequent calls', () => {
    activate('Windows');
    activate('Linux');
    const active = document.querySelectorAll('[data-os-active]');
    expect(active).toHaveLength(1);
    expect((active[0] as HTMLElement).dataset.os).toBe('Linux');
  });
});

describe('OS_VALUES', () => {
  it('exports the four canonical OS values in fixed order', () => {
    expect(OS_VALUES).toEqual(['Windows', 'macOS', 'Linux', 'BAS']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run hugo/assets/js/__tests__/os-toggle.test.ts
```

Expected: FAIL with "Cannot find module '../os-toggle'".

- [ ] **Step 3: Implement `os-toggle.ts`**

```ts
// hugo/assets/js/os-toggle.ts
// Global OS picker for tutorial pages with OS-conditional content.
// Modeled on codetabs.ts: localStorage-backed cross-page preference,
// activates panels via data-os-active, listens for picker changes,
// cross-tab sync via storage events.

const STORAGE_KEY = 'os-preference';
const CHANGE_EVENT = 'osprefchange';

export const OS_VALUES = ['Windows', 'macOS', 'Linux', 'BAS'] as const;
export type OS = typeof OS_VALUES[number];

function getPreference(): OS | null {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    return (OS_VALUES as readonly string[]).includes(v ?? '') ? (v as OS) : null;
  } catch {
    return null;
  }
}

function setPreference(os: OS) {
  try {
    localStorage.setItem(STORAGE_KEY, os);
  } catch {
    /* private mode / quota */
  }
}

function detectFromBas(): OS | null {
  try {
    const ref = document.referrer ?? '';
    if (/applicationstudio/i.test(ref)) return 'BAS';
    const ancestors = (location as unknown as { ancestorOrigins?: { length: number; [k: number]: string } }).ancestorOrigins;
    if (ancestors && ancestors.length > 0) {
      for (let i = 0; i < ancestors.length; i++) {
        if (/applicationstudio/i.test(ancestors[i])) return 'BAS';
      }
    }
  } catch { /* ignore */ }
  return null;
}

function detectFromClientHints(): OS | null {
  const uad = (navigator as unknown as { userAgentData?: { platform?: string } }).userAgentData;
  if (!uad?.platform) return null;
  const p = uad.platform.toLowerCase();
  if (p.includes('windows')) return 'Windows';
  if (p.includes('mac'))     return 'macOS';
  if (p.includes('linux'))   return 'Linux';
  return null;
}

function detectFromUserAgent(): OS | null {
  const ua = navigator.userAgent || '';
  if (/Windows/i.test(ua))               return 'Windows';
  if (/Mac|iPhone|iPad|iPod/i.test(ua))  return 'macOS';
  if (/Linux|X11/i.test(ua))             return 'Linux';
  return null;
}

function detectDefaultOs(): OS {
  return getPreference()
    ?? detectFromBas()
    ?? detectFromClientHints()
    ?? detectFromUserAgent()
    ?? 'Windows';
}

function activate(os: OS): void {
  document.querySelectorAll<HTMLElement>('[data-os-options]').forEach((wrapper) => {
    wrapper.setAttribute('data-os-options-hydrated', '');
    wrapper.querySelectorAll<HTMLElement>('.os-panel[data-os]').forEach((p) => {
      p.removeAttribute('data-os-active');
    });
    // Task 7 layers on the fallback chain. For now, exact match only.
    const target = wrapper.querySelector<HTMLElement>(`.os-panel[data-os="${os}"]`);
    if (target) target.setAttribute('data-os-active', '');
  });
}

function wirePicker(picker: HTMLElement, current: OS): void {
  const seg = picker.querySelector('ui5-segmented-button');
  if (!seg) return;
  // Pre-select the current OS item.
  seg.querySelectorAll<HTMLElement>('ui5-segmented-button-item').forEach((item) => {
    if (item.dataset.os === current) item.setAttribute('selected', '');
    else item.removeAttribute('selected');
  });
  seg.addEventListener('selection-change', (e) => {
    const detail = (e as CustomEvent).detail as { selectedItems?: HTMLElement[] } | undefined;
    const picked = detail?.selectedItems?.[0]?.dataset.os as OS | undefined;
    if (!picked || !(OS_VALUES as readonly string[]).includes(picked)) return;
    setPreference(picked);
    activate(picked);
    document.dispatchEvent(new CustomEvent(CHANGE_EVENT, { detail: { os: picked } }));
  });
}

async function init(): Promise<void> {
  const picker = document.querySelector<HTMLElement>('[data-os-picker]');
  const groups = document.querySelectorAll('[data-os-options]');
  if (!picker && groups.length === 0) return;

  // Wait for ui5-segmented-button to upgrade (3s timeout fallback).
  await Promise.race([
    customElements.whenDefined('ui5-segmented-button'),
    new Promise((r) => setTimeout(r, 3000)),
  ]);

  const current = detectDefaultOs();
  activate(current);
  if (picker) wirePicker(picker, current);

  // Cross-tab sync.
  window.addEventListener('storage', (e) => {
    if (e.key !== STORAGE_KEY) return;
    const next = e.newValue;
    if (next && (OS_VALUES as readonly string[]).includes(next)) {
      activate(next as OS);
      if (picker) wirePicker(picker, next as OS);
    }
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => void init());
} else {
  void init();
}

// Test seam — exposes internals to the unit test, not part of the public API.
export const __test__ = { detectDefaultOs, activate, OS_VALUES };
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npx vitest run hugo/assets/js/__tests__/os-toggle.test.ts
```

Expected: PASS, all cases.

- [ ] **Step 5: Verify line endings**

```bash
file hugo/assets/js/os-toggle.ts hugo/assets/js/__tests__/os-toggle.test.ts
```

Expected: no "CRLF line terminators".

- [ ] **Step 6: Commit**

```bash
git branch --show-current
git add hugo/assets/js/os-toggle.ts hugo/assets/js/__tests__/os-toggle.test.ts
git commit -m "feat(173): add os-toggle runtime — detect, activate, persist OS

Modeled on codetabs.ts: detects the default OS from
  localStorage > BAS heuristic > Client Hints > userAgent > 'Windows'
fallback chain. Activates panels via data-os-active. Picker change writes
localStorage and dispatches osprefchange document event. Cross-tab sync via
storage event.

Test seam (__test__) exposes detectDefaultOs/activate/OS_VALUES for unit
tests. Task 7 will extend activate() with the missing-variant fallback chain
and ui5-message-strip rendering.

Spec §4.3."
```

---

### Task 7: Fallback chain + missing-variant message strip

**Files:**
- Modify: `hugo/assets/js/os-toggle.ts`
- Modify: `hugo/assets/js/__tests__/os-toggle.test.ts`

**Background:** When the active OS doesn't match any panel in a group, fall through a fixed chain and render an inline `<ui5-message-strip>` above the activated panel. From the spec:

```
Linux   -> macOS   -> Windows -> BAS     -> first available
macOS   -> Linux   -> Windows -> BAS     -> first available
BAS     -> Linux   -> macOS   -> Windows -> first available
Windows -> macOS   -> Linux   -> BAS     -> first available
```

- [ ] **Step 1: Write the failing test**

Append to `hugo/assets/js/__tests__/os-toggle.test.ts` (using the same `buildOsOptions` helper from Task 6):

```ts
describe('activate — fallback chain', () => {
  beforeEach(() => {
    resetBody();
    document.body.appendChild(buildOsOptions([
      { os: 'Windows', body: 'W' },
      { os: 'macOS',   body: 'M' },
    ]));
  });

  it('falls back from Linux -> macOS when no Linux panel exists', () => {
    activate('Linux');
    const active = document.querySelector('[data-os-active]') as HTMLElement;
    expect(active?.dataset.os).toBe('macOS');
  });

  it('renders a ui5-message-strip when fallback fires', () => {
    activate('Linux');
    const strip = document.querySelector('ui5-message-strip');
    expect(strip).not.toBeNull();
    expect(strip?.textContent).toMatch(/Linux/);
    expect(strip?.textContent).toMatch(/macOS/);
  });

  it('does NOT render a message strip on exact match', () => {
    activate('Windows');
    expect(document.querySelector('ui5-message-strip')).toBeNull();
  });

  it('clears prior message strip on reactivation', () => {
    activate('Linux');         // creates a strip
    activate('Windows');       // exact match — strip should be removed
    expect(document.querySelector('ui5-message-strip')).toBeNull();
  });

  it('falls back to first-available when chain has no matches', () => {
    resetBody();
    document.body.appendChild(buildOsOptions([{ os: 'BAS', body: 'B' }]));
    activate('Windows');
    const active = document.querySelector('[data-os-active]') as HTMLElement;
    expect(active?.dataset.os).toBe('BAS');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run hugo/assets/js/__tests__/os-toggle.test.ts
```

Expected: FAIL — fallback chain not implemented; message strip not rendered.

- [ ] **Step 3: Implement the fallback chain inside `activate`**

Replace the `activate` function in `os-toggle.ts`:

```ts
const FALLBACK_CHAIN: Record<OS, OS[]> = {
  Linux:   ['Linux',   'macOS',   'Windows', 'BAS'],
  macOS:   ['macOS',   'Linux',   'Windows', 'BAS'],
  BAS:     ['BAS',     'Linux',   'macOS',   'Windows'],
  Windows: ['Windows', 'macOS',   'Linux',   'BAS'],
};

function pickPanel(wrapper: Element, os: OS): { panel: HTMLElement | null; usedFallback: OS | null } {
  for (const candidate of FALLBACK_CHAIN[os]) {
    const found = wrapper.querySelector<HTMLElement>(`.os-panel[data-os="${candidate}"]`);
    if (found) return { panel: found, usedFallback: candidate === os ? null : candidate };
  }
  // Last-resort: first panel in the wrapper, regardless of OS.
  const first = wrapper.querySelector<HTMLElement>('.os-panel[data-os]');
  return { panel: first, usedFallback: first ? (first.dataset.os as OS) : null };
}

function clearStrip(wrapper: Element) {
  wrapper.querySelectorAll('ui5-message-strip[data-os-fallback-strip]').forEach((s) => s.remove());
}

function renderStrip(wrapper: Element, requested: OS, used: OS) {
  const strip = document.createElement('ui5-message-strip');
  strip.setAttribute('design', 'Information');
  strip.setAttribute('data-os-fallback-strip', '');
  strip.textContent = `No ${requested} instructions for this step — showing ${used}.`;
  wrapper.insertBefore(strip, wrapper.firstChild);
}

function activate(os: OS): void {
  document.querySelectorAll<HTMLElement>('[data-os-options]').forEach((wrapper) => {
    wrapper.setAttribute('data-os-options-hydrated', '');
    wrapper.querySelectorAll<HTMLElement>('.os-panel[data-os]').forEach((p) => {
      p.removeAttribute('data-os-active');
    });
    clearStrip(wrapper);
    const { panel, usedFallback } = pickPanel(wrapper, os);
    if (!panel) return;
    panel.setAttribute('data-os-active', '');
    if (usedFallback) renderStrip(wrapper, os, usedFallback);
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npx vitest run hugo/assets/js/__tests__/os-toggle.test.ts
```

Expected: PASS, all cases.

- [ ] **Step 5: Commit**

```bash
git branch --show-current
git add hugo/assets/js/os-toggle.ts hugo/assets/js/__tests__/os-toggle.test.ts
git commit -m "feat(173): fallback chain + missing-variant message strip

When the active OS has no matching panel in a group, walk a fixed chain
(Linux -> macOS -> Windows -> BAS for Linux, etc.) and render an inline
ui5-message-strip above the activated panel: 'No <chosen> instructions for
this step — showing <fallback>.' Strip is cleared on every reactivation so
flipping back to an exact match removes it.

Last-resort: first panel in the wrapper regardless of OS, in case neither
the chosen OS nor any fallback matches.

Spec §4.3 step 3."
```

---

### Task 8: Wire `os-toggle.ts` into `ui5-bootstrap.ts`

**Files:**
- Modify: `hugo/assets/js/ui5-bootstrap.ts`

**Background:** Per the spec and [[u11-progress]], cross-page features that gate on DOM presence belong in `ui5-bootstrap.ts` so they hydrate alongside the rest of the UI5 components, not in `tutorial.ts` (which only loads on tutorial layouts).

- [ ] **Step 1: Locate the existing imports section**

```bash
grep -n "^import\|codetabs" hugo/assets/js/ui5-bootstrap.ts | head -20
```

- [ ] **Step 2: Add the import**

In `hugo/assets/js/ui5-bootstrap.ts`, add alongside the existing imports (e.g. after the codetabs import):

```ts
import './os-toggle';
```

The module's `init()` short-circuits when neither `[data-os-picker]` nor `[data-os-options]` is present, so it costs effectively nothing on non-OS pages.

- [ ] **Step 3: Sanity-check the bundle still builds**

```bash
npm run build:apps
```

Expected: clean build, no TypeScript or Vite errors.

- [ ] **Step 4: Run the build-collision check (also runs as part of postbuild:apps)**

```bash
npx tsx scripts/check-build-collisions.ts
```

Expected: no collisions reported. (See [[feedback_vite_chunks_need_base]] — Vite output names must not collide with any Hugo `js.Build` basename.)

- [ ] **Step 5: Commit**

```bash
git branch --show-current
git add hugo/assets/js/ui5-bootstrap.ts
git commit -m "feat(173): import os-toggle from ui5-bootstrap

Cross-page feature gated on DOM presence — module init() short-circuits when
neither [data-os-picker] nor [data-os-options] is in the document, so the
cost on non-OS pages is just one bundled import.

Spec §4.5."
```

---

## Phase 3 — CAP backend (Tasks 9-12)

### Task 9: `db/schema.cds` — `AuthorAiRequests` entity

**Files:**
- Modify: `db/schema.cds`

**Background:** Per spec §5.4 and Tom's clarification (no PII concerns — author content), v1 persists `sourceMarkdown` and `variants` directly (not gated behind a feature flag). Annotated `@analytics.exposed` so the existing `AnalyticsService` (Joule analytics dashboards) can surface usage.

- [ ] **Step 1: Locate the right insertion point**

```bash
grep -n "^entity\|^@PersonalData\|@analytics.exposed" db/schema.cds | head -30
```

Pick a location near other "Other"-classified telemetry entities (search for `EntitySemantics: 'Other'`).

- [ ] **Step 2: Add the entity definition**

```cds
@PersonalData.EntitySemantics: 'Other'
@analytics.exposed
entity AuthorAiRequests : cuid, managed {
  authorId       : String;        // XSUAA user ID, hashed before persist (mirrors codecheck)
  feature        : String;        // 'os-variants' (forward-compat for other author AI tools)
  sourceOS       : String;
  targetOSes     : String;        // comma-joined list, e.g. 'macOS,Linux'
  sourceMarkdown : LargeString;   // v1: persisted (author content, no end-user PII concern)
  variants       : LargeString;   // v1: persisted as JSON-stringified array of {os, markdown}
  sourceLength   : Integer;
  variantsLength : Integer;
  model          : String;
  tokensUsed     : Integer;
  durationMs     : Integer;
  errorCode      : String;        // null on success
}
```

- [ ] **Step 3: Run a CDS compile check**

```bash
npx cds compile db/schema.cds --to sql
```

Expected: compiles cleanly, no errors. Output includes a `CREATE TABLE` for the new entity.

- [ ] **Step 4: Run unit tests to confirm in-memory SQLite still deploys**

```bash
npm test -- --run test/unit/
```

Expected: in-memory SQLite cds.test() still bootstraps; existing tests green. (See [[feedback_worktree_tests_hang]] — scope `--run` to keep things fast.)

- [ ] **Step 5: Commit**

```bash
git branch --show-current
git add db/schema.cds
git commit -m "feat(173): add AuthorAiRequests entity for authoring-AI audit

cuid + managed entity tracking author calls to AI assist features.
Generic 'feature' column lets us add future authoring-AI flows (rewrite,
translate, etc.) without schema churn.

@PersonalData.EntitySemantics: 'Other' — telemetry of author actions, not
end-user identity. @analytics.exposed surfaces it in the Joule analytics
dashboards.

v1 persists sourceMarkdown + variants verbatim (no PII concern — author-
sourced content). Future eval harness consumes these directly.

Spec §5.4."
```

---

### Task 10: Extend `chat-rate-limit.js` to accept a configurable window

**Files:**
- Modify: `srv/lib/chat-rate-limit.js`
- Test: `srv/lib/__tests__/chat-rate-limit.test.js`

**Background:** [srv/lib/chat-rate-limit.js](../../../srv/lib/chat-rate-limit.js) hard-codes a 24-hour window. We need a 1-hour window for `/author/generateOsVariants` (60/hr per author). Smallest-blast-radius change: add an optional `windowMs` parameter to `createRateLimiter`, default to existing 24h to preserve every current caller.

- [ ] **Step 1: Read existing module + tests**

```bash
cat srv/lib/chat-rate-limit.js
ls srv/lib/__tests__/ | grep -i rate
```

- [ ] **Step 2: Write the failing test**

If a test file exists, append; otherwise create `srv/lib/__tests__/chat-rate-limit.test.js`:

```js
import { describe, it, expect } from 'vitest';
import { createRateLimiter, RateLimitError } from '../chat-rate-limit.js';

describe('createRateLimiter — configurable window', () => {
  it('defaults to 24h window when windowMs is omitted (back-compat)', () => {
    let now = 0;
    const limiter = createRateLimiter({ now: () => now });
    for (let i = 0; i < 5; i++) limiter.check('user-1', 5);
    expect(() => limiter.check('user-1', 5)).toThrow(RateLimitError);
    // Advance 23 hours — still in window
    now += 23 * 60 * 60 * 1000;
    expect(() => limiter.check('user-1', 5)).toThrow(RateLimitError);
    // Advance past 24h — window resets
    now += 2 * 60 * 60 * 1000;
    expect(() => limiter.check('user-1', 5)).not.toThrow();
  });

  it('honors a 1-hour windowMs', () => {
    let now = 0;
    const limiter = createRateLimiter({ now: () => now, windowMs: 60 * 60 * 1000 });
    for (let i = 0; i < 3; i++) limiter.check('u', 3);
    expect(() => limiter.check('u', 3)).toThrow(RateLimitError);
    now += 30 * 60 * 1000;            // +30 min — still limited
    expect(() => limiter.check('u', 3)).toThrow(RateLimitError);
    now += 31 * 60 * 1000;            // +61 min — window reset
    expect(() => limiter.check('u', 3)).not.toThrow();
  });

  it('RateLimitError carries retryAfterSec rounded to ceil', () => {
    let now = 0;
    const limiter = createRateLimiter({ now: () => now, windowMs: 60 * 60 * 1000 });
    limiter.check('u', 1);
    try {
      limiter.check('u', 1);
    } catch (err) {
      expect(err).toBeInstanceOf(RateLimitError);
      expect(err.retryAfterSec).toBe(60 * 60); // 3600s for a 1h window with t=0
    }
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

```bash
npx vitest run srv/lib/__tests__/chat-rate-limit.test.js
```

Expected: FAIL — `windowMs` parameter ignored.

- [ ] **Step 4: Update `chat-rate-limit.js`**

```js
const DEFAULT_WINDOW_MS = 24 * 60 * 60 * 1000;

export class RateLimitError extends Error {
  constructor(retryAfterSec) {
    super('rate_limit');
    this.name = 'RateLimitError';
    this.code = 'RATE_LIMIT';
    this.retryAfterSec = retryAfterSec;
  }
}

export function createRateLimiter({ now = () => Date.now(), windowMs = DEFAULT_WINDOW_MS } = {}) {
  const counters = new Map();

  return {
    check(userId, limit) {
      const t = now();
      let entry = counters.get(userId);
      if (!entry || t - entry.windowStart >= windowMs) {
        entry = { count: 0, windowStart: t };
        counters.set(userId, entry);
      }
      if (entry.count >= limit) {
        const retryAfterSec = Math.ceil((entry.windowStart + windowMs - t) / 1000);
        throw new RateLimitError(retryAfterSec);
      }
      entry.count += 1;
    }
  };
}
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
npx vitest run srv/lib/__tests__/chat-rate-limit.test.js
```

Expected: PASS.

- [ ] **Step 6: Run any consumers' tests to confirm back-compat**

```bash
grep -rln "createRateLimiter\|chat-rate-limit" srv/ | head
# Run tests for each consumer
npx vitest run srv/lib/__tests__/
```

Expected: all green; existing 24h-default callers untouched.

- [ ] **Step 7: Commit**

```bash
git branch --show-current
git add srv/lib/chat-rate-limit.js srv/lib/__tests__/chat-rate-limit.test.js
git commit -m "refactor(173): make chat-rate-limit window configurable

Add an optional windowMs parameter to createRateLimiter, defaulting to the
existing 24h so every current caller is byte-identical. Task 11 will use
1h for the new generateOsVariants endpoint (60 calls/hour/author).

Tests cover default-window back-compat and the new 1h window."
```

---

### Task 11: `os-variant-generator.js` — LLM call + persistence

**Files:**
- Create: `srv/lib/os-variant-generator.js`
- Create: `srv/lib/__tests__/os-variant-generator.test.js`

**Background:** Mirrors [srv/lib/code-check-llm.js](../../../srv/lib/code-check-llm.js): uses `OrchestrationClient.chatCompletion` from `@sap-ai-sdk/orchestration`. We don't need forced tool-calls here — the response is plain markdown blocks separated by a literal sentinel. Persist every call (success or failure) to `AuthorAiRequests`.

- [ ] **Step 1: Read the code-check pattern for reference**

```bash
sed -n '1,80p' srv/lib/code-check-llm.js
```

Note the model fallback chain (`ChatSettings.modelName` → env → default), the `OrchestrationClient` usage, and the `cds.entities` runtime guard pattern (see [[feedback_cds_entities_runtime_only]]).

- [ ] **Step 2: Write the failing test**

```js
// srv/lib/__tests__/os-variant-generator.test.js
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockChatCompletion = vi.fn();
vi.mock('@sap-ai-sdk/orchestration', () => ({
  OrchestrationClient: vi.fn().mockImplementation(() => ({
    chatCompletion: mockChatCompletion,
  })),
}));

const mockPersist = vi.fn();
vi.mock('../author-ai-persist.js', () => ({
  persistAuthorAiRequest: mockPersist,
}));

const { generateOsVariants } = await import('../os-variant-generator.js');

describe('generateOsVariants', () => {
  beforeEach(() => {
    mockChatCompletion.mockReset();
    mockPersist.mockReset();
  });

  it('returns one variant per requested target OS', async () => {
    mockChatCompletion.mockResolvedValueOnce({
      getContent: () => 'BLOCK FOR macOS\n===NEXT_VARIANT===\nBLOCK FOR Linux',
      getUsage: () => ({ total_tokens: 100 }),
      data: { model: 'gpt-4o' },
    });

    const result = await generateOsVariants({
      sourceMarkdown: 'Open PowerShell',
      sourceOS: 'Windows',
      targetOSes: ['macOS', 'Linux'],
      context: { tutorialSlug: 't', stepHeading: 's', surroundingMarkdown: '' },
      userId: 'user-1',
    });

    expect(result.variants).toHaveLength(2);
    expect(result.variants[0]).toEqual({ os: 'macOS', markdown: 'BLOCK FOR macOS' });
    expect(result.variants[1]).toEqual({ os: 'Linux', markdown: 'BLOCK FOR Linux' });
    expect(result.requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(mockPersist).toHaveBeenCalledTimes(1);
    expect(mockPersist.mock.calls[0][0]).toMatchObject({
      userId: 'user-1',
      sourceOS: 'Windows',
      targetOSes: ['macOS', 'Linux'],
    });
  });

  it('throws on mismatched block count', async () => {
    mockChatCompletion.mockResolvedValueOnce({
      getContent: () => 'ONLY ONE BLOCK',
      getUsage: () => ({ total_tokens: 50 }),
      data: { model: 'gpt-4o' },
    });

    await expect(generateOsVariants({
      sourceMarkdown: 'x', sourceOS: 'Windows', targetOSes: ['macOS', 'Linux'],
      context: {}, userId: 'u',
    })).rejects.toThrow(/expected 2/);
  });

  it('persists with errorCode on AI Core failure', async () => {
    mockChatCompletion.mockRejectedValueOnce(new Error('upstream 502'));
    await expect(generateOsVariants({
      sourceMarkdown: 'x', sourceOS: 'Windows', targetOSes: ['macOS'],
      context: {}, userId: 'u',
    })).rejects.toThrow(/upstream/);
    expect(mockPersist).toHaveBeenCalledTimes(1);
    expect(mockPersist.mock.calls[0][0].errorCode).toBeTruthy();
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

```bash
npx vitest run srv/lib/__tests__/os-variant-generator.test.js
```

Expected: FAIL — modules don't exist.

- [ ] **Step 4: Implement `srv/lib/author-ai-persist.js`** (small helper, isolated for mockability)

```js
// srv/lib/author-ai-persist.js
import cds from '@sap/cds';

const LOG = cds.log('author-ai');

export async function persistAuthorAiRequest({
  requestId, userId, feature, sourceOS, targetOSes, sourceMarkdown, variants,
  tokensUsed, model, durationMs, errorCode,
}) {
  try {
    const db = await cds.connect.to('db');
    const { AuthorAiRequests } = db.entities('com.sap.developers.ims');
    if (!AuthorAiRequests) {
      LOG.warn('AuthorAiRequests entity not found — skipping persist (unbooted CDS context?)');
      return;
    }
    const sourceLength = sourceMarkdown ? sourceMarkdown.length : 0;
    const variantsJson = variants ? JSON.stringify(variants) : '[]';
    const variantsLength = variantsJson.length;
    await db.run(INSERT.into(AuthorAiRequests).entries({
      ID: requestId,
      authorId: userId,
      feature: feature ?? 'os-variants',
      sourceOS,
      targetOSes: Array.isArray(targetOSes) ? targetOSes.join(',') : (targetOSes ?? ''),
      sourceMarkdown: sourceMarkdown ?? null,
      variants: variantsJson,
      sourceLength,
      variantsLength,
      model: model ?? null,
      tokensUsed: tokensUsed ?? null,
      durationMs: durationMs ?? null,
      errorCode: errorCode ?? null,
    }));
  } catch (err) {
    LOG.error('persistAuthorAiRequest failed', err);
    // Never throw — persist is observability, not user-facing.
  }
}
```

- [ ] **Step 5: Implement `srv/lib/os-variant-generator.js`**

```js
// srv/lib/os-variant-generator.js
// AI Core call for the /author/generateOsVariants action (issue #173).
// Mirrors srv/lib/code-check-llm.js (model fallback chain, OrchestrationClient
// usage); plain markdown response with a literal sentinel separator instead
// of forced tool-calls.

import cds from '@sap/cds';
import { randomUUID } from 'node:crypto';
import { OrchestrationClient } from '@sap-ai-sdk/orchestration';
import { persistAuthorAiRequest } from './author-ai-persist.js';

const LOG = cds.log('os-variants');

const SENTINEL = '===NEXT_VARIANT===';

const SYSTEM_PROMPT = `You rewrite tutorial instructions for SAP developers. Given source markdown
written for a specific operating system, produce equivalent instructions for the target OS.

Rules:
- Translate shell commands (PowerShell <-> bash, file paths, line continuations: backtick <-> backslash).
- Translate path conventions (C:\\Users\\... <-> ~/, / vs \\, drive letters).
- Translate package managers when an obvious equivalent exists (choco <-> brew <-> apt).
  When no equivalent exists, leave the instruction in prose form ("install <X> for your distro").
- BAS == Linux container with VS Code; treat it as Linux but call out terminal location
  ("In the BAS terminal, run...") when relevant.
- Preserve markdown structure exactly: same heading levels, same list shapes, same code-fence languages.
- Preserve all non-OS content verbatim (concepts, screenshots, links, prose explanations).
- Never invent commands you are uncertain about; if you cannot translate, leave a TODO marker
  in markdown comment form: <!-- TODO: confirm <command> on <os> -->.

Output: ONE markdown block per requested target OS, in the order requested. Each block separated
by the literal sentinel "${SENTINEL}" on its own line. No preamble, no explanation, no fences
around the whole.`;

function renderUserPrompt({ sourceMarkdown, sourceOS, targetOSes, context }) {
  const ctxParts = [];
  if (context?.tutorialSlug)        ctxParts.push(`Tutorial: ${context.tutorialSlug}`);
  if (context?.stepHeading)         ctxParts.push(`Step: ${context.stepHeading}`);
  if (context?.surroundingMarkdown) ctxParts.push(`Surrounding context:\n${context.surroundingMarkdown.slice(0, 2000)}`);
  const ctxBlock = ctxParts.length ? `\n\n${ctxParts.join('\n')}\n` : '';

  return `Source OS: ${sourceOS}
Target OSes (in order): ${targetOSes.join(', ')}
${ctxBlock}
--- BEGIN SOURCE MARKDOWN ---
${sourceMarkdown}
--- END SOURCE MARKDOWN ---

Produce ${targetOSes.length} block${targetOSes.length === 1 ? '' : 's'} separated by ${SENTINEL}.`;
}

async function resolveModelName() {
  // Same fallback chain as code-check.
  try {
    const { ChatSettings } = cds.entities('com.sap.developers.ims');
    if (ChatSettings) {
      const row = await cds.read(ChatSettings).limit(1);
      if (row?.[0]?.modelName) return row[0].modelName;
    }
  } catch { /* CDS not booted */ }
  return process.env.CHAT_MODEL_NAME || 'anthropic--claude-4.6-sonnet';
}

export async function generateOsVariants({
  sourceMarkdown, sourceOS, targetOSes, context = {}, userId,
}) {
  const requestId = randomUUID();
  const startedAt = Date.now();
  let result;
  try {
    const modelName = await resolveModelName();
    const client = new OrchestrationClient({
      llm: { model_name: modelName, model_params: { temperature: 0.2, max_tokens: 2000 } },
    });
    const response = await client.chatCompletion({
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user',   content: renderUserPrompt({ sourceMarkdown, sourceOS, targetOSes, context }) },
      ],
    });
    const content = (typeof response.getContent === 'function') ? response.getContent() : '';
    const tokensUsed = response.getUsage?.()?.total_tokens ?? null;
    const model = response.data?.model ?? modelName;

    const blocks = content.split(SENTINEL).map((s) => s.trim()).filter(Boolean);
    if (blocks.length !== targetOSes.length) {
      throw new Error(`AI returned ${blocks.length} blocks, expected ${targetOSes.length}`);
    }
    const variants = targetOSes.map((os, i) => ({ os, markdown: blocks[i] }));

    result = { variants, model, tokensUsed, requestId };
    await persistAuthorAiRequest({
      requestId, userId, sourceOS, targetOSes, sourceMarkdown, variants,
      tokensUsed, model, durationMs: Date.now() - startedAt, errorCode: null,
    });
    return result;
  } catch (err) {
    LOG.error('generateOsVariants failed', { requestId, err: err.message });
    await persistAuthorAiRequest({
      requestId, userId, sourceOS, targetOSes, sourceMarkdown, variants: null,
      tokensUsed: null, model: null, durationMs: Date.now() - startedAt,
      errorCode: err.code ?? err.message?.slice(0, 100) ?? 'unknown',
    });
    throw err;
  }
}
```

- [ ] **Step 6: Run tests to verify they pass**

```bash
npx vitest run srv/lib/__tests__/os-variant-generator.test.js
```

Expected: PASS, all three cases.

- [ ] **Step 7: Commit**

```bash
git branch --show-current
git add srv/lib/os-variant-generator.js srv/lib/author-ai-persist.js srv/lib/__tests__/os-variant-generator.test.js
git commit -m "feat(173): os-variant-generator — LLM call + audit persist

Mirrors code-check-llm.js: same OrchestrationClient + same model-fallback
chain (ChatSettings.modelName -> CHAT_MODEL_NAME env -> default). Plain
markdown response with a literal '===NEXT_VARIANT===' sentinel separator
instead of forced tool-calls (output isn't structured JSON, just N markdown
blocks).

Persists every call (success or failure) to AuthorAiRequests via
author-ai-persist.js — isolated helper so mocking is trivial in unit tests
and so the persist failure mode is contained (never throws back to caller).

Spec §5.3."
```

---

### Task 12: `AuthorService` action wiring (CDS + handler)

**Files:**
- Modify: `srv/author-service.cds`
- Modify: `srv/author-service.js`
- Test: `srv/__tests__/author-service-os-variants.test.js` (new)

**Background:** `AuthorService` already has `@requires: 'Tutorial.Author'` at service level (see [srv/author-service.cds](../../../srv/author-service.cds)) so the new action inherits XSUAA scope automatically. Handler is a thin pass-through with input validation + rate-limit + delegation to the Task 11 generator.

- [ ] **Step 1: Add the action + types to `author-service.cds`**

```cds
using { com.sap.developers.ims as ims } from '../db/schema';
using from '../db/views';

@path: '/author'
@requires: 'Tutorial.Author'
service AuthorService {

  @Capabilities.ChangeTracking : { Supported: true }
  @readonly entity Tutorials as projection on ims.Tutorials {
    ID, slug, title, primaryTag, status
  };

  @Capabilities.ChangeTracking : { Supported: true }
  @readonly entity Tags as projection on ims.Tags;

  @Capabilities.ChangeTracking : { Supported: true }
  @readonly entity MyTutorials as projection on ims.MyTutorialsView;

  action reviewTutorial(tutorialId : UUID) returns {
    reviewedDate       : Timestamp;
    notificationNumber : Integer;
  };

  action snoozeTutorial(tutorialId : UUID, days : Integer) returns {
    lastNotificationDate : Timestamp;
    notificationNumber   : Integer;
  };

  // Issue #173 — AI-assisted OS variant generation. VS Code authoring plugin posts here.
  type OsValue : String enum { Windows; macOS; Linux; BAS };

  type OsVariantContext : {
    tutorialSlug        : String;
    stepHeading         : String;
    surroundingMarkdown : String;
  };

  type OsVariant : {
    os       : OsValue;
    markdown : LargeString;
  };

  action generateOsVariants(
    sourceMarkdown : LargeString,
    sourceOS       : OsValue,
    targetOSes     : array of OsValue,
    context        : OsVariantContext
  ) returns {
    variants    : array of OsVariant;
    model       : String;
    tokensUsed  : Integer;
    requestId   : String;
  };
}
```

- [ ] **Step 2: Write the failing handler test**

```js
// srv/__tests__/author-service-os-variants.test.js
import { describe, it, expect, vi, beforeEach } from 'vitest';
import cds from '@sap/cds';

const mockGenerate = vi.fn();
vi.mock('../lib/os-variant-generator.js', () => ({
  generateOsVariants: mockGenerate,
}));

beforeEach(() => {
  mockGenerate.mockReset();
});

describe('AuthorService.generateOsVariants — input validation', () => {
  let srv;
  beforeEach(async () => {
    srv = await cds.test('serve', 'srv/author-service.cds').in(__dirname);
  });

  it('rejects sourceMarkdown > 8000 chars', async () => {
    const big = 'x'.repeat(8001);
    const r = await srv.post('/author/generateOsVariants', {
      sourceMarkdown: big, sourceOS: 'Windows', targetOSes: ['macOS'], context: {},
    });
    expect(r.status).toBe(400);
  });

  it('rejects empty targetOSes', async () => {
    const r = await srv.post('/author/generateOsVariants', {
      sourceMarkdown: 'hi', sourceOS: 'Windows', targetOSes: [], context: {},
    });
    expect(r.status).toBe(400);
  });

  it('rejects targetOSes containing sourceOS', async () => {
    const r = await srv.post('/author/generateOsVariants', {
      sourceMarkdown: 'hi', sourceOS: 'Windows', targetOSes: ['Windows'], context: {},
    });
    expect(r.status).toBe(400);
  });

  it('rejects invalid OS value', async () => {
    const r = await srv.post('/author/generateOsVariants', {
      sourceMarkdown: 'hi', sourceOS: 'Windows', targetOSes: ['Solaris'], context: {},
    });
    expect(r.status).toBe(400);
  });

  it('delegates to generateOsVariants on valid input', async () => {
    mockGenerate.mockResolvedValueOnce({
      variants: [{ os: 'macOS', markdown: 'mac' }],
      model: 'gpt-4o', tokensUsed: 100, requestId: 'abc',
    });
    const r = await srv.post('/author/generateOsVariants', {
      sourceMarkdown: 'hi', sourceOS: 'Windows', targetOSes: ['macOS'], context: { tutorialSlug: 't' },
    });
    expect(r.status).toBe(200);
    expect(r.data.requestId).toBe('abc');
    expect(mockGenerate).toHaveBeenCalledTimes(1);
  });
});

describe('AuthorService.generateOsVariants — rate limit', () => {
  it('returns 429 after 60 calls in one hour', async () => {
    mockGenerate.mockResolvedValue({
      variants: [{ os: 'macOS', markdown: 'm' }], model: 'gpt-4o', tokensUsed: 1, requestId: 'r',
    });
    const srv = await cds.test('serve', 'srv/author-service.cds').in(__dirname);
    let lastStatus;
    for (let i = 0; i < 61; i++) {
      const r = await srv.post('/author/generateOsVariants', {
        sourceMarkdown: 'x', sourceOS: 'Windows', targetOSes: ['macOS'], context: {},
      });
      lastStatus = r.status;
    }
    expect(lastStatus).toBe(429);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

```bash
npx vitest run srv/__tests__/author-service-os-variants.test.js
```

Expected: FAIL — handler not implemented.

- [ ] **Step 4: Implement the handler in `srv/author-service.js`**

```js
// srv/author-service.js — add alongside existing handlers
import { generateOsVariants } from './lib/os-variant-generator.js';
import { createRateLimiter, RateLimitError } from './lib/chat-rate-limit.js';

const OS_VALUES = ['Windows', 'macOS', 'Linux', 'BAS'];
const OS_VARIANTS_LIMIT = 60;             // calls per hour per author
const OS_VARIANTS_WINDOW_MS = 60 * 60 * 1000;

const osVariantsLimiter = createRateLimiter({ windowMs: OS_VARIANTS_WINDOW_MS });

export default (srv) => {
  // ... existing reviewTutorial / snoozeTutorial handlers ...

  srv.on('generateOsVariants', async (req) => {
    const { sourceMarkdown, sourceOS, targetOSes, context } = req.data;
    const userId = req.user?.id ?? 'anonymous';

    if (!sourceMarkdown || typeof sourceMarkdown !== 'string' || sourceMarkdown.length === 0 || sourceMarkdown.length > 8000) {
      return req.reject(400, 'sourceMarkdown must be 1..8000 chars');
    }
    if (!OS_VALUES.includes(sourceOS)) return req.reject(400, 'invalid sourceOS');
    if (!Array.isArray(targetOSes) || targetOSes.length === 0 || targetOSes.length > 3) {
      return req.reject(400, 'targetOSes must be a non-empty array of length 1..3');
    }
    const seen = new Set();
    for (const t of targetOSes) {
      if (!OS_VALUES.includes(t))   return req.reject(400, `invalid targetOS: ${t}`);
      if (t === sourceOS)           return req.reject(400, 'targetOSes cannot include sourceOS');
      if (seen.has(t))              return req.reject(400, `duplicate targetOS: ${t}`);
      seen.add(t);
    }

    try {
      osVariantsLimiter.check(userId, OS_VARIANTS_LIMIT);
    } catch (err) {
      if (err instanceof RateLimitError) {
        return req.reject(429, `Rate limit exceeded — retry after ${err.retryAfterSec}s`);
      }
      throw err;
    }

    return generateOsVariants({ sourceMarkdown, sourceOS, targetOSes, context: context ?? {}, userId });
  });
};
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
npx vitest run srv/__tests__/author-service-os-variants.test.js
```

Expected: PASS, all cases (validation 400s, success 200, rate-limit 429).

- [ ] **Step 6: Run the broader unit suite to confirm no AuthorService regression**

```bash
npx vitest run srv/__tests__/
```

Expected: existing AuthorService tests still green.

- [ ] **Step 7: Commit**

```bash
git branch --show-current
git add srv/author-service.cds srv/author-service.js srv/__tests__/author-service-os-variants.test.js
git commit -m "feat(173): wire POST /author/generateOsVariants action

CDS action declared on AuthorService (inherits @requires: 'Tutorial.Author'
from the service level). Handler validates input (1..8000 char source,
1..3 unique non-self target OSes), enforces a 60/hr/author rate limit via
the configurable chat-rate-limit, and delegates to the os-variant-generator
from Task 11.

Tests cover every 400 path, the success path (with the LLM mocked), and
the 429 rate-limit transition.

Spec §5.1, §5.2."
```

---

## Phase 4 — Deploy + docs (Tasks 13-15)

### Task 13: `srv-qa` cp list update in `.deploy/mta.yaml`

**Files:**
- Modify: `.deploy/mta.yaml`

**Background:** The `srv-qa` module's `cp` list is hand-curated. New transitive imports from `srv/lib/*` files crash QA boot at MTA deploy time — this has bit us repeatedly (see [[feedback_srv_qa_cp_list_recurring]], [[feedback_srv_qa_cp_list]]). Per [[feedback_check_srv_qa_when_changing_srv]], re-walk transitive `./` imports starting from `srv/lib/content-store.js` (the canonical reachability root) and add anything new.

- [ ] **Step 1: List current `srv-qa.cp` entries**

```bash
grep -n -A 100 "modules:" .deploy/mta.yaml | grep -E "name: srv-qa|cp:" | head -10
```

Identify the exact `cp:` block under the `srv-qa` module.

- [ ] **Step 2: Identify all `srv/lib/*` files reachable via `./` imports from `srv/lib/content-store.js`**

```bash
# Walk imports — start from the canonical root and any new entry points we added
grep -E "from '\./|from \"\./|require\('\./|require\(\"\./" srv/lib/content-store.js srv/lib/os-variant-generator.js srv/lib/author-ai-persist.js srv/lib/chat-rate-limit.js | sort -u
```

Cross-reference each import against the existing `srv-qa.cp` list. Likely additions for issue #173:

- `srv/lib/os-variant-generator.js`
- `srv/lib/author-ai-persist.js`

(Both new in this PR. `chat-rate-limit.js` already exists and should already be in the list — confirm.)

- [ ] **Step 3: Add the new files to `.deploy/mta.yaml` `srv-qa.cp` list**

Edit `.deploy/mta.yaml` and add entries alongside the existing `srv/lib/*.js` lines. Maintain alphabetical order if the existing list is alphabetical.

- [ ] **Step 4: Sanity-check by simulating the QA srv build target**

```bash
# The mta build copies the cp list into the staging dir — we can't run mbt
# in CI from here, but we can at least confirm the YAML still parses.
node -e "console.log(require('js-yaml').load(require('fs').readFileSync('.deploy/mta.yaml','utf8')).modules.find(m => m.name === 'srv-qa').\"build-parameters\" ? 'ok' : 'check yaml')"
```

Expected: `ok` printed.

- [ ] **Step 5: Commit**

```bash
git branch --show-current
git add .deploy/mta.yaml
git commit -m "build(173): add new srv/lib modules to srv-qa cp list

os-variant-generator.js and author-ai-persist.js are new transitive deps
from the AuthorService.generateOsVariants action. Without these in the
hand-curated srv-qa cp list, QA boot crashes at MTA deploy.

See feedback_srv_qa_cp_list_recurring."
```

---

### Task 14: Author docs — `writing-tutorials.md` §3.5 split

**Files:**
- Modify: `docs/authors/writing-tutorials.md`

**Background:** Per Tom's explicit callout — author adoption hinges on these docs. Section §3.5 today is a single short paragraph ([docs/authors/writing-tutorials.md:139-153](../../../docs/authors/writing-tutorials.md#L139-L153)). We split it into three sub-sections.

- [ ] **Step 1: Read existing §3.5 content for context**

```bash
sed -n '139,160p' docs/authors/writing-tutorials.md
```

- [ ] **Step 2: Replace §3.5 with the new structure**

Replace the existing `### 3.5 Option blocks` block (through to before `### 3.6 Code blocks`) with:

````markdown
### 3.5 Option blocks

When a step has variants, wrap each variant in an `OPTION` block. There are two flavors —
generic (per-step tabs) and OS-conditional (driven by a global picker at the top of the tutorial).

#### 3.5.1 Generic option blocks (Java vs Node, JSON vs XML, Cloud vs On-premise)

```markdown
[OPTION BEGIN [JSON]]
...content for the JSON path...
[OPTION END]

[OPTION BEGIN [XML]]
...content for the XML path...
[OPTION END]
```

The platform renders these as a tab strip inside the step. Each step's tabs are independent.

#### 3.5.2 OS-conditional content (Windows vs macOS vs Linux vs BAS) ★ NEW

When the variants are about the *operating system*, the platform automatically detects this and
wires every OS block on the page to a single global picker at the top of the tutorial. The reader
picks their OS once; their choice persists across tutorials.

Use any of these labels — they're all recognized:

| Canonical OS | Recognized labels                                        |
|--------------|----------------------------------------------------------|
| Windows      | `Windows`, `Win`, `Win32`, `Win64`                       |
| macOS        | `macOS`, `MacOS`, `Mac OS`, `Mac`, `OS X`, `Darwin`      |
| Linux        | `Linux`, `Ubuntu`, `Debian`, `Fedora`, `Unix`            |
| BAS          | `BAS`, `Business Application Studio`, `SAP BAS`          |

**Combined labels are fine** — `Mac and Linux` matches both, `Mac & Linux` likewise.

```markdown
[OPTION BEGIN [Windows]]
Open PowerShell and run `cd $HOME\projects`
[OPTION END]

[OPTION BEGIN [Mac and Linux]]
Open a terminal and run `cd ~/projects`
[OPTION END]
```

The reader sees only the variant matching their OS. Their choice persists across tutorials.

**Defaults & detection.** First-time visitors get auto-detected (Windows / macOS / Linux from
the browser; BAS detected when the tutorial is opened from inside Business Application Studio).
After they pick an OS, that choice is remembered.

**Missing variants.** When a step doesn't cover the reader's chosen OS, the platform shows the
closest match and a small banner: "No Linux instructions for this step — showing macOS." Use
this when one OS path is genuinely identical to another.

**Existing OS-tabbed tutorials get the picker for free.** No author migration required — the
heuristic detects OS-flavored OPTION blocks automatically.

**Author override.** If the auto-detection mis-classifies your tabs (e.g. you have a tab named
`Linux` that's actually about a Linux container product, not the OS), add to your frontmatter:

```yaml
osOverrides:
  step-3-deploy-the-app: regular   # force this step's group to NOT be OS-conditional
  step-5-install-cli:    os        # force this step's group to BE OS-conditional
```

The key is the slugified step heading.

#### 3.5.3 AI-assisted OS variants (VS Code) ★ NEW

The Tutorials VS Code extension can generate the missing OS variants for you. Write your step
for one OS, then ask the extension to "generate OS variants" — it returns translated Windows /
macOS / Linux / BAS blocks you can review and accept inline. See the
[VS Code extension docs](TODO: link added when plugin ships) for the workflow.

````

- [ ] **Step 3: Verify the docs site still builds**

```bash
npm run docs:build
```

Expected: clean build. The `predocs:build` sidebar guard catches unregistered pages and dead links.

- [ ] **Step 4: Commit**

```bash
git branch --show-current
git add docs/authors/writing-tutorials.md
git commit -m "docs(173): expand writing-tutorials §3.5 — generic + OS + AI options

Splits the existing one-paragraph 'Option blocks' section into three
subsections: generic OPTION blocks (unchanged), OS-conditional content with
the new global picker, and AI-assisted variant generation via the VS Code
extension. Tables every recognized OS label including combined forms.
Documents the osOverrides frontmatter escape hatch.

Author adoption requirement per Tom's spec callout. Spec §6.1."
```

---

### Task 15: Developer docs — `build.md` + `testing-endpoints.md`

**Files:**
- Modify: `docs/developers/architecture/build.md`
- Modify: `docs/developers/operations/testing-endpoints.md`

- [ ] **Step 1: Add a build-pipeline note in `build.md`**

Find the section describing `scripts/parsers/options.ts` (search `grep -n "options.ts" docs/developers/architecture/build.md`). Append:

```markdown
For OS-conditional content (Windows / macOS / Linux / BAS variants), the parser consults
`scripts/parsers/os-classifier.ts`, a fuzzy-match dictionary that canonicalizes the messy
real-world OS labels in OPTION blocks. OS-flavored groups emit a new `{{< os-options >}}`
shortcode (one panel per canonical OS, with combined labels like "Mac and Linux" duplicating
their body across multiple panels). The page-level `hasOsOptions: true` frontmatter flag is
auto-injected when any group on the page is classified OS — the OP layout uses it to
conditionally render the global OS picker. Author override via the `osOverrides:` frontmatter
key when the heuristic misclassifies. See the spec at
[docs/superpowers/specs/2026-06-09-173-os-conditional-content-design.md](../../superpowers/specs/2026-06-09-173-os-conditional-content-design.md).
```

- [ ] **Step 2: Add the new endpoint row in `testing-endpoints.md`**

Find the canonical endpoint table. Add a row:

```markdown
| `POST /author/generateOsVariants` | bearer | `Tutorial.Author` | 60/hr per author | AI-assisted OS variant generation for the VS Code authoring plugin. Request: `{ sourceMarkdown, sourceOS, targetOSes[], context? }`. Response: `{ variants[], model, tokensUsed, requestId }`. See spec [#173](../../../superpowers/specs/2026-06-09-173-os-conditional-content-design.md) §5. |
```

(Match the column count + header order of the existing table.)

- [ ] **Step 3: Verify the docs site still builds**

```bash
npm run docs:build
```

Expected: clean build, no dead links flagged by `predocs:build`.

- [ ] **Step 4: Commit**

```bash
git branch --show-current
git add docs/developers/architecture/build.md docs/developers/operations/testing-endpoints.md
git commit -m "docs(173): note os-classifier in build pipeline; add /author/generateOsVariants endpoint

build.md describes how options.ts now consults os-classifier.ts and emits
the new os-options shortcode for OS-flavored groups. testing-endpoints.md
gets the canonical row for the new POST /author/generateOsVariants action
(bearer + Tutorial.Author scope, 60/hr rate limit).

Spec §6.2-6.3."
```

---

## Phase 5 — Tests beyond unit (Tasks 16-17)

### Task 16: Hybrid AI test (`HYBRID_AI_TESTS=true`-gated)

**Files:**
- Create: `test/hybrid/author-service-os-variants.test.js`

**Background:** Same opt-in pattern as the categories classifier hybrid test (see [[project_201_categories_facet]] and the project README's note on `HYBRID_AI_TESTS=true`). Default `npm run test:hybrid` stays $0/run; CI runs without this flag.

- [ ] **Step 1: Read the categories classifier hybrid test for the pattern**

```bash
ls test/hybrid/ | grep -i categor
test -f test/hybrid/categories-classifier.test.js && head -40 test/hybrid/categories-classifier.test.js
```

- [ ] **Step 2: Create the new hybrid test**

```js
// test/hybrid/author-service-os-variants.test.js
import { describe, it, expect, beforeAll } from 'vitest';
import cds from '@sap/cds';
import './_guard.js'; // hybrid write-safety guard

const HYBRID_AI = process.env.HYBRID_AI_TESTS === 'true';

describe.skipIf(!HYBRID_AI)('AuthorService.generateOsVariants — hybrid (real AI Core)', () => {
  let srv;

  beforeAll(async () => {
    srv = await cds.connect.to('AuthorService');
  });

  it('returns valid markdown variants for a Windows -> macOS+Linux PowerShell snippet', async () => {
    const result = await srv.send('generateOsVariants', {
      sourceMarkdown: 'Open PowerShell and run:\n\n```powershell\ncd $HOME\\projects\nnpm install\n```',
      sourceOS: 'Windows',
      targetOSes: ['macOS', 'Linux'],
      context: { tutorialSlug: '__TEST__os-variants', stepHeading: 'Setup' },
    });

    expect(result.variants).toHaveLength(2);
    expect(result.variants[0].os).toBe('macOS');
    expect(result.variants[1].os).toBe('Linux');

    // macOS body should mention "Terminal" or "bash" and use ~/  paths
    const mac = result.variants[0].markdown.toLowerCase();
    expect(mac).toMatch(/terminal|bash/);
    expect(mac).toMatch(/~\//);

    // Linux body should similarly
    const linux = result.variants[1].markdown.toLowerCase();
    expect(linux).toMatch(/terminal|bash/);

    // Neither should contain the source's PowerShell-specific tokens
    expect(mac).not.toContain('powershell');
    expect(linux).not.toContain('powershell');

    expect(result.requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(result.tokensUsed).toBeGreaterThan(0);
  }, 60_000); // generous timeout — real LLM call
});
```

- [ ] **Step 3: Verify the test SKIPS without the env flag**

```bash
npx vitest run test/hybrid/author-service-os-variants.test.js
```

Expected: SKIP (default `HYBRID_AI_TESTS` is unset).

- [ ] **Step 4: (Optional) Verify the test PASSES with the env flag — only if `cf login` is active**

```bash
HYBRID_AI_TESTS=true npm run test:hybrid -- --run test/hybrid/author-service-os-variants.test.js
```

Expected: PASS, with one real AI Core call. (This costs quota — only run when needed.)

- [ ] **Step 5: Commit**

```bash
git branch --show-current
git add test/hybrid/author-service-os-variants.test.js
git commit -m "test(173): hybrid test for /author/generateOsVariants

Default-skipped — opt in via HYBRID_AI_TESTS=true (mirrors the categories
classifier hybrid test). Asserts the LLM produces non-empty variants for
both target OSes, that they contain target-OS shell tokens (Terminal,
bash, ~/) and don't echo source-OS tokens (powershell), and that the
audit metadata (requestId, tokensUsed) round-trips.

Spec §8."
```

---

### Task 17: Smoke test for auth/scope

**Files:**
- Create or modify: `test/smoke/author-api.test.js`

**Background:** Smoke tests run HTTP-level against deployed URLs (`SMOKE_BASE_URL` / `SMOKE_SRV_URL`). We assert the auth gate behaves correctly without making a real LLM call.

- [ ] **Step 1: Check whether a smoke file already exists for AuthorService**

```bash
ls test/smoke/ | grep -i author
```

- [ ] **Step 2: Add the auth-gate smoke test**

If a file exists, append; otherwise create `test/smoke/author-api.test.js`:

```js
import { describe, it, expect } from 'vitest';

const SRV = process.env.SMOKE_SRV_URL;

describe.skipIf(!SRV)('POST /author/generateOsVariants — auth gate', () => {
  it('returns 401 without a bearer token', async () => {
    const r = await fetch(`${SRV}/author/generateOsVariants`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sourceMarkdown: 'x', sourceOS: 'Windows', targetOSes: ['macOS'], context: {},
      }),
    });
    expect(r.status).toBe(401);
  });

  it('returns 403 with an authenticated token that lacks Tutorial.Author scope', async () => {
    if (!process.env.SMOKE_NON_AUTHOR_TOKEN) return; // env-gated — only run when token is provided
    const r = await fetch(`${SRV}/author/generateOsVariants`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.SMOKE_NON_AUTHOR_TOKEN}`,
      },
      body: JSON.stringify({
        sourceMarkdown: 'x', sourceOS: 'Windows', targetOSes: ['macOS'], context: {},
      }),
    });
    expect(r.status).toBe(403);
  });
});
```

- [ ] **Step 3: Commit**

```bash
git branch --show-current
git add test/smoke/author-api.test.js
git commit -m "test(173): smoke test for /author/generateOsVariants auth gate

Asserts 401 without bearer and 403 with a non-author token. The 403 case
is gated on SMOKE_NON_AUTHOR_TOKEN env var being set so CI doesn't fail
when the optional non-author smoke token isn't present.

No LLM call — pure auth gating.

Spec §8."
```

---

## Phase 6 — Final verification (Task 18)

### Task 18: Full unit suite + line-ending sweep + branch check + open PR

**Files:** none modified — verification only.

- [ ] **Step 1: Confirm we're on the feature branch**

```bash
git branch --show-current
```

Expected: `feat/173-os-conditional-content`. Per [[feedback_verify_branch_before_commit]] never assume — re-check in the same Bash invocation as anything that mutates git state.

- [ ] **Step 2: Run the full scoped unit suite**

```bash
npx vitest run scripts/__tests__/ srv/__tests__/ srv/lib/__tests__/ hugo/assets/js/__tests__/
```

Expected: all green. (Avoid bare `npm test` — see [[feedback_worktree_tests_hang]].)

- [ ] **Step 3: Run the smoke and hybrid suites in their default-skip mode**

```bash
npx vitest run test/smoke/ test/hybrid/
```

Expected: most tests skip (no `SMOKE_*` / `HYBRID_AI_TESTS` env), but the runner exits 0.

- [ ] **Step 4: Sweep for accidental CRLF**

```bash
file scripts/parsers/os-classifier.ts \
     hugo/assets/js/os-toggle.ts \
     hugo/layouts/shortcodes/os-options.html \
     hugo/layouts/shortcodes/os-panel.html \
     hugo/assets/css/os-toggle.css \
     srv/lib/os-variant-generator.js \
     srv/lib/author-ai-persist.js \
     test/hybrid/author-service-os-variants.test.js \
     test/smoke/author-api.test.js
```

Expected: NONE report "CRLF line terminators". If any do, normalize via Node before pushing — see [[feedback_crlf_regression_on_windows]].

- [ ] **Step 5: Build the docs site one more time**

```bash
npm run docs:build
```

Expected: clean — sidebar guard passes, no dead links.

- [ ] **Step 6: Build the apps to confirm no Vite/TS regressions**

```bash
npm run build:apps
```

Expected: clean.

- [ ] **Step 7: Push the branch**

```bash
git branch --show-current  # feat/173-os-conditional-content
git push -u origin feat/173-os-conditional-content
```

- [ ] **Step 8: Open the PR**

```bash
gh pr create \
  --title "feat(173): OS-conditional content with AI-assisted authoring" \
  --body "$(cat <<'PRBODY'
Closes #173.

## What

- Reader-side global OS picker (Windows / macOS / Linux / BAS) at the top of any tutorial that contains OS-flavored OPTION blocks. Auto-detects browser OS with BAS heuristic, persists via localStorage. Mirrors the codetabs.ts cross-block sync pattern.
- Build-time classifier (\`scripts/parsers/os-classifier.ts\`) that fuzzy-matches messy real-world OS labels (Windows, MacOS, Mac and Linux, etc.) into the four canonical values. Author override via \`osOverrides:\` frontmatter when the heuristic misclassifies. Existing OS-tabbed tutorials get the picker for free — no migration.
- Authoring API: \`POST /author/generateOsVariants\` on \`AuthorService\` (XSUAA scope \`Tutorial.Author\`), called by the VS Code authoring plugin. Returns generated variants as markdown; plugin owns the insertion UX. New \`AuthorAiRequests\` entity persists request + response for future eval work.
- Author + developer docs updated (writing-tutorials.md §3.5 split into generic / OS / AI subsections; testing-endpoints.md gets the new endpoint row).

## Spec & plan

- Spec: [docs/superpowers/specs/2026-06-09-173-os-conditional-content-design.md](docs/superpowers/specs/2026-06-09-173-os-conditional-content-design.md)
- Plan: [docs/superpowers/plans/2026-06-09-173-os-conditional-content.md](docs/superpowers/plans/2026-06-09-173-os-conditional-content.md)

## Test plan

- Unit: \`scripts/__tests__/os-classifier.test.ts\`, \`scripts/__tests__/options-hugo.test.ts\` (extended), \`hugo/assets/js/__tests__/os-toggle.test.ts\`, \`srv/lib/__tests__/os-variant-generator.test.js\`, \`srv/__tests__/author-service-os-variants.test.js\`, \`srv/lib/__tests__/chat-rate-limit.test.js\`.
- Hybrid (\`HYBRID_AI_TESTS=true\` gate): \`test/hybrid/author-service-os-variants.test.js\` — one real AI Core round-trip.
- Smoke: \`test/smoke/author-api.test.js\` — auth gate (401/403) on the deployed endpoint.
- Manual: open a known OS-tabbed tutorial (e.g. \`btp-cli-setup-kyma-cluster\`), verify picker appears, switch OSes, refresh, verify persistence. Open from BAS, verify BAS auto-detected.

## Notes

- \`srv-qa.cp\` list updated with new \`srv/lib/os-variant-generator.js\` + \`author-ai-persist.js\` per [[feedback_srv_qa_cp_list_recurring]].
- New \`AuthorAiRequests\` entity must deploy cleanly to both prod and QA HDI containers — schema-drift-check workflow validates on PR.
- AI is authoring-time only; readers never trigger an LLM call.
PRBODY
)"
```

- [ ] **Step 9: Confirm CI is green**

Watch the PR for green checks (deploy, smoke, schema-drift). If any fail, fix in-branch before requesting review.

- [ ] **Step 10: Request review**

Tag the maintainer and let them know the spec + plan are linked in the PR description. Per [[feedback_pr_over_direct_merge]] this PR goes through review, not direct merge.

---

## Cross-task reminders (recap)

| Concern                   | Mitigation                                                        | Memory                                                |
|---------------------------|-------------------------------------------------------------------|-------------------------------------------------------|
| CRLF on Windows           | `file <path>` after every multi-section edit                      | [[feedback_crlf_regression_on_windows]]               |
| Branch silently flipping  | `git branch --show-current` in same Bash invocation as commit     | [[feedback_verify_branch_before_commit]]              |
| `npm test` hangs          | Use scoped `npx vitest run <subdir>` instead                      | [[feedback_worktree_tests_hang]]                      |
| `srv-qa` cp list          | Re-walk transitive `./` imports from `content-store.js`           | [[feedback_srv_qa_cp_list_recurring]]                 |
| HTML-property hook block  | Use `createElement` + `appendChild` in JS test fixtures           | [[feedback_html_property_blocked_by_hook]]            |
| `cds.entities` runtime    | Persist helper handles unbooted CDS gracefully                    | [[feedback_cds_entities_runtime_only]]                |
| UI5 v2 dialog/segmented   | Use `selected` attribute + `selection-change` event               | [[feedback_ui5_dialog_open_property]]                 |

## Out of scope (recap from spec §9)

1. Per-tutorial dynamic OS toggle options.
2. Profile-level (DB-backed) OS preference.
3. AI-driven runtime rewrites (reader never triggers AI).
4. Bulk-migration tool (no batch AI-generation across all tutorials).
5. Feedback signal endpoint for `requestId`.
6. Eval harness for `AuthorAiRequests` rows.
7. Telemetry on OS toggle clicks.

```
```
```