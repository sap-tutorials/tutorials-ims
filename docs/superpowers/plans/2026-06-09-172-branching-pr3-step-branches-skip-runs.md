# 172 PR 3 — Step-Level Branches + Skip-Runs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Tutorial authors can declare alternative step-runs (`[BRANCH_BEGIN]…[BRANCH_END]`) and skippable steps (`skipIf:` frontmatter) in markdown; runtime computes a per-user recommendation; tutorials render a Vue island with a branch picker + skip prompt; the same island also handles the mission-side-nav highlight from PR 2. Author docs ship in this PR. Behind `branchingEnabled = false`.

> **⚠️ Reviewer addendum (apply before starting — see end of file).** PR 3 plan-review found 6 real issues, biggest first: (1) **Missing `TutorialMeta` persistence path for `branchPoints`/`skipPoints`** — the decide endpoint reads from HANA but no task writes them there; (2) `BranchDecisions` telemetry write missing in the decide handler; (3) `/api/branches/choice` POST is referenced by the Vue island but never created; (4) Hugo template snippet missing `{{ range .Params.branchPoints }}…{{ end }}` wrapper; (5) Branch sub-step content rendering not designed (parser slices them OUT — UI tries to show/hide divs that don't exist); (6) `parseCondition` cross-boundary import (scripts/parsers → srv/lib) is fragile. **See "Reviewer addendum" section at the end of this plan for corrected snippets.**

**Architecture:** A new pre-step parser (`scripts/parsers/branches.ts`) runs **before** the v2 step-walker, slicing branch sub-steps out of the markdown so the existing step parser sees a single linear stream. Branch + skip metadata is emitted into Hugo step frontmatter. A new `/api/branches/decide?slug=X` endpoint hydrates the recommendation client-side. A new `hugo-apps/src/tutorial-branches/` Vue 3 island renders the picker + skip prompt and also retro-actively highlights mission-side-nav chips.

**Tech Stack:** TypeScript parser, vitest unit, Hugo + UI5 web components, Vue 3 (single-file components), Vite (`base: '/js/'` per [[feedback_vite_chunks_need_base]]).

**Spec section refs:** §2.2 / §4.2 (markdown directives), §5.2.2 (decide endpoint), §5.3.2 / §5.3.3 (Vue island), §5.7 (localStorage keys), §8.3 (anti-pitfalls).

**Depends on:** PR 1 + PR 2 merged.

---

## File Structure

**Create (8 files):**
- `scripts/parsers/branches.ts` — pre-step parser; slices `[BRANCH_BEGIN…END]` out of markdown, emits `branchPoints` array
- `scripts/parsers/__tests__/branches.test.ts` — exhaustive parser tests
- `srv/lib/branch/decide-handler.js` — `GET /api/branches/decide?slug=X` returning recommendation per branch point + skip point
- `test/api-branches-decide.test.js` — endpoint tests
- `hugo-apps/src/tutorial-branches/main.ts` — entry; mounts Vue app on `[data-branch-points]`
- `hugo-apps/src/tutorial-branches/TutorialBranches.vue` — branch picker + skip prompt SFC
- `hugo-apps/src/tutorial-branches/branches.css` — shared styles (NOT scoped — see [[feedback_vue_scoped_css_doesnt_propagate_to_child_descendants]])
- `hugo-apps/src/tutorial-branches/__tests__/TutorialBranches.test.ts` — component tests

**Modify (10 files):**
- `scripts/parsers/index.ts` (or wherever the parse pipeline is composed) — call `branches.ts` before `v2.ts`
- `scripts/parsers/frontmatter.ts` — accept `skipIf` / `skipLabel` / `skipReason` per-step
- `scripts/parsers/types.ts` — add `BranchPoint` and `SkipPoint` types
- `hugo/layouts/_default/single.html` (or the v2 tutorial layout) — emit branch metadata + mount points
- `hugo/layouts/partials/header.html` (or wherever islands' `<script>` tags live) — add tag for `tutorial-branches.js`
- `hugo-apps/vite.config.ts` — register `tutorial-branches` entry; budget plugin
- `srv/server.js` — register `app.get('/api/branches/decide', decideHandler)`
- `scripts/lint-tutorial-markdown.ts` — add lint rules for branch-marker hygiene
- `.deploy/mta.yaml` — register `srv/lib/branch/decide-handler.js` in srv-qa cp list
- `docs/authors/branched-tutorials.md` (new) + `docs/authors/branching-cookbook.md` (new) + sidebar registration + dev architecture doc

**No new npm dependencies.**

---

## Task 1: Type definitions + frontmatter additions

**Files:**
- Modify: `scripts/parsers/types.ts`
- Modify: `scripts/parsers/frontmatter.ts`

- [ ] **Step 1: Add types**

In `scripts/parsers/types.ts`, append:

```typescript
// Issue #172 — step-level branches inside one tutorial.
export interface BranchAlternative {
  key: string;
  label: string;
  condition: string | null;
  steps: BranchStep[];
}

export interface BranchStep {
  title: string;
  content: string;
}

export interface BranchPoint {
  id: string;                  // deterministic — `${parentStepNumber}#${groupKey}`
  groupKey: string;
  parentStepNumber: number;
  branches: BranchAlternative[];
}

export interface SkipPoint {
  stepNumber: number;
  skipIf: string;
  skipLabel: string;
  skipReason: string | null;
}
```

Extend the existing `TutorialStep`:

```typescript
export interface TutorialStep {
  number: number;
  title: string;
  content: string;
  branchPoint?: BranchPoint;
  skipIf?: string;
  skipLabel?: string;
  skipReason?: string | null;
}
```

- [ ] **Step 2: Make frontmatter parser pass through `skipIf`**

In `scripts/parsers/frontmatter.ts`, ensure that per-step frontmatter parsing preserves `skipIf`/`skipLabel`/`skipReason` keys when present.

- [ ] **Step 3: Commit**

```bash
git add scripts/parsers/types.ts scripts/parsers/frontmatter.ts
git commit -m "feat(172): types for BranchPoint/SkipPoint + skipIf frontmatter passthrough"
```

---

## Task 2: Branch markdown parser (pre-step pass)

**Files:**
- Create: `scripts/parsers/branches.ts`
- Test: `scripts/parsers/__tests__/branches.test.ts`

- [ ] **Step 1: Write the failing test**

Create `scripts/parsers/__tests__/branches.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { extractBranchBlocks, BranchParseError } from '../branches.js';

describe('extractBranchBlocks - happy path', () => {
  it('extracts one branch block with two alternatives', () => {
    const md = [
      '### Step 3 - Configure your database',
      '',
      "[BRANCH_BEGIN group=\"deployment\" key=\"hana\" label=\"HANA Cloud\" condition=\"profile.deployment == 'cloud'\"]",
      '',
      '### Step 3a - Configure HANA Cloud',
      'HANA setup steps.',
      '',
      '### Step 3b - Verify HANA connection',
      'Verification.',
      '',
      '[BRANCH_END]',
      '',
      "[BRANCH_BEGIN group=\"deployment\" key=\"postgres\" label=\"PostgreSQL\"]",
      '',
      '### Step 3a - Configure PostgreSQL',
      'PG setup.',
      '',
      '[BRANCH_END]',
      '',
      '### Step 4 - Continue',
      'Continuation.',
    ].join('\n');

    const { branchPoints, rewrittenMarkdown } = extractBranchBlocks(md);
    expect(branchPoints).toHaveLength(1);
    const bp = branchPoints[0];
    expect(bp.groupKey).toBe('deployment');
    expect(bp.branches).toHaveLength(2);
    expect(bp.branches[0].key).toBe('hana');
    expect(bp.branches[0].label).toBe('HANA Cloud');
    expect(bp.branches[0].condition).toBe("profile.deployment == 'cloud'");
    expect(bp.branches[0].steps).toHaveLength(2);
    expect(bp.branches[1].key).toBe('postgres');
    expect(bp.branches[1].condition).toBeNull();
    expect(rewrittenMarkdown).toContain('### Step 3 - Configure your database');
    expect(rewrittenMarkdown).toContain('### Step 4 - Continue');
    expect(rewrittenMarkdown).not.toContain('### Step 3a');
    expect(rewrittenMarkdown).not.toContain('[BRANCH_BEGIN');
  });

  it('parentStepNumber is set to the step ABOVE the block', () => {
    const md = [
      '### Step 1', 'A',
      '### Step 2', 'B',
      '[BRANCH_BEGIN group="x" key="a" label="A"]',
      '### Step 2a', 'x',
      '[BRANCH_END]',
      '[BRANCH_BEGIN group="x" key="b" label="B"]',
      '### Step 2b', 'y',
      '[BRANCH_END]',
      '### Step 3', 'C',
    ].join('\n');
    const { branchPoints } = extractBranchBlocks(md);
    expect(branchPoints[0].parentStepNumber).toBe(2);
  });
});

describe('extractBranchBlocks - validation', () => {
  it('rejects mismatched group keys within consecutive blocks', () => {
    const md = [
      '### Step 1',
      '[BRANCH_BEGIN group="x" key="a" label="A"]',
      '### S', 'x',
      '[BRANCH_END]',
      '[BRANCH_BEGIN group="y" key="b" label="B"]',
      '### T', 'y',
      '[BRANCH_END]',
    ].join('\n');
    expect(() => extractBranchBlocks(md)).toThrow(BranchParseError);
  });

  it('rejects duplicate keys within one group', () => {
    const md = [
      '### Step 1',
      '[BRANCH_BEGIN group="x" key="dup" label="A"]',
      '### S',
      '[BRANCH_END]',
      '[BRANCH_BEGIN group="x" key="dup" label="B"]',
      '### T',
      '[BRANCH_END]',
    ].join('\n');
    expect(() => extractBranchBlocks(md)).toThrow(/duplicate/i);
  });

  it('rejects unbalanced markers', () => {
    const md = [
      '[BRANCH_BEGIN group="x" key="a" label="A"]',
      '### S',
    ].join('\n');
    expect(() => extractBranchBlocks(md)).toThrow(/unbalanced|unclosed/i);
  });

  it('rejects nested branches', () => {
    const md = [
      '[BRANCH_BEGIN group="x" key="a" label="A"]',
      '[BRANCH_BEGIN group="y" key="b" label="B"]',
      '### S',
      '[BRANCH_END]',
      '[BRANCH_END]',
    ].join('\n');
    expect(() => extractBranchBlocks(md)).toThrow(/nested/i);
  });

  it('rejects single-member alt-group', () => {
    const md = [
      '### Step 1',
      '[BRANCH_BEGIN group="x" key="a" label="A"]',
      '### S',
      '[BRANCH_END]',
      '### Step 2',
    ].join('\n');
    expect(() => extractBranchBlocks(md)).toThrow(/single-member/i);
  });

  it('rejects condition that does not parse', () => {
    const md = [
      '### Step 1',
      '[BRANCH_BEGIN group="x" key="a" label="A" condition="this is junk"]',
      '### S',
      '[BRANCH_END]',
      '[BRANCH_BEGIN group="x" key="b" label="B"]',
      '### T',
      '[BRANCH_END]',
    ].join('\n');
    expect(() => extractBranchBlocks(md)).toThrow(/condition/i);
  });

  it('rejects branch block before any step (no parent)', () => {
    const md = [
      '[BRANCH_BEGIN group="x" key="a" label="A"]',
      '### S',
      '[BRANCH_END]',
      '[BRANCH_BEGIN group="x" key="b" label="B"]',
      '### T',
      '[BRANCH_END]',
    ].join('\n');
    expect(() => extractBranchBlocks(md)).toThrow(/parent step/i);
  });
});

describe('extractBranchBlocks - no branches', () => {
  it('returns empty branchPoints and original markdown unchanged', () => {
    const md = '### Step 1\nA\n\n### Step 2\nB';
    const { branchPoints, rewrittenMarkdown } = extractBranchBlocks(md);
    expect(branchPoints).toEqual([]);
    expect(rewrittenMarkdown).toBe(md);
  });
});
```

- [ ] **Step 2: Run the failing test**

Run: `npx vitest run scripts/parsers/__tests__/branches.test.ts --project unit`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the parser**

Create `scripts/parsers/branches.ts`:

```typescript
// scripts/parsers/branches.ts
//
// Pre-step pass: slice [BRANCH_BEGIN ... BRANCH_END] blocks out of v2 markdown,
// returning { rewrittenMarkdown, branchPoints }. The v2 step-walker runs on
// rewrittenMarkdown and never sees branch sub-steps; branch metadata is
// attached to the parent step downstream.
//
// Spec: docs/superpowers/specs/2026-06-09-172-branching-paths-design.md §4.2

import type { BranchAlternative, BranchPoint, BranchStep } from './types.js';
import { parseCondition, ConditionParseError } from '../../srv/lib/branch/condition.js';

export class BranchParseError extends Error {
  constructor(message: string) { super(message); this.name = 'BranchParseError'; }
}

const BEGIN_RE = /^\s*\[BRANCH_BEGIN\s+([^\]]+)\]\s*$/;
const END_RE   = /^\s*\[BRANCH_END\]\s*$/;
const H3_RE    = /^### (.+)$/;
const ATTR_RE  = /(\w+)\s*=\s*"([^"]*)"/g;

interface RawAttrs { group?: string; key?: string; label?: string; condition?: string; }

function parseAttrs(raw: string): RawAttrs {
  const out: RawAttrs = {};
  // String#matchAll keeps us off RegExp.prototype.exec
  for (const m of raw.matchAll(ATTR_RE)) {
    const [, k, v] = m;
    if (k === 'group' || k === 'key' || k === 'label' || k === 'condition') out[k] = v;
  }
  return out;
}

function slugifyKey(label: string): string {
  return label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
}

export function extractBranchBlocks(markdown: string): { rewrittenMarkdown: string; branchPoints: BranchPoint[] } {
  const lines = markdown.split('\n');
  const branchPoints: BranchPoint[] = [];
  const outLines: string[] = [];

  let currentStepNumber = 0;
  let groupOfRun: string | null = null;
  let alternativesOfRun: BranchAlternative[] = [];
  let parentStepOfRun = 0;

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    if (H3_RE.test(line)) {
      if (alternativesOfRun.length > 0) commitBranchPoint();
      currentStepNumber++;
      outLines.push(line);
      i++;
      continue;
    }

    const beginMatch = line.match(BEGIN_RE);
    if (beginMatch) {
      const attrs = parseAttrs(beginMatch[1]);
      if (!attrs.group) throw new BranchParseError(`BRANCH_BEGIN missing group= attribute (line ${i + 1})`);
      if (!attrs.label) throw new BranchParseError(`BRANCH_BEGIN missing label= attribute (line ${i + 1})`);
      const key = attrs.key || slugifyKey(attrs.label);

      if (currentStepNumber === 0) throw new BranchParseError(`branch block has no parent step above it (line ${i + 1})`);
      if (groupOfRun && groupOfRun !== attrs.group) {
        throw new BranchParseError(`mismatched group: expected '${groupOfRun}' but got '${attrs.group}' (line ${i + 1})`);
      }
      if (groupOfRun === null) {
        groupOfRun = attrs.group;
        parentStepOfRun = currentStepNumber;
      }
      if (alternativesOfRun.some(a => a.key === key)) {
        throw new BranchParseError(`duplicate key='${key}' within group='${attrs.group}' (line ${i + 1})`);
      }

      if (attrs.condition) {
        try { parseCondition(attrs.condition); }
        catch (err) {
          if (err instanceof ConditionParseError) {
            throw new BranchParseError(`condition does not parse: ${err.message} (line ${i + 1})`);
          }
          throw err;
        }
      }

      i++;
      const innerLines: string[] = [];
      while (i < lines.length && !END_RE.test(lines[i])) {
        if (BEGIN_RE.test(lines[i])) {
          throw new BranchParseError(`nested BRANCH_BEGIN not allowed (line ${i + 1})`);
        }
        innerLines.push(lines[i]);
        i++;
      }
      if (i >= lines.length) throw new BranchParseError(`unbalanced BRANCH_BEGIN - missing BRANCH_END`);
      i++;

      const branchSteps: BranchStep[] = parseInnerSteps(innerLines);
      if (branchSteps.length === 0) throw new BranchParseError(`branch '${key}' is empty`);

      alternativesOfRun.push({ key, label: attrs.label, condition: attrs.condition || null, steps: branchSteps });
      continue;
    }

    outLines.push(line);
    i++;
  }

  if (alternativesOfRun.length > 0) commitBranchPoint();

  return { rewrittenMarkdown: outLines.join('\n'), branchPoints };

  function commitBranchPoint() {
    if (alternativesOfRun.length < 2) {
      throw new BranchParseError(
        `single-member alt-group at parent step ${parentStepOfRun} (group='${groupOfRun}') - alt-groups need >= 2 branches`
      );
    }
    branchPoints.push({
      id: `${parentStepOfRun}#${groupOfRun}`,
      groupKey: groupOfRun!,
      parentStepNumber: parentStepOfRun,
      branches: alternativesOfRun,
    });
    groupOfRun = null;
    alternativesOfRun = [];
    parentStepOfRun = 0;
  }
}

function parseInnerSteps(lines: string[]): BranchStep[] {
  const steps: BranchStep[] = [];
  let title = '';
  let buf: string[] = [];
  let inStep = false;
  for (const l of lines) {
    const m = l.match(H3_RE);
    if (m) {
      if (inStep) steps.push({ title, content: buf.join('\n').trim() });
      title = m[1].trim();
      buf = [];
      inStep = true;
      continue;
    }
    if (inStep) buf.push(l);
  }
  if (inStep) steps.push({ title, content: buf.join('\n').trim() });
  return steps;
}
```

- [ ] **Step 4: Run the parser tests**

Run: `npx vitest run scripts/parsers/__tests__/branches.test.ts --project unit`
Expected: 9 tests pass.

- [ ] **Step 5: Wire into the parse pipeline**

Inspect: `grep -n "parseV2Steps\|extractBranchBlocks" D:/projects/tutorials-poc/scripts/parsers/index.ts D:/projects/tutorials-poc/scripts/parsers/v2.ts D:/projects/tutorials-poc/scripts/fetch-tutorials.ts 2>/dev/null`

In whichever module composes v2 parsing (likely `scripts/parsers/index.ts` or `scripts/fetch-tutorials.ts`), call `extractBranchBlocks` BEFORE `parseV2Steps`:

```typescript
import { extractBranchBlocks } from './branches.js';

// when parser=v2:
const { rewrittenMarkdown, branchPoints } = extractBranchBlocks(rawBody);
const steps = parseV2Steps(rewrittenMarkdown);
for (const bp of branchPoints) {
  const parent = steps.find(s => s.number === bp.parentStepNumber);
  if (parent) parent.branchPoint = bp;
}
```

V1 (legacy ACCORDION) tutorials are NOT supported; if a v1 tutorial contains `[BRANCH_BEGIN]`, log a warning and skip the branch extraction (do not fail the build).

- [ ] **Step 6: Commit**

```bash
git add scripts/parsers/branches.ts scripts/parsers/__tests__/branches.test.ts scripts/parsers/index.ts scripts/parsers/v2.ts
git commit -m "feat(172): branches.ts pre-step parser; v2 pipeline integration"
```

---

## Task 3: Hugo emits branchPoints into step frontmatter + mount points

**Files:**
- Modify: `scripts/parsers/render-frontmatter.ts` (or wherever frontmatter is serialised for Hugo)
- Modify: `hugo/layouts/_default/single.html` (or the v2 tutorial layout)

- [ ] **Step 1: Serialise branchPoints into the per-tutorial frontmatter**

In `scripts/parsers/render-frontmatter.ts`, when emitting steps, include `branchPoint` and `skipIf`/`skipLabel`/`skipReason` if present.

- [ ] **Step 2: Hugo template renders mount points**

In the tutorial layout (search: `grep -rn "tutorial-data\|step-validation-mount" D:/projects/tutorials-poc/hugo/layouts/`), add:

```hugo
{{ if .Params.branchPoints }}
<script id="tutorial-branch-points" type="application/json">
{{ .Params.branchPoints | jsonify }}
</script>
{{ end }}
```

Between steps (where the parser said the branch sits below step N), emit a mount:

```hugo
<div class="tutorial-branch-mount" data-branch-point-id="{{ .id }}" data-parent-step="{{ .parentStepNumber }}"></div>
```

- [ ] **Step 3: Skip-prompt mount point**

For each step that has `skipIf`, emit:

```hugo
<div class="tutorial-skip-mount" data-step-number="{{ .number }}"></div>
```

- [ ] **Step 4: Hugo dev server smoke**

```bash
npm run fetch-tutorials
npm run dev
```

For any tutorial without branches, page renders identically. For one with seeded branches, mount points are present.

- [ ] **Step 5: Commit**

```bash
git add scripts/parsers/render-frontmatter.ts hugo/layouts/
git commit -m "feat(172): Hugo emits branchPoints + skipPoints; mount points in tutorial layout"
```

---

## Task 4: `/api/branches/decide` endpoint

**Files:**
- Create: `srv/lib/branch/decide-handler.js`
- Test: `test/api-branches-decide.test.js`
- Modify: `srv/server.js`

- [ ] **Step 1: Write the failing endpoint test**

Create `test/api-branches-decide.test.js`:

```javascript
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import cds from '@sap/cds';

const project = cds.test('serve', '--project', '.', '--in-memory');

const TUT_ID = '55555555-9400-0000-0000-000000000010';

describe('GET /api/branches/decide', () => {
  beforeAll(async () => {
    const { Tutorials } = cds.entities('com.sap.developers.ims');
    await INSERT.into(Tutorials).entries({ ID: TUT_ID, legacyId: 99400, slug: '__test__-decide-tut', title: 'T', status: 'ACTIVE' });
  });
  afterAll(async () => {
    const { Tutorials } = cds.entities('com.sap.developers.ims');
    await DELETE.from(Tutorials).where({ ID: TUT_ID });
  });

  it('returns 404 when branchingEnabled is false', async () => {
    const { ChatSettings } = cds.entities('com.sap.developers.ims');
    await UPSERT.into(ChatSettings).entries({ ID: 'singleton', branchingEnabled: false });
    const res = await project.get('/api/branches/decide?slug=__test__-decide-tut').catch(e => e);
    expect(res.response?.status || res.status).toBe(404);
  });

  it('returns empty branchPoints + skipPoints when tutorial has neither', async () => {
    const { ChatSettings } = cds.entities('com.sap.developers.ims');
    await UPSERT.into(ChatSettings).entries({ ID: 'singleton', branchingEnabled: true });
    const { status, data } = await project.get('/api/branches/decide?slug=__test__-decide-tut');
    expect(status).toBe(200);
    expect(data).toEqual({ branchPoints: [], skipPoints: [] });
  });

  it('returns 400 when slug is missing', async () => {
    const res = await project.get('/api/branches/decide').catch(e => e);
    expect(res.response?.status || res.status).toBe(400);
  });
});
```

- [ ] **Step 2: Run the failing test**

Run: `npx vitest run test/api-branches-decide.test.js --project unit`
Expected: FAIL.

- [ ] **Step 3: Implement the handler**

Create `srv/lib/branch/decide-handler.js`:

```javascript
// srv/lib/branch/decide-handler.js
//
// GET /api/branches/decide?slug=X
// Spec: docs/superpowers/specs/2026-06-09-172-branching-paths-design.md §5.2.2

import cds from '@sap/cds';
import { pickBranch, evaluateSkip } from './engine.js';
import { rankBranches } from './ranker.js';
import { buildUserState } from './user-state.js';
import { makeBranchLoaders } from './loaders.js';

const LOG = cds.log('branches-decide');

async function loadTutorialBranchMetadata(slug) {
  const { Tutorials, TutorialMeta } = cds.entities('com.sap.developers.ims');
  const tut = await SELECT.one.from(Tutorials).columns('ID').where({ slug: slug.toLowerCase() });
  if (!tut?.ID) return null;
  const meta = await SELECT.one.from(TutorialMeta).where({ tutorial_ID: tut.ID });
  return {
    branchPoints: meta?.branchPoints ? safeJSON(meta.branchPoints) : [],
    skipPoints:   meta?.skipPoints   ? safeJSON(meta.skipPoints)   : [],
  };
}
function safeJSON(s) { try { return JSON.parse(s); } catch { return []; } }

export async function decideHandler(req, res) {
  const slug = req.query.slug;
  if (!slug) return res.status(400).json({ error: 'slug required' });

  const { ChatSettings } = cds.entities('com.sap.developers.ims');
  const settings = await SELECT.one.from(ChatSettings).columns('branchingEnabled');
  if (!settings?.branchingEnabled) return res.status(404).json({ error: 'branching_disabled' });

  const meta = await loadTutorialBranchMetadata(slug);
  if (!meta) return res.status(404).json({ error: 'tutorial_not_found' });

  const user = req.user?.id && req.user.id !== 'anonymous' ? req.user : null;
  const loaders = makeBranchLoaders();
  const userState = await buildUserState(user, loaders);

  const branchPoints = [];
  for (const bp of meta.branchPoints) {
    const branchPoint = {
      id: bp.id,
      surface: 'tutorialBranch',
      branches: bp.branches.map(b => ({
        key: b.key, label: b.label, condition: b.condition || null, embeddingHint: null,
      })),
    };
    const decision = await pickBranch(branchPoint, userState, { tutorialSlug: slug }, {
      rankBranches: (bp_, st_, ctx_) => rankBranches(bp_, st_, ctx_, loaders),
    });
    branchPoints.push({ id: bp.id, recommendation: { picked: decision.picked, reason: decision.reason, confidence: decision.confidence } });
  }

  const skipPoints = [];
  for (const sp of meta.skipPoints) {
    const r = evaluateSkip(sp.skipIf, userState);
    skipPoints.push({ stepNumber: sp.stepNumber, skip: r.skip, reason: r.reason });
  }

  res.json({ branchPoints, skipPoints });
}
```

- [ ] **Step 4: Register the route**

In `srv/server.js`, near the other `/api/*` registrations:

```javascript
import { decideHandler } from './lib/branch/decide-handler.js';
app.get('/api/branches/decide', decideHandler);
```

- [ ] **Step 5: Run the endpoint test**

Run: `npx vitest run test/api-branches-decide.test.js --project unit`
Expected: 3 tests pass.

- [ ] **Step 6: Commit**

```bash
git add srv/lib/branch/decide-handler.js srv/server.js test/api-branches-decide.test.js
git commit -m "feat(172): GET /api/branches/decide?slug=X for runtime branch recommendations"
```

---

## Task 5: `tutorial-branches` Vue island

**Files:**
- Create: `hugo-apps/src/tutorial-branches/main.ts`
- Create: `hugo-apps/src/tutorial-branches/TutorialBranches.vue`
- Create: `hugo-apps/src/tutorial-branches/branches.css`
- Test: `hugo-apps/src/tutorial-branches/__tests__/TutorialBranches.test.ts`
- Modify: `hugo-apps/vite.config.ts`
- Modify: `hugo/layouts/partials/header.html`

- [ ] **Step 1: Write the failing component test**

Create `hugo-apps/src/tutorial-branches/__tests__/TutorialBranches.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { mount } from '@vue/test-utils';
import TutorialBranches from '../TutorialBranches.vue';

describe('TutorialBranches', () => {
  beforeEach(() => { localStorage.clear(); });

  it('renders all branches as chips and highlights the recommended one', () => {
    const wrapper = mount(TutorialBranches, {
      props: {
        branchPointId: 'bp-1',
        slug: 'test-tut',
        groupKey: 'deployment',
        branches: [{ key: 'hana', label: 'HANA Cloud' }, { key: 'pg', label: 'PostgreSQL' }],
        recommendation: { picked: 'hana', reason: { kind: 'condition', source: "profile.deployment == 'cloud'" }, confidence: 1 },
      },
    });
    expect(wrapper.findAll('[data-branch-key]')).toHaveLength(2);
    expect(wrapper.find('[data-branch-key="hana"]').attributes('data-recommended')).toBe('true');
  });

  it('persists branch selection to localStorage with the standardised key', async () => {
    const wrapper = mount(TutorialBranches, {
      props: {
        branchPointId: 'bp-1', slug: 'test-tut', groupKey: 'deployment',
        branches: [{ key: 'hana', label: 'HANA Cloud' }, { key: 'pg', label: 'PostgreSQL' }],
        recommendation: { picked: 'hana', reason: { kind: 'default' }, confidence: 0 },
      },
    });
    await wrapper.find('[data-branch-key="pg"]').trigger('click');
    expect(localStorage.getItem('tut.branch.tutorial.test-tut.bp-1')).toBe('pg');
  });

  it('respects ?branch= URL override above localStorage', () => {
    localStorage.setItem('tut.branch.tutorial.test-tut.bp-1', 'pg');
    Object.defineProperty(window, 'location', { value: new URL('http://test/?branch=deployment:hana'), writable: true });
    const wrapper = mount(TutorialBranches, {
      props: {
        branchPointId: 'bp-1', slug: 'test-tut', groupKey: 'deployment',
        branches: [{ key: 'hana', label: 'HANA Cloud' }, { key: 'pg', label: 'PostgreSQL' }],
        recommendation: { picked: 'hana', reason: { kind: 'default' }, confidence: 0 },
      },
    });
    expect(wrapper.find('[data-branch-key="hana"]').attributes('aria-selected')).toBe('true');
  });

  it('softens highlight when confidence < 0.15', () => {
    const wrapper = mount(TutorialBranches, {
      props: {
        branchPointId: 'bp-1', slug: 'test-tut', groupKey: 'deployment',
        branches: [{ key: 'hana', label: 'HANA Cloud' }, { key: 'pg', label: 'PostgreSQL' }],
        recommendation: { picked: 'hana', reason: { kind: 'ranker' }, confidence: 0.05 },
      },
    });
    expect(wrapper.find('[data-branch-key="hana"]').attributes('data-recommended')).toBeFalsy();
  });
});
```

- [ ] **Step 2: Run the failing test**

Run: `npx vitest run hugo-apps/src/tutorial-branches/__tests__/TutorialBranches.test.ts --project unit`
Expected: FAIL — component does not exist.

- [ ] **Step 3: Implement the component**

Create `hugo-apps/src/tutorial-branches/TutorialBranches.vue`:

```vue
<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import './branches.css';

interface Branch { key: string; label: string }
interface Recommendation { picked: string; reason: { kind: string; source?: string }; confidence: number }

const props = defineProps<{
  branchPointId: string;
  slug: string;
  groupKey: string;
  branches: Branch[];
  recommendation: Recommendation;
}>();

const lsKey = `tut.branch.tutorial.${props.slug}.${props.branchPointId}`;
const CONFIDENCE_FLOOR = 0.15;

function urlOverride(): string | null {
  try {
    const params = new URLSearchParams(window.location.search);
    const raw = params.get('branch');
    if (!raw) return null;
    const [g, k] = raw.split(':');
    return g === props.groupKey ? k : null;
  } catch { return null; }
}

const selected = ref<string>(
  urlOverride()
  || localStorage.getItem(lsKey)
  || props.recommendation.picked
);

const showRecommendation = computed(() => props.recommendation.confidence >= CONFIDENCE_FLOOR);

const reasonText = computed(() => {
  if (!showRecommendation.value) return '';
  const r = props.recommendation.reason;
  if (r.kind === 'condition' && r.source?.startsWith('completed:'))
    return `Recommended because you completed ${r.source.slice('completed:'.length)}`;
  if (r.kind === 'condition' && r.source?.startsWith('completedMission:'))
    return `Recommended because you completed the ${r.source.slice('completedMission:'.length)} mission`;
  if (r.kind === 'condition') return `Recommended based on your profile`;
  if (r.kind === 'ranker') return `Recommended based on tutorials you've completed`;
  return '';
});

function pick(key: string) {
  selected.value = key;
  localStorage.setItem(lsKey, key);
  document.querySelectorAll(`[data-branch-block][data-branch-point-id="${props.branchPointId}"]`).forEach(el => {
    (el as HTMLElement).style.display = el.getAttribute('data-branch-key') === key ? '' : 'none';
  });
  fetch('/api/branches/choice', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ branchPointId: props.branchPointId, slug: props.slug, surface: 'tutorialBranch', chosenKey: key }),
  }).catch(() => {});
}

onMounted(() => pick(selected.value));
</script>

<template>
  <div class="tut-branch-picker" :data-branch-group-key="groupKey">
    <div v-if="reasonText" class="tut-branch-reason">{{ reasonText }}</div>
    <div role="tablist" class="tut-branch-chips">
      <button
        v-for="b in branches" :key="b.key"
        role="tab"
        type="button"
        :aria-selected="selected === b.key"
        :data-branch-key="b.key"
        :data-recommended="showRecommendation && b.key === recommendation.picked ? 'true' : null"
        :class="{ active: selected === b.key }"
        @click="pick(b.key)"
      >{{ b.label }}<span v-if="showRecommendation && b.key === recommendation.picked" class="rec-badge" aria-label="recommended"> ★</span></button>
    </div>
  </div>
</template>
```

- [ ] **Step 4: Implement the entry**

Create `hugo-apps/src/tutorial-branches/main.ts`:

```typescript
// hugo-apps/src/tutorial-branches/main.ts
import { createApp } from 'vue';
import TutorialBranches from './TutorialBranches.vue';

interface BranchData {
  id: string; groupKey: string; parentStepNumber: number;
  branches: Array<{ key: string; label: string }>;
}
interface DecideResponse {
  branchPoints: Array<{ id: string; recommendation: { picked: string; reason: { kind: string; source?: string }; confidence: number } }>;
  skipPoints:   Array<{ stepNumber: number; skip: boolean; reason: { kind: string; source?: string } }>;
}

const dataEl = document.getElementById('tutorial-branch-points');
if (dataEl) {
  let branches: BranchData[];
  try { branches = JSON.parse(dataEl.textContent || '[]'); } catch { branches = []; }
  if (branches.length) {
    const slug = (document.documentElement.dataset.pageSlug ?? '').toLowerCase();
    fetch(`/api/branches/decide?slug=${encodeURIComponent(slug)}`)
      .then(r => r.ok ? r.json() : null)
      .then((decision: DecideResponse | null) => {
        const recBy = new Map(decision?.branchPoints?.map(p => [p.id, p.recommendation]) || []);
        for (const bp of branches) {
          const mount = document.querySelector(`.tutorial-branch-mount[data-branch-point-id="${bp.id}"]`);
          if (!mount) continue;
          const rec = recBy.get(bp.id) || { picked: bp.branches[0].key, reason: { kind: 'default' }, confidence: 0 };
          createApp(TutorialBranches, { branchPointId: bp.id, slug, groupKey: bp.groupKey, branches: bp.branches, recommendation: rec }).mount(mount as HTMLElement);
        }
        const skipBy = new Map(decision?.skipPoints?.map(p => [p.stepNumber, p]) || []);
        document.querySelectorAll('.tutorial-skip-mount').forEach(el => {
          const stepNum = Number((el as HTMLElement).dataset.stepNumber);
          const sp = skipBy.get(stepNum);
          if (!sp?.skip) return;
          renderSkipPrompt(el as HTMLElement, sp.reason, slug, stepNum);
        });
      })
      .catch(() => { /* degrade gracefully */ });
  }
}

function renderSkipPrompt(el: HTMLElement, reason: { kind: string; source?: string }, slug: string, stepNum: number) {
  const wrap = document.createElement('div');
  wrap.className = 'tut-skip-strip';
  const txt = reason.kind === 'condition' && reason.source?.startsWith('completed:')
    ? `Skip — you've already completed ${reason.source.slice('completed:'.length)}`
    : 'Skip these steps';
  const skipBtn = document.createElement('button');
  skipBtn.type = 'button'; skipBtn.textContent = 'Skip ahead';
  skipBtn.addEventListener('click', () => {
    localStorage.setItem(`tut.branch.skip.${slug}.${stepNum}`, 'skip');
    window.location.hash = `#step-${stepNum + 1}`;
  });
  const stayBtn = document.createElement('button');
  stayBtn.type = 'button'; stayBtn.textContent = 'Read anyway';
  stayBtn.addEventListener('click', () => { wrap.style.display = 'none'; });
  const label = document.createElement('span');
  label.textContent = txt;
  wrap.append(label, skipBtn, stayBtn);
  el.append(wrap);
}
```

- [ ] **Step 5: CSS file**

Create `hugo-apps/src/tutorial-branches/branches.css`:

```css
.tut-branch-picker {
  margin: 1rem 0;
  padding: .5rem .75rem;
  border-left: 3px solid var(--sapInformativeColor, #0a6ed1);
  background: var(--sapList_HighlightColor, #f5f6f7);
  border-radius: 4px;
}
.tut-branch-reason { font-size: .85rem; opacity: .8; margin-bottom: .25rem; }
.tut-branch-chips { display: flex; gap: .5rem; flex-wrap: wrap; }
.tut-branch-chips button {
  background: transparent;
  border: 1px solid var(--sapButton_BorderColor, #bfbfbf);
  border-radius: 999px;
  padding: .3rem .9rem;
  cursor: pointer;
  font: inherit;
}
.tut-branch-chips button.active {
  background: var(--sapButton_Selected_Background, #0a6ed1);
  color: var(--sapButton_Selected_TextColor, #fff);
  border-color: transparent;
}
.tut-branch-chips button[data-recommended="true"] { font-weight: 600; }
.rec-badge { color: var(--sapAccentColor3, #b87b00); margin-left: .25rem; }

.tut-skip-strip {
  margin: .75rem 0;
  padding: .5rem .75rem;
  background: var(--sapInformationBackground, #ebf5fe);
  border-left: 3px solid var(--sapInformativeColor, #0a6ed1);
  border-radius: 4px;
  display: flex; gap: .75rem; align-items: center;
}
.tut-skip-strip button { padding: .25rem .75rem; cursor: pointer; }

@media (prefers-reduced-motion: reduce) {
  .tut-branch-picker, .tut-skip-strip { transition: none !important; }
}
```

- [ ] **Step 6: Register the entry in vite.config.ts**

Add `tutorial-branches` to the entry list in `hugo-apps/vite.config.ts`. Add a budget plugin (similar to validation/code-check budgets) capping at 8 KB gzipped.

- [ ] **Step 7: Add the script tag in the Hugo header partial**

In `hugo/layouts/partials/header.html`, gate behind `{{ if not site.Params.qa }}` per [[feedback_qa_gate_frontend_script_tags]]:

```hugo
{{ if not site.Params.qa }}
<script type="module" src="/js/tutorial-branches.js" defer></script>
{{ end }}
```

- [ ] **Step 8: Run the component test**

Run: `npx vitest run hugo-apps/src/tutorial-branches/__tests__/TutorialBranches.test.ts --project unit`
Expected: 4 tests pass.

- [ ] **Step 9: Commit**

```bash
git add hugo-apps/src/tutorial-branches/ hugo-apps/vite.config.ts hugo/layouts/partials/header.html
git commit -m "feat(172): tutorial-branches Vue island - picker + skip prompt"
```

---

## Task 6: Markdown lint rules

**Files:**
- Modify: `scripts/lint-tutorial-markdown.ts`

- [ ] **Step 1: Add lint rules**

Append to `scripts/lint-tutorial-markdown.ts`:

```typescript
function lintBranchMarkers(file: string, content: string): LintResult[] {
  const out: LintResult[] = [];
  const begins = (content.match(/\[BRANCH_BEGIN/g) || []).length;
  const ends   = (content.match(/\[BRANCH_END\]/g) || []).length;
  if (begins !== ends) {
    out.push({ file, line: 0, severity: 'error', rule: 'branch-marker-balance',
      message: `Unbalanced BRANCH markers: ${begins} BEGIN vs ${ends} END` });
  }
  if (/\[BRANCH_BEGIN[^\]]*\][^[]*\[BRANCH_BEGIN/m.test(content)) {
    out.push({ file, line: 0, severity: 'error', rule: 'branch-nested-not-allowed',
      message: 'Nested BRANCH_BEGIN - not supported in v1' });
  }
  return out;
}
```

Wire it alongside existing rules.

- [ ] **Step 2: Run the lint smoke**

```bash
npm run lint:tutorial-markdown
```

Expected: completes; no spurious errors.

- [ ] **Step 3: Commit**

```bash
git add scripts/lint-tutorial-markdown.ts
git commit -m "chore(172): markdown-lint rules for branch hygiene"
```

---

## Task 7: srv-qa cp list registration

**Files:**
- Modify: `.deploy/mta.yaml`

- [ ] **Step 1: Append `decide-handler.js` to the cp list (same surgery as PR 1/2)**

- [ ] **Step 2: Verify**

```bash
grep -q "branch/decide-handler.js" D:/projects/tutorials-poc/.deploy/mta.yaml && echo OK
```

- [ ] **Step 3: Commit**

```bash
git add .deploy/mta.yaml
git commit -m "chore(172): register decide-handler in srv-qa cp list"
```

---

## Task 8: Author docs — branched tutorials + branching cookbook

**Files:**
- Create: `docs/authors/branched-tutorials.md`
- Create: `docs/authors/branching-cookbook.md`
- Modify: `docs/authors/README.md`
- Modify: `docs/.vitepress/config.ts`

- [ ] **Step 1: Write `docs/authors/branched-tutorials.md`**

```markdown
# Authoring branched tutorials

> **Audience:** Tutorial authors editing markdown in the `sap-tutorials` GitHub org.
> **Status:** v1 (issue #172). Mission-level branching is in [Authoring branched missions](./branched-missions.md).

You can offer alternative paths within a single tutorial:

- **Branches** — wrap N steps that the learner picks one of (HANA setup vs PostgreSQL setup, etc).
- **Skip-runs** — mark a single step as skippable when the learner has already done X.

Both are markdown-only. No admin UI.

## Branches

Wrap consecutive steps in `[BRANCH_BEGIN ...]` / `[BRANCH_END]` markers. **Sub-steps inside a branch use H3 (`###`) — same as top-level steps.** A new parser slices each branch out of the markdown before the v2 step-walker runs, so the existing parser is untouched.

Example:

    ### Step 3 — Configure your database

    Pick the deployment you're using:

    [BRANCH_BEGIN group="deployment" key="hana" label="HANA Cloud" condition="profile.deployment == 'cloud'"]

    ### Step 3a — Configure HANA Cloud
    ...content...

    ### Step 3b — Verify HANA connection
    ...content...

    [BRANCH_END]

    [BRANCH_BEGIN group="deployment" key="postgres" label="PostgreSQL"]

    ### Step 3a' — Configure PostgreSQL
    ...content...

    [BRANCH_END]

    ### Step 4 — Continue (everyone re-merges here)

### Attributes

- `group="<key>"` — required; alt-groups in the same tutorial step share this key.
- `key="<id>"` — optional; auto-derived from `label` if omitted.
- `label="<display text>"` — required; what the chip shows.
- `condition="<predicate>"` — optional; same DSL as mission alt-groups.

## Skip-runs

Add `skipIf:` to a step's frontmatter:

    ---
    title: Install Node.js
    skipIf: "completed:node-getting-started"
    skipLabel: "Skip — I already have Node"
    skipReason: "You completed the Node onboarding mission"
    ---

When the learner reaches that step and the predicate is true, an inline strip offers to skip ahead. The strip is dismissable.

## What `[OPTION BEGIN]` is NOT

Existing `[OPTION BEGIN]` blocks render both alternatives inline (tab strip). Branch blocks **hide** the unpicked path. Different mechanics:

| Feature | OPTION (existing) | BRANCH (new) |
|---|---|---|
| Use case | "Show two ways to do this — IDE A vs IDE B" | "Pick one — your stack determines which" |
| Both visible? | Yes | No |
| Counts toward progress? | Both | Selected one only |
| Recommendation? | None | AI/condition-driven |

## Validation

`fetch-tutorials` rejects:

- Unbalanced markers
- Mismatched group keys in consecutive blocks
- Duplicate keys within a group
- Nested branches
- Single-member alt-groups
- Conditions that don't parse

Errors fail the build with a line reference.

## See also

- [Branching cookbook](./branching-cookbook.md) — copy-paste examples
- [Authoring branched missions](./branched-missions.md)
- [Branching paths design (issue #172)](../../superpowers/specs/2026-06-09-172-branching-paths-design.md)
```

- [ ] **Step 2: Write `docs/authors/branching-cookbook.md`**

```markdown
# Branching cookbook

Copy-paste examples for the most common branching patterns.

## 1. Cloud vs on-prem deployment

Tutorial step:

    ### Step 4 — Configure your runtime

    [BRANCH_BEGIN group="deployment" key="cloud" label="BTP (cloud)" condition="profile.deployment == 'cloud'"]

    ### Step 4a — Bind a service instance on BTP
    ...

    [BRANCH_END]

    [BRANCH_BEGIN group="deployment" key="onprem" label="On-prem (Docker)"]

    ### Step 4a' — Spin up the container locally
    ...

    [BRANCH_END]

    ### Step 5 — Continue

## 2. IDE branch (VS Code vs IntelliJ)

    ### Step 2 — Open the project

    [BRANCH_BEGIN group="ide" key="vscode" label="VS Code"]
    ### Step 2a — Open in VS Code
    ...
    [BRANCH_END]

    [BRANCH_BEGIN group="ide" key="intellij" label="IntelliJ"]
    ### Step 2a' — Open in IntelliJ
    ...
    [BRANCH_END]

    ### Step 3 — Continue

(No condition → ranker picks based on which IDE the learner has used in past tutorials.)

## 3. Skip a Node intro for experienced learners

    ---
    title: Install Node.js
    skipIf: "completedMission:node-getting-started"
    skipLabel: "Skip — I'm already on Node"
    skipReason: "You finished the Node onboarding mission"
    ---

## 4. Combining: cloud-only AND already-completed prerequisite

    [BRANCH_BEGIN group="deployment" key="cloud-fast" label="BTP (cloud, fast track)" condition="profile.deployment == 'cloud' && completed:hana-intro"]
    ...
    [BRANCH_END]

    [BRANCH_BEGIN group="deployment" key="cloud-full" label="BTP (cloud, full setup)" condition="profile.deployment == 'cloud'"]
    ...
    [BRANCH_END]

    [BRANCH_BEGIN group="deployment" key="onprem" label="On-prem"]
    ...
    [BRANCH_END]

The first matching condition (top-down) wins. Order branches from most-specific to most-general.

## 5. Mission-level alt-group: pick HANA Cloud vs PostgreSQL track

This lives in the admin UI, not markdown — see [Authoring branched missions](./branched-missions.md).
```

- [ ] **Step 3: Update authors README + sidebar**

In `docs/authors/README.md`:

```markdown
- [Authoring branched tutorials](./branched-tutorials.md) — `[BRANCH_BEGIN]` blocks + skip-runs (issue #172)
- [Branching cookbook](./branching-cookbook.md) — copy-paste examples
```

In `docs/.vitepress/config.ts`, register both new pages.

- [ ] **Step 4: Build the docs**

```bash
npm run docs:build
```

Expected: green; no unregistered pages.

- [ ] **Step 5: Commit**

```bash
git add docs/authors/branched-tutorials.md docs/authors/branching-cookbook.md docs/authors/README.md docs/.vitepress/config.ts
git commit -m "docs(172): branched tutorials guide + branching cookbook"
```

---

## Task 9: Final-branch sanity, push, PR

- [ ] **Step 1: Run the full unit project**

Run: `npx vitest run --project unit`
Expected: green; new files contribute ~16 tests.

- [ ] **Step 2: Run smoke**

Run: `npx vitest run --project smoke test/smoke/content-serve.test.js`
Expected: still green.

- [ ] **Step 3: Verify file invariants**

```bash
file D:/projects/tutorials-poc/srv/lib/branch/decide-handler.js D:/projects/tutorials-poc/scripts/parsers/branches.ts D:/projects/tutorials-poc/hugo-apps/src/tutorial-branches/main.ts
grep -nE "\\beval\\s*\\(|new\\s+Function\\(" D:/projects/tutorials-poc/srv/lib/branch/decide-handler.js D:/projects/tutorials-poc/scripts/parsers/branches.ts
grep -q "decide-handler.js" D:/projects/tutorials-poc/.deploy/mta.yaml && echo OK
```

- [ ] **Step 4: Push + PR**

```bash
git push origin feat/172-branching-paths-design

gh pr create \
  --title "feat(172): step-level branches + skip-runs (markdown + Vue island)" \
  --body "PR 3 of #172 plan. See plan: docs/superpowers/plans/2026-06-09-172-branching-pr3-step-branches-skip-runs.md" \
  --base main
```

---

## Definition of done for PR 3

- [ ] All 9 tasks complete and committed
- [ ] `npx vitest run --project unit` green
- [ ] Tutorials without branches render unchanged
- [ ] Vue island bundle gzip ≤ 8 KB
- [ ] Author docs published; `npm run docs:build` green
- [ ] PR opened against `main`

## Cross-references

- Reuses PR 1's engine + condition language; reuses PR 2's `loaders.js`.
- PR 4 will register a Joule chat tool that calls the same `pickBranch`.

---

## Reviewer addendum (apply before starting)

Plan-review found 6 real issues. The biggest gap is that the runtime endpoint reads branch metadata from HANA but no task writes it there.

### A. (BIGGEST) Persist `branchPoints` / `skipPoints` to `TutorialMeta`

**Insert this as new "Task 3.5: TutorialMeta persistence"** between current Task 3 and Task 4.

`TutorialMeta` schema is currently:

```cds
entity TutorialMeta : cuid, managed, LegacyKeyed {
  tutorial: Association to Tutorials;
  reviewedDate, owner, ownerEmail, monitoredStatus, …;
}
```

Add two columns:

```cds
// db/schema.cds — extend TutorialMeta
branchPoints : LargeString;   // JSON serialised — Array<BranchPoint>
skipPoints   : LargeString;   // JSON serialised — Array<SkipPoint>
```

Then extend `srv/lib/content-publish-session.js` `upsertTutorialMetadata()` to persist them. The publish-content pipeline already passes per-tutorial metadata; route the parsed `branchPoints`/`skipPoints` into that metadata at fetch-time and pick them up at publish-time. Sketch:

```javascript
// In scripts/parsers/index.ts (or wherever the per-tutorial metadata object is built),
// add to the metadata payload:
metadata.branchPoints = stepsWithBranches.flatMap(s => s.branchPoint ? [s.branchPoint] : []);
metadata.skipPoints   = stepsWithSkip.map(s => ({ stepNumber: s.number, skipIf: s.skipIf, skipLabel: s.skipLabel, skipReason: s.skipReason }));

// In srv/lib/content-publish-session.js upsertTutorialMetadata(),
// when building the TutorialMeta INSERT/UPDATE record:
{
  /* existing fields */,
  branchPoints: meta.branchPoints?.length ? JSON.stringify(meta.branchPoints) : null,
  skipPoints:   meta.skipPoints?.length   ? JSON.stringify(meta.skipPoints)   : null,
}
```

Add a unit test `test/branch-tutorial-meta-roundtrip.test.js` that publishes a tutorial with branchPoints and asserts the decide endpoint returns them.

Without this task, **Task 4 is non-functional end-to-end** — the decide endpoint will always return empty arrays.

### B. `BranchDecisions` telemetry write missing in decide-handler

In **Task 4 Step 3**, the handler must write a `BranchDecisions` row per recommendation (spec §6 step 7). Add inside the loop:

```javascript
// Inside the for (const bp of meta.branchPoints) loop, after pickBranch:
await writeBranchDecision({
  user, slug, branchPointId: bp.id, decision,
  surface: 'tutorialBranch', source: 'pageLoad',
});
// And similarly inside the skipPoints loop:
await writeBranchDecision({
  user, slug, branchPointId: `${slug}#skip-${sp.stepNumber}`, decision: { picked: r.skip ? 'skip' : 'stay', reason: r.reason, confidence: r.skip ? 1 : 0 },
  surface: 'tutorialSkip', source: 'pageLoad',
});
```

Reuse PR 2's `writeBranchDecision` helper from `srv/lib/branch/mission-detail.js` — promote it to `srv/lib/branch/telemetry.js` and import from both handlers.

### C. `/api/branches/choice` endpoint — create or remove

The Vue island POSTs to `/api/branches/choice` (in Task 5 `pick()`), but no handler is registered. Two options:

1. **Create the endpoint** in this PR. Add to `srv/server.js`:

   ```javascript
   import { choiceHandler } from './lib/branch/choice-handler.js';
   app.post('/api/branches/choice', express.json(), choiceHandler);
   ```

   And implement `srv/lib/branch/choice-handler.js`:

   ```javascript
   import cds from '@sap/cds';
   export async function choiceHandler(req, res) {
     try {
       const { branchPointId, slug, surface, chosenKey } = req.body || {};
       if (!branchPointId || !chosenKey) return res.status(400).json({ error: 'missing fields' });
       const { ChatSettings, BranchDecisions, Users } = cds.entities('com.sap.developers.ims');
       const settings = await SELECT.one.from(ChatSettings).columns('branchingEnabled');
       if (!settings?.branchingEnabled) return res.status(204).end();
       let userIdInternal = null;
       if (req.user?.id && req.user.id !== 'anonymous') {
         const u = await SELECT.one.from(Users).columns('ID').where({ uuid: req.user.id });
         userIdInternal = u?.ID || null;
       }
       await INSERT.into(BranchDecisions).entries({
         user_ID: userIdInternal,
         surface,
         missionSlug: surface === 'missionAltGroup' ? slug : null,
         tutorialSlug: surface === 'missionAltGroup' ? null : slug,
         branchPointId,
         recommendedKey: null,                // unknown from this side
         chosenKey,
         recommendationKind: null,
         confidence: null,
         source: 'click',
         followedRecommendation: null,
       });
       res.status(204).end();
     } catch { res.status(500).end(); }
   }
   ```

   Add to srv-qa cp list. Update Task 7.

2. **Or drop the POST entirely** from `TutorialBranches.vue#pick()` and rely on PR 2's pageLoad telemetry. Loses click-vs-pageLoad signal but is simpler.

Recommend option 1 — the click signal is what makes the analytics tile useful.

### D. Hugo template loop is malformed

In **Task 3 Step 2**, the snippets reference `.id` and `.parentStepNumber` outside any loop. Wrap in `range`:

```hugo
{{ if .Params.branchPoints }}
<script id="tutorial-branch-points" type="application/json">
{{ .Params.branchPoints | jsonify }}
</script>
{{ range .Params.branchPoints }}
<div class="tutorial-branch-mount" data-branch-point-id="{{ .id }}" data-parent-step="{{ .parentStepNumber }}"></div>
{{ end }}
{{ end }}
```

Also note: the spec wants mount points placed *between specific steps* (§3.1). This may require a per-step partial change rather than the page-level template — verify against the actual v2 layout file before implementing.

### E. Branch sub-step content rendering — design needed

The parser slices branch sub-steps OUT of the linear stream (§4.2). Currently nothing renders them. The Vue island's `pick()` toggles `display` on `[data-branch-block]` elements that don't exist.

**Required addition: render hidden `<div data-branch-block>` containers per branch.** Approach:

In `scripts/parsers/render-frontmatter.ts`, also emit each branch's `steps[]` content (HTML-rendered) into a top-level `branchContent: { branchPointId: { branchKey: html } }` map. The Hugo template renders one container per (branch-point, branch) below each mount, default-hidden via CSS:

```hugo
{{ range .Params.branchPoints }}
<div class="tutorial-branch-mount" data-branch-point-id="{{ .id }}"></div>
{{ range .branches }}
<div class="branch-block" data-branch-block data-branch-point-id="{{ $.id }}" data-branch-key="{{ .key }}" style="display:none">
  {{ range .steps }}
    <h3>{{ .title }}</h3>
    {{ .content | markdownify }}
  {{ end }}
}
</div>
{{ end }}
{{ end }}
```

The Vue island's `pick(key)` then shows the matching `[data-branch-block]` and hides the others. Default selection (recommendation OR localStorage OR first branch) is shown on mount.

Add a Hugo smoke test or a snapshot test against a synthetic tutorial with two branches.

### F. `parseCondition` cross-boundary import

`scripts/parsers/branches.ts` imports from `srv/lib/branch/condition.js`. This works in `tsx` (the fetch script's runtime) only if the srv module is ESM-compatible. PR 1's condition.js is ESM (`import`/`export`). Verify it has no `cds` import (it doesn't — pure JS). Acceptable as-is, but document the constraint:

> `srv/lib/branch/condition.js` is intentionally dependency-free (no `cds`, no `node:fs`) so it can be imported from `scripts/parsers/branches.ts` at fetch-time. Don't add runtime-only imports without isolating them.

If the import does break in the tsx script, Plan B: copy the condition parser to `scripts/parsers/condition.ts` (pure mirror) — small, well-tested, would diverge if the runtime grammar changes. Track via a comment header pointing back to the canonical source.

### G. Remove the `}` typo

The Hugo example fence in **Reviewer addendum item E** above contains a stray `}` between `{{ end }}` and `</div>`. Don't copy it verbatim — the correct close is just two `{{ end }}` followed by `</div>`. (Same issue might exist in some plan-review snippets; sanity-check before paste.)
