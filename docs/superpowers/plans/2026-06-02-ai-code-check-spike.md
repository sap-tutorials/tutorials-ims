# AI Code-Check Spike Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship an AI code-check spike that lets authenticated learners paste code on opted-in tutorial steps and receive a structured pass/partial/fail verdict, gated behind `ChatSettings.codeCheckEnabled`, with persistence sufficient to drive offline grader-quality evaluation.

**Architecture:** New `[CODECHECK_N]` block in `rules.vr` parsed at build time; trimmed metadata flows into Hugo frontmatter, full spec (with reference solution) flows into a new HANA `CodeCheckSpecs` entity via the publish pipeline. Runtime is a new `checkCode` function registered both as a Joule chat tool and force-called from a thin `/api/codecheck` Express route. Single LLM call per check via `OrchestrationClient` with **forced tool-call** for structured output (matching the codebase's existing `generateAnalyticsQuery` pattern, NOT `response_format: json_schema` which the SDK doesn't expose). Verdicts persist to `CodeCheckSubmissions` with telemetry. Frontend is a new Vue 3 island following the `tutorial-rating` shape.

**Tech Stack:** SAP CAP (Node.js, `@sap/cds` ^9.9), HANA Cloud (SQLite for unit tests), `@sap-ai-sdk/orchestration`, Vue 3 + Vite, UI5 Web Components, Vitest.

**Spec:** [`docs/superpowers/specs/2026-06-02-ai-code-check-spike-design.md`](../specs/2026-06-02-ai-code-check-spike-design.md)

**Tracking issue:** [sap-tutorials/tutorials-ims#171](https://github.com/sap-tutorials/tutorials-ims/issues/171)

---

## Working assumptions for the implementer

- You will work on branch `spec/171-ai-code-check` (already checked out) or a fresh branch off `main`. Open a draft PR after Phase 1 commits land so review can start early.
- You have `cf login` to the DEV CF space already configured. Hybrid tests need it; unit tests don't.
- You know nothing about CAP, Hugo, UI5 web components, or the SAP AI SDK. The plan tells you which file to touch and what to type. When in doubt, copy the closest existing pattern in the file you're editing.
- Frequent small commits. Every task ends with a commit. Don't batch unrelated changes.
- TDD throughout: write the failing test FIRST, watch it fail with the expected error, then implement.

## Useful skills to invoke during implementation

- `superpowers:test-driven-development` — for the TDD discipline.
- `superpowers:verification-before-completion` — before claiming a task done.
- The codebase's `cds-mcp` and `hana-cli` MCPs (per [CLAUDE.md](../../../CLAUDE.md)) — use them when authoring or debugging CDS / HANA work; do NOT guess CDS APIs from training data.

## File map (everything this plan creates or modifies)

**New files:**
- `scripts/parsers/codecheck.ts` — `parseCodeCheckBlocks()` extracts `[CODECHECK_N]` blocks from rules.vr.
- `srv/lib/code-check-tool.js` — single dispatch function called by both the Express route and the chat tool.
- `srv/lib/code-check-prompt.js` — system prompt + user-message builder + JSON schema (kept separate so it's prompt-only and easy to version).
- `srv/lib/code-check-handler.js` — Express bridge: rate-limit, body validation, AsyncLocalStorage user injection, calls dispatch.
- `srv/lib/code-check-spec-publish.js` — `POST /content/code-check-specs` Express handler (server side of the publish protocol).
- `hugo-apps/src/code-check/main.ts` + `CodeCheck.vue` — frontend island.
- `hugo/layouts/partials/codecheck-mount.html` — Hugo include used by the step shortcode.
- `scripts/evaluate-code-check.js` — manual evaluation harness (Phase 3 deliverable).
- `test/unit/code-check-parser.test.js`
- `test/unit/code-check-prompt.test.js`
- `test/unit/code-check-handler.test.js`
- `test/unit/code-check-tool.test.js`
- `test/hybrid/code-check.test.js`
- `test/smoke/code-check.test.js`

**Modified files:**
- `db/schema.cds` — adds `CodeCheckSpecs`, `CodeCheckSubmissions`, extends `ChatSettings` with `codeCheckEnabled`.
- `db/audit-logging.cds` — `@PersonalData` for `CodeCheckSubmissions`.
- `scripts/parsers/types.ts` — `CodeCheckSpec`, `PublicCodeCheckSpec` interfaces.
- `scripts/parsers/rules.ts` — re-exports the new parser; existing function untouched.
- `scripts/fetch-tutorials.ts` — calls the new parser; trimmed spec → step frontmatter; full spec → `.tutorial-cache/<slug>.codecheck.json`.
- `scripts/parsers/render-frontmatter.ts` — emits `codeCheck:` field on steps.
- `scripts/publish-content.ts` — after the file-batch commit, ships full specs to `/content/code-check-specs`.
- `srv/lib/chat-orchestrator.js` — registers `CHECK_CODE_TOOL`; `dispatchTool('checkCode', …)` delegates.
- `srv/server.js` — wires `/api/codecheck` (XSUAA) and `/content/code-check-specs` (`CONTENT_API_KEY`) on bootstrap.
- `hugo/layouts/shortcodes/tutorial-step.html` — includes the new partial when `codeCheck` present.
- `hugo-apps/vite.config.ts` — registers the new entry; gzip budget guard.
- `app/admin-annotations.cds` — `@analytics.exposed` on `CodeCheckSubmissions`.
- `CLAUDE.md` — Gotchas section: code-check spec channel separation; `codeCheckEnabled` flag.

---

## Phase 1 — Backend foundation behind a flag

End state: a curl with a fresh XSUAA token and a known-seeded spec returns a structured verdict; flag-off returns 503; rate-limit returns 429. No frontend yet.

### Task 1.1 — CDS schema: `CodeCheckSpecs`, `CodeCheckSubmissions`, `ChatSettings.codeCheckEnabled`

**Files:**
- Modify: [`db/schema.cds`](../../../db/schema.cds) (around line 388 for ChatSettings; new entities after `TutorialFeedback` near line 430)
- Modify: [`db/audit-logging.cds`](../../../db/audit-logging.cds)
- Test: `test/unit/code-check-schema.test.js` (new)

- [ ] **Step 1: Write the failing schema test**

Create `test/unit/code-check-schema.test.js`:

```js
import { describe, it, expect, beforeAll } from 'vitest';
import path from 'node:path';
import cds from '@sap/cds';

describe('CodeCheck CDS schema', () => {
  beforeAll(async () => {
    await cds.deploy(path.join(process.cwd(), 'db', 'schema.cds')).to('sqlite::memory:');
  });

  it('CodeCheckSpecs accepts insert with required fields', async () => {
    const { Tutorials, CodeCheckSpecs } = cds.entities('com.sap.developers.ims');
    await INSERT.into(Tutorials).entries({ ID: '11111111-1111-1111-1111-111111111111', slug: 't1', title: 'T1', status: 'ACTIVE' });
    await INSERT.into(CodeCheckSpecs).entries({
      tutorial_ID: '11111111-1111-1111-1111-111111111111',
      stepNumber: 3,
      goal: 'Add a before-READ handler',
      language: 'javascript',
      hints: '["see srv/cat-service.js"]',
      referenceSolution: 'this.before(...);',
      hasReference: true
    });
    const rows = await SELECT.from(CodeCheckSpecs);
    expect(rows).toHaveLength(1);
    expect(rows[0].goal).toBe('Add a before-READ handler');
  });

  it('CodeCheckSubmissions accepts insert with required fields', async () => {
    const { CodeCheckSubmissions } = cds.entities('com.sap.developers.ims');
    await INSERT.into(CodeCheckSubmissions).entries({
      ID: '22222222-2222-2222-2222-222222222222',
      tutorialSlug: 't1', stepNumber: 3,
      submittedCode: 'console.log(1)',
      verdict: 'pass'
    });
    const rows = await SELECT.from(CodeCheckSubmissions);
    expect(rows).toHaveLength(1);
  });

  it('ChatSettings exposes codeCheckEnabled with default false', async () => {
    const { ChatSettings } = cds.entities('com.sap.developers.ims');
    const insp = cds.model.definitions['com.sap.developers.ims.ChatSettings'];
    expect(insp.elements.codeCheckEnabled).toBeDefined();
    expect(insp.elements.codeCheckEnabled.type).toBe('cds.Boolean');
    expect(insp.elements.codeCheckEnabled.default?.val).toBe(false);
  });
});
```

- [ ] **Step 2: Run test, expect failure**

Run: `npx vitest run test/unit/code-check-schema.test.js`
Expected: fail with `CodeCheckSpecs is undefined` or similar.

- [ ] **Step 3: Add the entities to `db/schema.cds`**

Find the existing `entity ChatSettings : cuid, managed { … }` block (line 388) and add the new field at the end before the closing `}`:

```cds
  // AI code-check spike (issue #171). When false, /api/codecheck → 503
  // and the checkCode tool is omitted from toolsForContext().
  codeCheckEnabled     : Boolean default false;
```

After `entity TutorialFeedback : managed { … }` (which ends near line 430), add:

```cds
// Author-supplied code-check material per (tutorial, step). Server-only:
// the referenceSolution column NEVER reaches the client. Populated by
// the publish-content pipeline; read by srv/lib/code-check-tool.js.
entity CodeCheckSpecs : managed {
  key tutorial         : Association to Tutorials;
  key stepNumber       : Integer;
  goal                 : LargeString @mandatory;
  language             : String(40);
  hints                : LargeString;        // JSON-encoded string[]
  referenceSolution    : LargeString;        // server-only
  hasReference         : Boolean default false;
}

// Every learner submission. Drives offline grader-quality evaluation.
// 'verdict' allows 'error' as a server-side outcome value (the LLM JSON
// schema only emits 'pass' | 'partial' | 'fail').
entity CodeCheckSubmissions : managed {
  key ID               : UUID;
  user                 : Association to Users;
  tutorialSlug         : String(200) @mandatory;
  stepNumber           : Integer @mandatory;
  submittedCode        : LargeString @mandatory;
  language             : String(40);
  verdict              : String(10);
  summary              : LargeString;
  suggestions          : LargeString;        // JSON-encoded string[]
  correctAspects       : LargeString;        // JSON-encoded string[]
  modelName            : String(80);
  promptTokens         : Integer;
  completionTokens     : Integer;
  latencyMs            : Integer;
  errorReason          : String(200);
}
```

- [ ] **Step 4: Add @PersonalData annotations**

In [`db/audit-logging.cds`](../../../db/audit-logging.cds), follow the existing pattern for `Users`/`UserMetaData`/`TaskRecords` and append:

```cds
annotate CodeCheckSubmissions with @PersonalData : {
  EntitySemantics: 'DataSubject',
  DataSubjectRole: 'Learner'
};
annotate CodeCheckSubmissions {
  user @PersonalData.FieldSemantics: 'DataSubjectID';
  submittedCode @PersonalData.IsPotentiallyPersonal;
}
```

- [ ] **Step 5: Run test, verify pass**

Run: `npx vitest run test/unit/code-check-schema.test.js`
Expected: PASS (all three tests).

Run the full unit suite to confirm no regressions: `npm test -- --run`

- [ ] **Step 6: Commit**

```bash
git add db/schema.cds db/audit-logging.cds test/unit/code-check-schema.test.js
git commit -m "feat(codecheck): add CodeCheckSpecs + CodeCheckSubmissions entities (#171)

- ChatSettings.codeCheckEnabled flag (default false).
- CodeCheckSpecs: server-only spec including referenceSolution.
- CodeCheckSubmissions: per-submission telemetry, @PersonalData annotated.

Refs sap-tutorials/tutorials-ims#171"
```

---

### Task 1.2 — Parser: `parseCodeCheckBlocks()` for `[CODECHECK_N]`

**Files:**
- Create: `scripts/parsers/codecheck.ts`
- Modify: `scripts/parsers/types.ts`
- Modify: `scripts/parsers/rules.ts` (re-export only)
- Test: `test/unit/code-check-parser.test.js` (new)

- [ ] **Step 1: Add the type definitions**

Append to `scripts/parsers/types.ts` (end of file is fine; co-locate with `ValidationQuestion`):

```ts
// Full CodeCheckSpec — used by the publish pipeline. NEVER ship to the
// client; the referenceSolution field is author-only.
export interface CodeCheckSpec {
  stepNumber: number;
  goal: string;             // required
  language?: string;
  hints?: string[];
  referenceSolution?: string;
}

// Trimmed shape that ships in Hugo frontmatter / data-* attributes.
// Includes hasReference flag so the grader can know one exists without
// the spec having to ship it.
export interface PublicCodeCheckSpec {
  goal: string;
  language?: string;
  hints?: string[];
  hasReference: boolean;
}
```

- [ ] **Step 2: Write the failing parser test**

Create `test/unit/code-check-parser.test.js`:

```js
import { describe, it, expect } from 'vitest';
import { parseCodeCheckBlocks } from '../../scripts/parsers/codecheck.js';

describe('parseCodeCheckBlocks', () => {
  it('extracts a complete block with all sections', () => {
    const input = `[CODECHECK_3]
###Language
javascript

###Goal
The handler should add a before READ event on Books.

###Hints
- See srv/cat-service.js
- Use cds.ql

###ReferenceSolution
this.before('READ', 'Books', req => req.query.where('stock >', 0));
`;
    const out = parseCodeCheckBlocks(input);
    expect(out.size).toBe(1);
    const spec = out.get(3);
    expect(spec.goal).toMatch(/before READ event on Books/);
    expect(spec.language).toBe('javascript');
    expect(spec.hints).toEqual(['See srv/cat-service.js', 'Use cds.ql']);
    expect(spec.referenceSolution).toMatch(/req\.query\.where/);
  });

  it('omits optional sections when absent', () => {
    const input = `[CODECHECK_1]
###Goal
Make it work.
`;
    const spec = parseCodeCheckBlocks(input).get(1);
    expect(spec.goal).toBe('Make it work.');
    expect(spec.language).toBeUndefined();
    expect(spec.hints).toBeUndefined();
    expect(spec.referenceSolution).toBeUndefined();
  });

  it('returns empty when goal is missing', () => {
    const input = `[CODECHECK_1]
###Language
javascript
`;
    expect(parseCodeCheckBlocks(input).size).toBe(0);
  });

  it('parses multiple blocks for different steps', () => {
    const input = `[CODECHECK_1]
###Goal
First.
[CODECHECK_5]
###Goal
Fifth.
`;
    const out = parseCodeCheckBlocks(input);
    expect(out.get(1).goal).toBe('First.');
    expect(out.get(5).goal).toBe('Fifth.');
  });

  it('coexists with [VALIDATE_N] blocks', () => {
    const input = `[VALIDATE_2]
###Rule
multiple-choice
###Question
Which is true?
###Match
[x] A
[ ] B
[CODECHECK_3]
###Goal
Implement the handler.
`;
    const out = parseCodeCheckBlocks(input);
    expect(out.size).toBe(1);
    expect(out.get(3).goal).toBe('Implement the handler.');
  });

  it('strips bullet markers from hints', () => {
    const input = `[CODECHECK_1]
###Goal
G.
###Hints
- one
- two
* three
`;
    expect(parseCodeCheckBlocks(input).get(1).hints).toEqual(['one', 'two', 'three']);
  });
});
```

- [ ] **Step 3: Run test, expect failure**

Run: `npx vitest run test/unit/code-check-parser.test.js`
Expected: fail — module not found.

- [ ] **Step 4: Implement the parser**

Create `scripts/parsers/codecheck.ts`:

```ts
import type { CodeCheckSpec } from './types.js'

const CODECHECK_MARKER = /^\[CODECHECK_(\d+)\]\s*$/
const ANY_MARKER = /^\[(VALIDATE|CODECHECK)_\d+\]\s*$/

export function parseCodeCheckBlocks(content: string): Map<number, CodeCheckSpec> {
  const result = new Map<number, CodeCheckSpec>()
  const lines = content.split('\n')
  let currentNum: number | null = null
  let blockLines: string[] = []

  const flush = () => {
    if (currentNum === null) return
    const spec = parseBlock(blockLines, currentNum)
    if (spec) result.set(currentNum, spec)
    currentNum = null
    blockLines = []
  }

  for (const line of lines) {
    const cc = line.match(CODECHECK_MARKER)
    if (cc) { flush(); currentNum = parseInt(cc[1], 10); continue }
    if (ANY_MARKER.test(line)) { flush(); continue }   // hit a sibling block — close ours
    if (currentNum !== null) blockLines.push(line)
  }
  flush()
  return result
}

function parseBlock(lines: string[], stepNumber: number): CodeCheckSpec | null {
  const raw = lines.join('\n')
  const goal = section(raw, 'Goal')
  if (!goal) return null
  const language = section(raw, 'Language') || undefined
  const hintsRaw = section(raw, 'Hints')
  const hints = hintsRaw
    ? hintsRaw.split('\n').map(l => l.replace(/^[-*]\s*/, '').trim()).filter(Boolean)
    : undefined
  const referenceSolution = section(raw, 'ReferenceSolution') || undefined
  return { stepNumber, goal, language, hints, referenceSolution }
}

function section(raw: string, name: string): string {
  const re = new RegExp(`###${name}\s*\n([\s\S]*?)(?=\n###|$)`, 'm')
  const m = raw.match(re)
  return m ? m[1].trim() : ''
}
```

In `scripts/parsers/rules.ts`, add at the end (re-export so callers can import from one place):

```ts
export { parseCodeCheckBlocks } from './codecheck.js'
```

- [ ] **Step 5: Run test, verify pass**

Run: `npx vitest run test/unit/code-check-parser.test.js`
Expected: 6 passing.

- [ ] **Step 6: Commit**

```bash
git add scripts/parsers/codecheck.ts scripts/parsers/types.ts scripts/parsers/rules.ts test/unit/code-check-parser.test.js
git commit -m "feat(codecheck): parse [CODECHECK_N] blocks from rules.vr (#171)

Sibling to parseRulesVr(); coexists with [VALIDATE_N]. Returns full
CodeCheckSpec including referenceSolution (server-only). Strips
bullet markers from hints. Goal-less blocks are dropped silently
matching the existing parser convention."
```

---

### Task 1.3 — Build pipeline: write trimmed spec to step frontmatter + full spec to cache

**Files:**
- Modify: `scripts/fetch-tutorials.ts` (around line 654 — same block where validation is attached)
- Modify: `scripts/parsers/render-frontmatter.ts` (emits step `validation` field today; add `codeCheck`)
- Test: `test/unit/code-check-fetch-attach.test.js` (new — pure-function test of the attach step)

This task does NOT yet touch the publish pipeline — that comes in Task 1.5. Here we just (a) parse during fetch, (b) put the trimmed spec on the step, (c) write the full spec to a per-tutorial JSON sidecar in `.tutorial-cache/`.

- [ ] **Step 1: Write the failing test**

Create `test/unit/code-check-fetch-attach.test.js`:

```js
import { describe, it, expect } from 'vitest';
import { attachCodeCheckSpecs } from '../../scripts/parsers/codecheck.js';

describe('attachCodeCheckSpecs', () => {
  const baseSteps = () => [
    { number: 1, title: 'Set up' },
    { number: 2, title: 'Implement' },
    { number: 3, title: 'Test yourself' }
  ];

  it('attaches trimmed spec to the matching step number', () => {
    const steps = baseSteps();
    const specs = new Map([
      [2, { stepNumber: 2, goal: 'Add handler', language: 'javascript',
            hints: ['see srv/'], referenceSolution: 'this.before(...)' }]
    ]);
    const sidecar = attachCodeCheckSpecs(steps, specs);
    expect(steps[1].codeCheck).toEqual({
      goal: 'Add handler',
      language: 'javascript',
      hints: ['see srv/'],
      hasReference: true
    });
    expect(steps[1].codeCheck.referenceSolution).toBeUndefined();
    expect(sidecar).toEqual([{
      stepNumber: 2,
      goal: 'Add handler',
      language: 'javascript',
      hints: ['see srv/'],
      referenceSolution: 'this.before(...)'
    }]);
  });

  it('hasReference is false when referenceSolution absent', () => {
    const steps = baseSteps();
    const specs = new Map([[1, { stepNumber: 1, goal: 'G' }]]);
    attachCodeCheckSpecs(steps, specs);
    expect(steps[0].codeCheck.hasReference).toBe(false);
  });

  it('skips specs whose stepNumber does not match any step', () => {
    const steps = baseSteps();
    const specs = new Map([[99, { stepNumber: 99, goal: 'G' }]]);
    const sidecar = attachCodeCheckSpecs(steps, specs);
    expect(steps.every(s => s.codeCheck === undefined)).toBe(true);
    expect(sidecar).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test, expect failure**

Run: `npx vitest run test/unit/code-check-fetch-attach.test.js`
Expected: fail — `attachCodeCheckSpecs` not exported.

- [ ] **Step 3: Implement `attachCodeCheckSpecs`**

Append to `scripts/parsers/codecheck.ts`:

```ts
import type { CodeCheckSpec, PublicCodeCheckSpec } from './types.js'

interface StepLike { number: number; codeCheck?: PublicCodeCheckSpec }

/**
 * Mutates each step in place: attaches a trimmed PublicCodeCheckSpec when
 * the step number matches a parsed spec. Returns the full sidecar array
 * (server-only) for writing to .tutorial-cache/<slug>.codecheck.json.
 */
export function attachCodeCheckSpecs<T extends StepLike>(
  steps: T[],
  specs: Map<number, CodeCheckSpec>
): CodeCheckSpec[] {
  const sidecar: CodeCheckSpec[] = []
  for (const [stepNumber, spec] of specs) {
    const target = steps.find(s => s.number === stepNumber)
    if (!target) continue
    target.codeCheck = {
      goal: spec.goal,
      language: spec.language,
      hints: spec.hints,
      hasReference: Boolean(spec.referenceSolution)
    }
    sidecar.push(spec)
  }
  return sidecar
}
```

- [ ] **Step 4: Run test, verify pass**

Run: `npx vitest run test/unit/code-check-fetch-attach.test.js`
Expected: 3 passing.

- [ ] **Step 5: Wire into the build**

Edit `scripts/fetch-tutorials.ts` near line 654 (look for `await fetchRulesVr(t.slug, …)`).

Replace the existing rules-handling block (currently parses and attaches `validation`) with a version that also handles CODECHECK. Schematic — the surrounding lines are unchanged; only the block inside the `if (rulesContent)` branch grows:

```ts
// At the top of the file, alongside the existing rules import:
import { parseCodeCheckBlocks, attachCodeCheckSpecs } from './parsers/codecheck.js'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
// (keep existing imports)

// Inside the existing `if (rulesContent) { … }` block, AFTER the
// validationMap loop completes:
const codeCheckMap = parseCodeCheckBlocks(rulesContent)
if (codeCheckMap.size) {
  const sidecar = attachCodeCheckSpecs(steps, codeCheckMap)
  if (sidecar.length) {
    const sidecarPath = join(cacheDir, `${t.slug}.codecheck.json`)
    writeFileSync(sidecarPath, JSON.stringify({ slug: t.slug, specs: sidecar }, null, 2))
  }
}
```

(`cacheDir` is the existing variable in scope — confirm by reading 50 lines above the insertion point. If it has a different name, use that.)

- [ ] **Step 6: Update `render-frontmatter.ts` to surface codeCheck**

In `scripts/parsers/render-frontmatter.ts`, find the step rendering (look for `validation:` field emission near line 76). Add `codeCheck` alongside it. The renderer iterates step objects and emits YAML; mirror the existing pattern. Example, in pseudocode of the rendering output:

```yaml
steps:
  - number: 2
    title: Implement
    codeCheck:
      goal: Add handler
      language: javascript
      hints:
        - see srv/
      hasReference: true
```

The renderer is plain serialization; if it uses YAML.stringify, simply including `codeCheck` on the step object is enough. Read the file to confirm; you may not need any code change here if the existing renderer just dumps the step object.

- [ ] **Step 7: Smoke run the build against one cached tutorial**

If `.tutorial-cache/` already has tutorials, pick one with a sidecar test. Run a one-off:

```bash
node -e "
const {parseCodeCheckBlocks, attachCodeCheckSpecs} = require('./scripts/parsers/codecheck.js');
const fs = require('node:fs');
const sample = '[CODECHECK_1]\n###Goal\nDo it.\n';
const m = parseCodeCheckBlocks(sample);
const steps = [{number: 1, title: 'X'}];
const side = attachCodeCheckSpecs(steps, m);
console.log(JSON.stringify({ steps, side }, null, 2));
"
```

Expected: prints `steps[0].codeCheck = { goal: 'Do it.', hasReference: false }` and a one-element sidecar.

- [ ] **Step 8: Commit**

```bash
git add scripts/parsers/codecheck.ts scripts/fetch-tutorials.ts scripts/parsers/render-frontmatter.ts test/unit/code-check-fetch-attach.test.js
git commit -m "feat(codecheck): wire parser into fetch-tutorials build (#171)

- attachCodeCheckSpecs() trims spec for Hugo, returns full sidecar
  for the publish step.
- fetch-tutorials writes .tutorial-cache/<slug>.codecheck.json when
  any block parses successfully.
- render-frontmatter surfaces codeCheck on steps.

Reference solutions never reach Hugo frontmatter."
```

---

### Task 1.4 — Prompt builder + JSON schema (pure module, no LLM yet)

**Files:**
- Create: `srv/lib/code-check-prompt.js`
- Test: `test/unit/code-check-prompt.test.js` (new)

This task is a pure module — no network, no DB. The dispatch function (next task) consumes it.

- [ ] **Step 1: Write the failing test**

Create `test/unit/code-check-prompt.test.js`:

```js
import { describe, it, expect } from 'vitest';
import {
  buildSystemPrompt,
  buildUserMessage,
  CHECK_CODE_OUTPUT_SCHEMA,
  redactReferenceLeaks
} from '../../srv/lib/code-check-prompt.js';

describe('code-check prompt builder', () => {
  it('system prompt mentions verdict scale and never-quote rule', () => {
    const sys = buildSystemPrompt();
    expect(sys).toMatch(/pass.*partial.*fail/i);
    expect(sys).toMatch(/NEVER QUOTE/i);
    expect(sys).toMatch(/JSON/i);
  });

  it('user message orders sections deterministically', () => {
    const msg = buildUserMessage({
      goal: 'G',
      stepText: 'STEP',
      tutorialSamples: 'SAMPLE',
      referenceSolution: 'REF',
      language: 'javascript',
      submittedCode: 'USER'
    });
    const idx = (s) => msg.indexOf(s);
    expect(idx('Goal:')).toBeGreaterThanOrEqual(0);
    expect(idx('Goal:')).toBeLessThan(idx('Step text'));
    expect(idx('Step text')).toBeLessThan(idx("Tutorial's example"));
    expect(idx("Tutorial's example")).toBeLessThan(idx('Reference solution'));
    expect(idx('Reference solution')).toBeLessThan(idx("Learner's submission"));
  });

  it('omits absent sections cleanly', () => {
    const msg = buildUserMessage({ goal: 'G', submittedCode: 'U' });
    expect(msg).not.toMatch(/Step text/);
    expect(msg).not.toMatch(/Tutorial's example/);
    expect(msg).not.toMatch(/Reference solution/);
    expect(msg).toMatch(/Goal:/);
    expect(msg).toMatch(/Learner's submission/);
  });

  it('output schema enforces verdict enum', () => {
    expect(CHECK_CODE_OUTPUT_SCHEMA.required).toContain('verdict');
    expect(CHECK_CODE_OUTPUT_SCHEMA.properties.verdict.enum).toEqual(['pass','partial','fail']);
    expect(CHECK_CODE_OUTPUT_SCHEMA.additionalProperties).toBe(false);
  });

  it('redacts 30+ char overlap with reference solution', () => {
    const ref = "this.before('READ', 'Books', req => req.query.where('stock >', 0));";
    const verdict = {
      verdict: 'pass',
      summary: "this.before('READ', 'Books', req => req.query.where works fine.",
      suggestions: [],
      correctAspects: ['Used cds.ql']
    };
    const out = redactReferenceLeaks(verdict, ref);
    expect(out.summary).toBe('[redacted]');
    expect(out.correctAspects[0]).toBe('Used cds.ql');
  });

  it('does not redact short overlaps', () => {
    const ref = 'something specific';
    const verdict = {
      verdict: 'partial', summary: 'Use cds.ql',
      suggestions: [], correctAspects: []
    };
    const out = redactReferenceLeaks(verdict, ref);
    expect(out.summary).toBe('Use cds.ql');
  });

  it('redactReferenceLeaks is a no-op when reference is empty', () => {
    const verdict = { verdict: 'pass', summary: 'OK', suggestions: [], correctAspects: [] };
    expect(redactReferenceLeaks(verdict, '')).toEqual(verdict);
    expect(redactReferenceLeaks(verdict, null)).toEqual(verdict);
  });
});
```

- [ ] **Step 2: Run test, expect failure**

Run: `npx vitest run test/unit/code-check-prompt.test.js`
Expected: module not found.

- [ ] **Step 3: Implement the module**

Create `srv/lib/code-check-prompt.js` with three exported functions and one constant:

1. `buildSystemPrompt()` — returns the multi-line system prompt verbatim from spec §6 (the "You are a patient programming instructor…" block, the verdict-scale rules 1-9). Include `PROMPT_VERSION = 'v1'` as a top-level constant.
2. `buildUserMessage({ goal, stepText?, tutorialSamples?, referenceSolution?, language?, submittedCode })` — returns the deterministic-ordered string with sections: `Goal:` → `Step text:` → `Tutorial's example code:` → `Reference solution (DO NOT QUOTE…):` → `Language hint:` → `Learner's submission:`. Absent optional sections are omitted entirely (no placeholder headers). Code blocks are fenced with the language hint when present.
3. `CHECK_CODE_OUTPUT_SCHEMA` — the JSON schema constant from spec §6 with `additionalProperties: false`, `required: ['verdict','summary','correctAspects','suggestions']`, `verdict.enum: ['pass','partial','fail']`. NOTE the comment in the file: this schema is used as a **forced tool-call's `parameters`**, not `response_format`. The codebase's `OrchestrationClient` delivers structured output via tool_choice (see `generateAnalyticsQuery` in `srv/lib/chat-orchestrator.js`).
4. `redactReferenceLeaks(verdict, referenceSolution)` — sliding-window check: if any 30-char window of the reference (after collapsing whitespace) appears in `summary`/`suggestions[i]`/`correctAspects[i]`, that field is replaced with the literal string `'[redacted]'`. Empty/null reference → no-op. Whitespace normalization uses `.replace(/\s+/g, ' ')` on both sides before substring search.

Implementation hint: keep `REDACT_WINDOW = 30` as a module-private const so the test and the impl share the magic number. Iterate `for (let i = 0; i + REDACT_WINDOW <= ref.length; i++)` and `.includes(ref.slice(i, i + REDACT_WINDOW))`.

- [ ] **Step 4: Run test, verify pass**

Run: `npx vitest run test/unit/code-check-prompt.test.js`
Expected: 7 passing.

- [ ] **Step 5: Commit**

```bash
git add srv/lib/code-check-prompt.js test/unit/code-check-prompt.test.js
git commit -m "feat(codecheck): prompt builder + reference-leak guard (#171)

Pure module: system prompt, deterministic user-message ordering,
JSON-schema constants for the forced tool-call output, and the
30-char-window redactReferenceLeaks() guard. No network."
```

---

### Task 1.5 — `dispatchCheckCode()` core (mock LLM, real DB)

**Files:**
- Create: `srv/lib/code-check-tool.js`
- Test: `test/unit/code-check-tool.test.js` (new)

This is where the spike's center of gravity lives. A single function:
- Takes `{ tutorialSlug, stepNumber, submittedCode, language, user }`.
- Loads the spec from HANA (mockable in unit tests by injecting a `db` arg).
- Loads step text from the published HTML manifest (also injectable).
- Calls the LLM via a `callModel` callback (injected — real `OrchestrationClient` is wired in Task 1.7).
- Applies leak redaction.
- Persists `CodeCheckSubmissions`.
- Returns the verdict object.

By making the LLM and DB callable injectable, all unit tests can run without a network or HANA.

- [ ] **Step 1: Write the failing test**

Create `test/unit/code-check-tool.test.js`. Cover, in this order:

1. **Happy path:** mock spec returned from db, mock callModel returns `{verdict:'pass', summary:'OK', correctAspects:['x'], suggestions:[]}`. `dispatchCheckCode` returns the verdict and inserts a `CodeCheckSubmissions` row with the verdict + token telemetry.
2. **Spec missing:** db returns no spec → returns `{verdict:'error', errorReason:'spec_missing'}`, persists row with same.
3. **Upstream LLM error:** callModel throws → returns `{verdict:'error', errorReason:'upstream'}`, persists row.
4. **Schema mismatch:** callModel resolves with malformed object (missing `summary`) → `{verdict:'error', errorReason:'schema'}`, persists.
5. **Reference leak redaction:** mock spec has a 60-char `referenceSolution`; mock LLM returns a verdict whose summary contains a 30-char overlap → persisted summary is `'[redacted]'`, leak warning logged.
6. **`codeCheckEnabled = false`:** dispatch is short-circuited (the dispatch reads ChatSettings at the top — confirms in test by mocking `db.read(ChatSettings)` to return `{codeCheckEnabled: false}`); returns `{verdict:'error', errorReason:'disabled'}`, no LLM call attempted.

Use a small in-memory deploy of `db/schema.cds` to SQLite and `cds.connect.to('db')` for persistence; mock the spec + LLM via a `dependencies` parameter the dispatch accepts. Sketch:

```js
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import path from 'node:path';
import cds from '@sap/cds';
import { dispatchCheckCode } from '../../srv/lib/code-check-tool.js';

beforeAll(async () => {
  await cds.deploy(path.join(process.cwd(), 'db', 'schema.cds')).to('sqlite::memory:');
});

beforeEach(async () => {
  const { CodeCheckSpecs, CodeCheckSubmissions, ChatSettings, Tutorials } =
    cds.entities('com.sap.developers.ims');
  await DELETE.from(CodeCheckSubmissions);
  await DELETE.from(CodeCheckSpecs);
  await DELETE.from(ChatSettings);
  await DELETE.from(Tutorials);
  await INSERT.into(ChatSettings).entries({
    ID: '00000000-0000-0000-0000-000000000001',
    enabled: true, codeCheckEnabled: true
  });
  await INSERT.into(Tutorials).entries({
    ID: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    slug: 'sample', title: 'Sample', status: 'ACTIVE'
  });
  await INSERT.into(CodeCheckSpecs).entries({
    tutorial_ID: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    stepNumber: 2, goal: 'Add handler', language: 'javascript',
    referenceSolution: null, hasReference: false
  });
});

it('happy path persists verdict + tokens', async () => {
  const callModel = vi.fn().mockResolvedValue({
    verdict: { verdict: 'pass', summary: 'OK', correctAspects: ['x'], suggestions: [] },
    promptTokens: 1500, completionTokens: 200, modelName: 'gpt-4o'
  });
  const out = await dispatchCheckCode(
    { tutorialSlug: 'sample', stepNumber: 2, submittedCode: 'console.log(1)' },
    { user: { id: 'u1' }, callModel, loadStepText: async () => 'STEP TEXT' }
  );
  expect(out.verdict).toBe('pass');
  const { CodeCheckSubmissions } = cds.entities('com.sap.developers.ims');
  const rows = await SELECT.from(CodeCheckSubmissions);
  expect(rows).toHaveLength(1);
  expect(rows[0].verdict).toBe('pass');
  expect(rows[0].promptTokens).toBe(1500);
  expect(rows[0].modelName).toBe('gpt-4o');
});
```

(Author the remaining 5 cases following the same shape.)

- [ ] **Step 2: Run test, expect failure**

Run: `npx vitest run test/unit/code-check-tool.test.js`
Expected: module not found.

- [ ] **Step 3: Implement `dispatchCheckCode`**

Create `srv/lib/code-check-tool.js` with this contract:

```
import cds from '@sap/cds';
import {
  buildSystemPrompt, buildUserMessage,
  CHECK_CODE_OUTPUT_SCHEMA, redactReferenceLeaks
} from './code-check-prompt.js';
const LOG = cds.log('code-check');

export async function dispatchCheckCode(input, deps) { ... }
```

The function does these things in order:

1. **Read** `cds.context.user` once — short-circuit cleanly if absent. Read `startedAt = Date.now()`.
2. **Lowercase** `tutorialSlug` (canonical-form, per the existing project convention noted in CLAUDE.md "Tutorial slugs are lowercase canonical").
3. **Resolve `db`** = `deps.db || await cds.connect.to('db')`.
4. **Load `ChatSettings`** singleton (`db.read(ChatSettings).limit(1)`). If `!settings?.codeCheckEnabled`, persist an error row with `errorReason: 'disabled'` and return `{ verdict: 'error', errorReason: 'disabled' }` without calling the LLM.
5. **Look up Tutorial** by slug then **load CodeCheckSpec** by `(tutorial_ID, stepNumber)`. Missing → persist `errorReason: 'spec_missing'`, return.
6. **Load step text** via `await deps.loadStepText(slug, stepNumber)` (errors swallowed → null is OK).
7. **Extract fenced code blocks** from step text using `String.prototype.matchAll(/\`\`\`[a-z0-9]*\n([\s\S]*?)\`\`\`/gi)` — note: `matchAll`, not the regex method whose name starts with "ex" (the security hook flags that name as a child_process false positive). Join blocks with blank lines. Empty string if no fenced blocks.
8. **Build prompt** via `buildUserMessage(...)`.
9. **Call the LLM** via `await deps.callModel({ system, user, schema, language })`. The callback's contract: returns `{ verdict, promptTokens, completionTokens, modelName }`. Wrap in try/catch — any throw → persist `errorReason: 'upstream'`, return.
10. **Validate verdict shape** — must have `verdict ∈ {pass,partial,fail}`, `summary: string`, `Array.isArray(correctAspects)`, `Array.isArray(suggestions)`. Otherwise persist `errorReason: 'schema'`, return (also persist token telemetry — these tokens were spent).
11. **Redact reference leaks** via `redactReferenceLeaks(verdict, spec.referenceSolution)`. If the redactor changed anything, log a warn line with `{ slug, stepNumber }`.
12. **Persist** the full row to `CodeCheckSubmissions` — JSON-stringify the `suggestions` and `correctAspects` arrays. Anonymous user → `user_ID: null`.
13. **Return** the redacted verdict.

A helper `persistError(db, table, ctx)` keeps the four error paths DRY.

A helper `safeCall(fn, ...args)` swallows callback errors so a flaky `loadStepText` never breaks the dispatch.

Use `cds.utils.uuid()` for new IDs.

- [ ] **Step 4: Run test, verify pass**

Run: `npx vitest run test/unit/code-check-tool.test.js`
Expected: 6 passing.

- [ ] **Step 5: Commit**

```bash
git add srv/lib/code-check-tool.js test/unit/code-check-tool.test.js
git commit -m "feat(codecheck): dispatchCheckCode core with injected LLM + DB (#171)

Single dispatch path consumed by both /api/codecheck and the chat
tool. Persists CodeCheckSubmissions on every outcome with full token
+ latency telemetry. Honors codeCheckEnabled flag. Applies leak
redaction post-LLM. LLM and step-text loaders are injected for
testability — no network in unit tests."
```

---

### Task 1.6 — Express endpoint `/api/codecheck` + per-user rate limit

**Files:**
- Create: `srv/lib/code-check-handler.js`
- Modify: `srv/server.js` (add the route in the bootstrap block, alongside `/feedback/submit` near line 172)
- Test: `test/unit/code-check-handler.test.js` (new)

The handler is a thin shell: validates body, applies two rate limits (per-user and per-step), looks up the user via the existing `contextMw + authMw` middleware chain, calls `dispatchCheckCode` with a stubbed `callModel` for now (Task 1.7 wires the real LLM), responds JSON.

- [ ] **Step 1: Write the failing test**

Create `test/unit/code-check-handler.test.js`. Express handlers are easiest to test with an in-process `supertest`-style call OR by invoking the handler function directly with mock req/res. The codebase has examples of both — pick whichever the closest existing handler test (e.g. `test/unit/build-my-progress.test.js`) uses.

Cover:

1. **Body validation:** missing `tutorialSlug` → 400 `{error:'invalid_body'}`. Missing `submittedCode` → 400. `submittedCode.length > 20000` → 400 `{error:'too_long'}`.
2. **Anonymous user → 401.** (`req.user.id === 'anonymous'` or `req.user` missing.)
3. **Happy path** with mock dispatch returning a `pass` verdict → 200 + JSON body matches verdict shape.
4. **Per-user rate limit** — 30 successful → 31st returns 429 `{error:'rate_limited', retryAfter: <seconds>}` with a `Retry-After` header.
5. **Per-step rate limit** — 5 in 5 min for the same `(slug, step)` from the same user → 6th returns 429.
6. **Failed dispatch (non-rate-limit error) doesn't count toward rate cap:** call dispatch returning `verdict:'error', errorReason:'upstream'`, observe the rate counter is NOT incremented.

The rate limiter should be a small in-memory `Map<key, number[]>` in the handler module exporting a `_resetRateLimitForTest()` symbol so tests can reset between cases.

- [ ] **Step 2: Run test, expect failure**

Run: `npx vitest run test/unit/code-check-handler.test.js`
Expected: module not found.

- [ ] **Step 3: Implement the handler**

Create `srv/lib/code-check-handler.js`. Sketch of the contract:

```
import { dispatchCheckCode } from './code-check-tool.js';
import { defaultCallModel } from './code-check-llm.js'; // created in Task 1.7
import { defaultLoadStepText } from './code-check-step-loader.js'; // created in Task 1.7

const PER_USER_LIMIT  = { count: 30, windowMs: 60 * 60 * 1000 };  // 30/hour
const PER_STEP_LIMIT  = { count: 5,  windowMs: 5  * 60 * 1000 };  // 5/5min
const MAX_CODE_BYTES  = 20_000;

const userCalls = new Map();   // userId -> number[]
const stepCalls = new Map();   // userId|slug|step -> number[]

export function _resetRateLimitForTest() {
  userCalls.clear(); stepCalls.clear();
}

export function makeCodeCheckHandler(deps = {}) {
  const callModel    = deps.callModel    ?? defaultCallModel;
  const loadStepText = deps.loadStepText ?? defaultLoadStepText;

  return async function codeCheckHandler(req, res) {
    if (!req.user || req.user.id === 'anonymous') {
      return res.status(401).json({ error: 'unauthenticated' });
    }
    const { tutorialSlug, stepNumber, submittedCode, language } = req.body || {};
    if (typeof tutorialSlug !== 'string' || !tutorialSlug
        || typeof stepNumber !== 'number'
        || typeof submittedCode !== 'string' || !submittedCode) {
      return res.status(400).json({ error: 'invalid_body' });
    }
    if (Buffer.byteLength(submittedCode, 'utf8') > MAX_CODE_BYTES) {
      return res.status(400).json({ error: 'too_long' });
    }

    const now = Date.now();
    const uid = req.user.id;
    const stepKey = `${uid}|${tutorialSlug.toLowerCase()}|${stepNumber}`;
    if (overLimit(userCalls, uid, now, PER_USER_LIMIT)) {
      return rateLimitResponse(res, userCalls.get(uid), now, PER_USER_LIMIT);
    }
    if (overLimit(stepCalls, stepKey, now, PER_STEP_LIMIT)) {
      return rateLimitResponse(res, stepCalls.get(stepKey), now, PER_STEP_LIMIT);
    }

    let verdict;
    try {
      verdict = await dispatchCheckCode(
        { tutorialSlug, stepNumber, submittedCode, language },
        { user: req.user, callModel, loadStepText }
      );
    } catch (err) {
      return res.status(500).json({ error: 'internal' });
    }

    // Disabled flag → 503 (matches spec)
    if (verdict.errorReason === 'disabled') {
      return res.status(503).json({ error: 'disabled' });
    }

    // Successful outcomes (pass/partial/fail) count toward limits.
    // 'error' outcomes do NOT — the user shouldn't be punished for our flake.
    if (verdict.verdict !== 'error') {
      record(userCalls, uid, now, PER_USER_LIMIT.windowMs);
      record(stepCalls, stepKey, now, PER_STEP_LIMIT.windowMs);
    }

    return res.status(200).json(verdict);
  };
}

function record(map, key, now, windowMs) {
  const arr = map.get(key) || [];
  arr.push(now);
  while (arr.length && now - arr[0] > windowMs) arr.shift();
  map.set(key, arr);
}

function overLimit(map, key, now, limit) {
  const arr = map.get(key) || [];
  while (arr.length && now - arr[0] > limit.windowMs) arr.shift();
  map.set(key, arr);
  return arr.length >= limit.count;
}

function rateLimitResponse(res, hits, now, limit) {
  const oldest = hits[0] ?? now;
  const retryAfterSec = Math.ceil((limit.windowMs - (now - oldest)) / 1000);
  res.setHeader('Retry-After', String(Math.max(1, retryAfterSec)));
  return res.status(429).json({ error: 'rate_limited', retryAfter: retryAfterSec });
}
```

- [ ] **Step 4: Wire into `srv/server.js`**

Find the bootstrap block where `/feedback/submit` is added (around line 172). Add nearby:

```js
import { makeCodeCheckHandler } from './lib/code-check-handler.js';
// ...
const codeCheckHandler = makeCodeCheckHandler();
app.post('/api/codecheck',
  express.json({ limit: '64kb' }),
  contextMw, authMw,
  codeCheckHandler
);
```

`contextMw` and `authMw` are already declared near line 251 — re-use them.

- [ ] **Step 5: Run test, verify pass**

Run: `npx vitest run test/unit/code-check-handler.test.js`
Expected: 6 passing.

Run the full unit suite to confirm no regressions: `npm test -- --run`

- [ ] **Step 6: Commit**

```bash
git add srv/lib/code-check-handler.js srv/server.js test/unit/code-check-handler.test.js
git commit -m "feat(codecheck): /api/codecheck endpoint with rate limits (#171)

- Per-user: 30 successful checks / hour.
- Per-(user,slug,step): 5 / 5 min.
- 401 for anonymous, 400 for invalid body or > 20 KB code,
  429 with Retry-After on rate cap, 503 when codeCheckEnabled=false.
- Failed dispatches (errorReason='upstream') do NOT count toward
  the rate cap so transient flake doesn't punish learners.
- LLM + step-loader are injected; defaults wired in Task 1.7."
```

---

### Task 1.7 — Real LLM call: forced tool-call via OrchestrationClient

**Files:**
- Create: `srv/lib/code-check-llm.js`
- Create: `srv/lib/code-check-step-loader.js`
- Test: `test/unit/code-check-llm.test.js` (new)

This is the only place that talks to SAP Generative AI Hub. Two functions are exported. Both ship a default that the handler uses, and both are stubable for tests.

`defaultCallModel({ system, user, schema, language? })` — returns `{ verdict, promptTokens, completionTokens, modelName }`.

The codebase's existing structured-output mechanism: a tool whose `parameters` IS the desired output schema is registered, then the model is FORCED to call it via `tool_choice`. The arguments JSON of the tool call is the structured output. (See `generateAnalyticsQuery` in `srv/lib/chat-orchestrator.js` for the working pattern.)

`defaultLoadStepText(slug, stepNumber)` — looks up published HTML from `ContentFiles`, decompresses, extracts text of step N (or full body if step extraction is too brittle for the spike). Returns string or null.

- [ ] **Step 1: Write the failing test (LLM only)**

Create `test/unit/code-check-llm.test.js`. The test mocks `OrchestrationClient` (`vi.mock('@sap-ai-sdk/orchestration', ...)`) and verifies:

1. `defaultCallModel` constructs the client with `tool_choice: { type: 'function', function: { name: 'submitVerdict' } }` and registers a single tool whose parameters are `CHECK_CODE_OUTPUT_SCHEMA`.
2. The system prompt and user message land in `messagesHistory`.
3. The returned `verdict` is parsed from the tool-call's `arguments` JSON.
4. `temperature: 0.1` is passed (overrides any settings.temperature).
5. `modelName` defaults from `ChatSettings.modelName` then `process.env.CHAT_MODEL_NAME` then `'anthropic--claude-4.6-sonnet'` — same fallback chain as `streamChat()` uses.
6. Token counts: `promptTokens` and `completionTokens` come from the response's usage fields when present; `null` otherwise.
7. If the model returns no tool call (legacy or refusal): the function throws (handler turns this into `errorReason:'schema'`).

- [ ] **Step 2: Run test, expect failure**

Run: `npx vitest run test/unit/code-check-llm.test.js`
Expected: module not found.

- [ ] **Step 3: Implement `defaultCallModel`**

Create `srv/lib/code-check-llm.js`:

```js
import cds from '@sap/cds';
import { OrchestrationClient } from '@sap-ai-sdk/orchestration';
import { CHECK_CODE_OUTPUT_SCHEMA } from './code-check-prompt.js';

const LOG = cds.log('code-check');
const VERDICT_TOOL_NAME = 'submitVerdict';

export async function defaultCallModel({ system, user, schema }) {
  const db = await cds.connect.to('db');
  const { ChatSettings } = cds.entities('com.sap.developers.ims');
  const settings = (await db.read(ChatSettings).limit(1))[0] || {};
  const modelName = settings.modelName
    || process.env.CHAT_MODEL_NAME
    || 'anthropic--claude-4.6-sonnet';
  const deploymentId = settings.deploymentId;
  const maxTokens = 800;

  const tool = {
    type: 'function',
    function: {
      name: VERDICT_TOOL_NAME,
      description: 'Submit your structured verdict for the learner code submission.',
      parameters: schema || CHECK_CODE_OUTPUT_SCHEMA
    }
  };

  let client;
  try {
    client = new OrchestrationClient({
      promptTemplating: {
        model: { name: modelName, params: { max_tokens: maxTokens, temperature: 0.1 } },
        prompt: {
          template: [{ role: 'system', content: system }],
          tools: [tool],
          tool_choice: { type: 'function', function: { name: VERDICT_TOOL_NAME } }
        }
      }
    }, { deploymentId });
  } catch (err) {
    LOG.error('OrchestrationClient init failed for code-check', err.message);
    throw err;
  }

  const messagesHistory = [{ role: 'user', content: user }];
  const response = await client.chatCompletion({ messagesHistory });

  const toolCalls = typeof response.getToolCalls === 'function' ? response.getToolCalls() : null;
  const call = Array.isArray(toolCalls) ? toolCalls.find(tc => tc.function?.name === VERDICT_TOOL_NAME) : null;
  if (!call) {
    throw new Error('LLM did not invoke the forced verdict tool');
  }

  const args = call.function?.arguments;
  let verdict;
  try {
    verdict = typeof args === 'string' ? JSON.parse(args) : args;
  } catch {
    throw new Error('LLM returned non-JSON tool arguments');
  }

  // Usage may not be populated by all providers; safely extract.
  const usage = typeof response.getUsage === 'function' ? response.getUsage() : null;
  const promptTokens     = usage?.prompt_tokens     ?? usage?.input_tokens  ?? null;
  const completionTokens = usage?.completion_tokens ?? usage?.output_tokens ?? null;

  return { verdict, promptTokens, completionTokens, modelName };
}
```

A note on `chatCompletion` vs `stream`: the existing `streamChat` in `chat-orchestrator.js` uses `client.stream(...)` because it pipes deltas to SSE. The code-check path is a single round-trip — use `client.chatCompletion(...)` (or whichever non-streaming method the SDK exposes; if none, accumulate the stream and parse on completion). Confirm by reading `node_modules/@sap-ai-sdk/orchestration/dist/index.d.ts` before implementing.

- [ ] **Step 4: Implement `defaultLoadStepText`**

Create `srv/lib/code-check-step-loader.js`. For the spike, "step text" can be approximated cheaply by reading from `.tutorial-cache/<slug>.json` if the build artifacts are mounted on the srv container, OR by selecting the step's markdown source from the `Tutorials.body` column if that's where it lives. **The spec accepts step-text being optional** — if loading fails or is unavailable, return null and the prompt simply omits the section.

For the spike, implement the simplest version that gives the LLM something useful: SELECT the published HTML for the slug from `ContentFiles` (use the same decompression path as `srv/lib/content-store.js:serveHandler`), strip HTML to plain text via a quick regex (`s.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()`), and slice to a reasonable max (e.g. 3000 chars). Step-level granularity is a nice-to-have for the spike — full-tutorial body is acceptable. Document the trade-off as a TODO inline.

- [ ] **Step 5: Run test, verify pass**

Run: `npx vitest run test/unit/code-check-llm.test.js`
Expected: 7 passing.

- [ ] **Step 6: Commit**

```bash
git add srv/lib/code-check-llm.js srv/lib/code-check-step-loader.js test/unit/code-check-llm.test.js
git commit -m "feat(codecheck): real LLM call via forced tool-call (#171)

- defaultCallModel uses OrchestrationClient with a single 'submitVerdict'
  tool whose parameters schema enforces the structured verdict shape.
  Forced via tool_choice — same pattern as generateAnalyticsQuery.
- temperature=0.1, maxTokens=800 hardcoded for code-check (overrides
  ChatSettings.temperature which is tuned for chat).
- defaultLoadStepText returns full-tutorial plain text from ContentFiles
  for the spike — TODO step-level slicing if Phase 4 graduates."
```

---

### Task 1.8 — Server side of the publish protocol: `POST /content/code-check-specs`

**Files:**
- Create: `srv/lib/code-check-spec-publish.js`
- Modify: `srv/server.js` (wire route alongside existing `/content/publish/*` routes near line 155)
- Test: `test/unit/code-check-spec-publish.test.js` (new)

The CLI side ships `[{ slug, stepNumber, goal, language, hints, referenceSolution }]`. The server upserts into `CodeCheckSpecs`, joining on `Tutorials.slug` to find the FK. Carry-forward semantics: specs not in the payload are NOT deleted (matches existing `RepoCatalog` behavior). Bearer-auth via `CONTENT_API_KEY` (use the existing `contentAuthMiddleware`).

- [ ] **Step 1: Write the failing test**

Create `test/unit/code-check-spec-publish.test.js`. Cover:

1. **Happy path:** payload with two specs against two known slugs → both upserted, response 200 `{ upserted: 2 }`.
2. **Slug not found:** payload references a slug that doesn't exist in `Tutorials` → that spec is skipped, response includes `{ upserted: 1, skipped: ['unknown-slug'] }`.
3. **Idempotent:** same payload twice → both calls succeed, second leaves the row unchanged (verify by checking `modifiedAt` doesn't move OR by counting rows).
4. **Hints stored as JSON string:** the `hints: ['a', 'b']` array is JSON.stringified before insert.
5. **Validation:** payload missing required `goal` → 400 `{ error: 'invalid_spec' }`.

- [ ] **Step 2: Run test, expect failure**

Run: `npx vitest run test/unit/code-check-spec-publish.test.js`
Expected: module not found.

- [ ] **Step 3: Implement the handler**

Create `srv/lib/code-check-spec-publish.js`:

```js
import cds from '@sap/cds';
const LOG = cds.log('code-check-publish');

export async function codeCheckSpecPublishHandler(req, res) {
  const body = req.body;
  if (!body || !Array.isArray(body.specs)) {
    return res.status(400).json({ error: 'invalid_body' });
  }

  for (const s of body.specs) {
    if (!s || typeof s.slug !== 'string'
        || typeof s.stepNumber !== 'number'
        || typeof s.goal !== 'string' || !s.goal) {
      return res.status(400).json({ error: 'invalid_spec' });
    }
  }

  const db = await cds.connect.to('db');
  const { Tutorials, CodeCheckSpecs } = cds.entities('com.sap.developers.ims');

  const skipped = [];
  let upserted = 0;

  for (const s of body.specs) {
    const slug = s.slug.toLowerCase();
    const tut = (await db.read(Tutorials).where({ slug }).limit(1))[0];
    if (!tut) { skipped.push(slug); continue; }
    const existing = await db.read(CodeCheckSpecs).where({
      tutorial_ID: tut.ID, stepNumber: s.stepNumber
    }).limit(1);

    const row = {
      tutorial_ID: tut.ID,
      stepNumber: s.stepNumber,
      goal: s.goal,
      language: s.language || null,
      hints: s.hints ? JSON.stringify(s.hints) : null,
      referenceSolution: s.referenceSolution || null,
      hasReference: Boolean(s.referenceSolution)
    };

    if (existing[0]) {
      await db.run(UPDATE(CodeCheckSpecs).set(row).where({
        tutorial_ID: tut.ID, stepNumber: s.stepNumber
      }));
    } else {
      await db.run(INSERT.into(CodeCheckSpecs).entries(row));
    }
    upserted++;
  }

  LOG.info('code-check-spec-publish', { upserted, skipped: skipped.length });
  return res.status(200).json({ upserted, skipped });
}
```

- [ ] **Step 4: Wire route in `srv/server.js`**

Near the existing `/content/publish/*` routes (line ~155), add:

```js
import { codeCheckSpecPublishHandler } from './lib/code-check-spec-publish.js';
// ...
app.post('/content/code-check-specs',
  express.json({ limit: '5mb' }),
  contentAuthMiddleware,
  codeCheckSpecPublishHandler
);
```

- [ ] **Step 5: Run test, verify pass**

Run: `npx vitest run test/unit/code-check-spec-publish.test.js`
Expected: 5 passing.

- [ ] **Step 6: Commit**

```bash
git add srv/lib/code-check-spec-publish.js srv/server.js test/unit/code-check-spec-publish.test.js
git commit -m "feat(codecheck): /content/code-check-specs publish endpoint (#171)

- Bearer-auth (CONTENT_API_KEY) via existing contentAuthMiddleware.
- Upsert by (tutorial_ID, stepNumber); slug lookup via Tutorials.
- Carry-forward: specs absent from a payload are NOT deleted, matching
  RepoCatalog semantics. Reference solutions land server-side only.
- Validation: 400 on missing goal/slug/stepNumber."
```

---

### Task 1.9 — Register `checkCode` as a Joule chat tool

**Files:**
- Modify: `srv/lib/chat-orchestrator.js` (add tool def + dispatch case + flag-gated registration)
- Test: extend `test/unit/code-check-tool.test.js` OR create `test/unit/chat-orchestrator-codecheck.test.js`

This makes the same `dispatchCheckCode` reachable when a learner pastes code in the Joule chat panel.

- [ ] **Step 1: Write the failing test**

Verify (in a small test):

1. `toolsForContext({pageContext:{kind:'tutorial'}, isAdmin:false})` includes `checkCode` when `ChatSettings.codeCheckEnabled = true`, omits it when false.
2. `dispatchTool('checkCode', { tutorialSlug, stepNumber, submittedCode }, user)` returns the dispatch's verdict object.

- [ ] **Step 2: Run test, expect failure**

Run: `npx vitest run test/unit/chat-orchestrator-codecheck.test.js`
Expected: tool not registered.

- [ ] **Step 3: Add the tool definition + dispatch**

In `srv/lib/chat-orchestrator.js`:

After the existing `GET_USER_PROGRESS_TOOL` constant, add:

```js
const CHECK_CODE_TOOL = {
  type: 'function',
  function: {
    name: 'checkCode',
    description: 'Grade a learner-submitted code snippet against a tutorial step\'s author-defined goal. Returns a structured verdict with pass/partial/fail, a summary, suggestions, and what the learner got right. Use ONLY when the user has pasted code AND named a tutorial slug + step number.',
    parameters: {
      type: 'object',
      required: ['tutorialSlug', 'stepNumber', 'submittedCode'],
      properties: {
        tutorialSlug:  { type: 'string' },
        stepNumber:    { type: 'integer' },
        submittedCode: { type: 'string', maxLength: 20000 },
        language:      { type: 'string' }
      }
    }
  }
};
```

In `toolsForContext()`, after the existing `ragEnabled` block, add:

```js
try {
  const settings = await SELECT.one.from(cds.entities('com.sap.developers.ims').ChatSettings);
  if (settings?.codeCheckEnabled) tools.push(CHECK_CODE_TOOL);
} catch (err) { LOG.warn('toolsForContext: codeCheckEnabled read failed', err.message); }
```

(Or — cleaner — fold the read into the existing settings read so we don't hit the DB twice.)

In `dispatchTool()`, before the final `return { error: 'unknown_tool' }`, add:

```js
if (name === 'checkCode') {
  const { dispatchCheckCode } = await import('./code-check-tool.js');
  const { defaultCallModel }     = await import('./code-check-llm.js');
  const { defaultLoadStepText }  = await import('./code-check-step-loader.js');
  return dispatchCheckCode(args, { user, callModel: defaultCallModel, loadStepText: defaultLoadStepText });
}
```

Dynamic imports avoid the chat module pulling the LLM-specific surface area when it isn't enabled.

- [ ] **Step 4: Run test, verify pass**

Run: `npx vitest run test/unit/chat-orchestrator-codecheck.test.js`
Expected: 2 passing.

Run all unit tests: `npm test -- --run`. Expected: green.

- [ ] **Step 5: Commit**

```bash
git add srv/lib/chat-orchestrator.js test/unit/chat-orchestrator-codecheck.test.js
git commit -m "feat(codecheck): register checkCode as a Joule chat tool (#171)

- Tool surface: { tutorialSlug, stepNumber, submittedCode, language? }
- Gated on ChatSettings.codeCheckEnabled — omitted from toolsForContext
  when false (mirrors the RAG/getRelevantSteps gating pattern).
- Dispatch delegates to dispatchCheckCode with the same defaults the
  Express endpoint uses, so chat + inline UI share one codepath."
```

End-of-Phase-1 checkpoint:

- Backend can grade a paste — verifiable by enabling the flag in DEV ChatSettings, seeding one CodeCheckSpec via `POST /content/code-check-specs`, then `POST /api/codecheck` with an XSUAA token returns a real verdict.
- All 8 unit test files green.
- No frontend yet.

Open a draft PR at this point so review can start in parallel with Phase 2.

---

## Phase 2 — Publish CLI extension + frontend island

End state: a learner on a tutorial step that has a CODECHECK block sees the inline panel, pastes code, gets a verdict. Pilot tutorial(s) have authored content live.

### Task 2.1 — Publish CLI: ship full specs to `/content/code-check-specs`

**Files:**
- Modify: `scripts/publish-content.ts` (after the existing chunked file-batch commit, before auto-verify)
- Test: `test/unit/code-check-publish-cli.test.js` (new; pure-function test of the spec-collection step)

The CLI side reads every `.tutorial-cache/<slug>.codecheck.json` written in Task 1.3 and POSTs the consolidated array to `/content/code-check-specs`.

- [ ] **Step 1: Write the failing test**

Test the spec-collection helper as a pure function. The actual HTTP call piggybacks on the existing `publish-client.js` helpers; don't re-test those.

```js
import { describe, it, expect } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { collectCodeCheckSpecs } from '../../scripts/lib/publish-codecheck.js';

it('collects all codecheck.json sidecars in cacheDir', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'cc-'));
  writeFileSync(path.join(dir, 'a.codecheck.json'),
    JSON.stringify({ slug: 'a', specs: [{ stepNumber: 2, goal: 'g1' }] }));
  writeFileSync(path.join(dir, 'b.codecheck.json'),
    JSON.stringify({ slug: 'b', specs: [{ stepNumber: 1, goal: 'g2' }] }));
  // unrelated file should be ignored
  writeFileSync(path.join(dir, 'a.json'), '{}');

  const out = collectCodeCheckSpecs(dir);
  expect(out).toHaveLength(2);
  expect(out.map(s => s.slug).sort()).toEqual(['a', 'b']);
  expect(out.find(s => s.slug === 'a').stepNumber).toBe(2);
});
```

- [ ] **Step 2: Run test, expect failure**

Run: `npx vitest run test/unit/code-check-publish-cli.test.js`
Expected: module not found.

- [ ] **Step 3: Implement `collectCodeCheckSpecs`**

Create `scripts/lib/publish-codecheck.js`:

```js
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const SUFFIX = '.codecheck.json';

/**
 * Reads every .codecheck.json sidecar in cacheDir and returns a flat
 * array of { slug, stepNumber, goal, language?, hints?, referenceSolution? }.
 */
export function collectCodeCheckSpecs(cacheDir) {
  const out = [];
  let entries;
  try { entries = readdirSync(cacheDir); } catch { return out; }
  for (const file of entries) {
    if (!file.endsWith(SUFFIX)) continue;
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(path.join(cacheDir, file), 'utf8'));
    } catch { continue; }
    if (!parsed || !parsed.slug || !Array.isArray(parsed.specs)) continue;
    for (const spec of parsed.specs) {
      out.push({ slug: parsed.slug, ...spec });
    }
  }
  return out;
}

export async function publishCodeCheckSpecs(baseUrl, apiKey, specs) {
  if (!specs.length) return { upserted: 0, skipped: [] };
  const res = await fetch(`${baseUrl}/content/code-check-specs`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify({ specs })
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`code-check publish failed (${res.status}): ${txt}`);
  }
  return await res.json();
}
```

- [ ] **Step 4: Wire into `scripts/publish-content.ts`**

After the existing chunked commit step succeeds, before the auto-verify step, add a call:

```ts
import { collectCodeCheckSpecs, publishCodeCheckSpecs } from './lib/publish-codecheck.js'

// ... after chunked commit ...
try {
  const specs = collectCodeCheckSpecs(cacheDir)  // same cacheDir variable as in fetch-tutorials.ts
  if (specs.length) {
    log(`Publishing ${specs.length} code-check spec(s) to /content/code-check-specs`)
    const result = await publishCodeCheckSpecs(opts.baseUrl, apiKey, specs)
    log(`✓ code-check specs upserted=${result.upserted} skipped=${result.skipped.length}`)
  }
} catch (err) {
  console.error('[publish-content] code-check spec publish failed (non-fatal):', formatErrorChain(err))
  // Do NOT exit non-zero — content publish is the critical path; specs are auxiliary.
}
```

(Confirm the `cacheDir` and `apiKey` variable names by reading the surrounding 50 lines.)

- [ ] **Step 5: Run test, verify pass**

Run: `npx vitest run test/unit/code-check-publish-cli.test.js`
Expected: 1 passing.

- [ ] **Step 6: Commit**

```bash
git add scripts/lib/publish-codecheck.js scripts/publish-content.ts test/unit/code-check-publish-cli.test.js
git commit -m "feat(codecheck): publish-content extension ships specs to HANA (#171)

After the chunked content commit, scan .tutorial-cache for
*.codecheck.json sidecars and POST them as one payload to
/content/code-check-specs. Failures are non-fatal — content
publish remains the critical path."
```

---

### Task 2.2 — Hugo: render the mount div on opted-in steps

**Files:**
- Create: `hugo/layouts/partials/codecheck-mount.html`
- Modify: `hugo/layouts/shortcodes/tutorial-step.html` (insert partial call when codeCheck is set)

- [ ] **Step 1: Add the partial**

Create `hugo/layouts/partials/codecheck-mount.html`:

```html
{{- /*
  AI code-check mount (issue #171). Hydrated by hugo-apps/src/code-check.
  Reference solution NEVER appears here — it lives only in HANA.
  Wrapped in QA-gate so it is omitted from /tutorials-qa/ where
  ChatSettings/codeCheckEnabled does not apply.
*/ -}}
{{- if not site.Params.qa -}}
{{- $cc := .codeCheck -}}
{{- if $cc -}}
<div class="step-codecheck-mount"
     data-slug="{{ .slug }}"
     data-step="{{ .stepNumber }}"
     data-goal="{{ $cc.goal }}"
     data-language="{{ default "" $cc.language }}"
     data-has-reference="{{ if $cc.hasReference }}true{{ else }}false{{ end }}"
     data-hints='{{ jsonify (default slice $cc.hints) }}'></div>
{{- end -}}
{{- end -}}
```

- [ ] **Step 2: Wire into the step shortcode**

In `hugo/layouts/shortcodes/tutorial-step.html`, near the existing `step-validation-mount` div (around line 17), add:

```html
{{ partial "codecheck-mount.html" (dict
  "slug"       $.Page.Params.slug
  "stepNumber" ($.Get "stepNumber")
  "codeCheck"  ($.Get "codeCheck")
) }}
```

- [ ] **Step 3: Smoke check the build**

Run: `npm run fetch-tutorials` (uses cache so it's fast) then `npm run dev` and open <http://localhost:1313/tutorials/SOME-PILOT-SLUG/>.

Expected: For now, no JS island is loaded (Task 2.3 ships it), but the DOM should contain a `<div class="step-codecheck-mount" …>` on the step that has a CODECHECK block. View source to confirm. The `data-has-reference` attribute should be present; `referenceSolution` should NOT be in the HTML at all.

- [ ] **Step 4: Commit**

```bash
git add hugo/layouts/partials/codecheck-mount.html hugo/layouts/shortcodes/tutorial-step.html
git commit -m "feat(codecheck): Hugo mount div on opted-in steps (#171)

Renders only when step.codeCheck is set and site.Params.qa is false.
Reference solution is never rendered here — server-only via HANA."
```

---

### Task 2.3 — Frontend island: paste box + verdict UI

**Files:**
- Create: `hugo-apps/src/code-check/main.ts`
- Create: `hugo-apps/src/code-check/CodeCheck.vue`
- Modify: `hugo-apps/vite.config.ts` (register entry; add gzip budget guard, target 8 KB)
- Modify: `hugo-apps/src/ui5-bootstrap.ts` (lazy-load when mount div present)

The island follows the existing `tutorial-rating` shape: a `main.ts` that mounts on `[id|class]` selector when present, and a `<Component>.vue` with the UI.

- [ ] **Step 1: Register the entry in `hugo-apps/vite.config.ts`**

Add `'code-check': resolve(__dirname, 'src/code-check/main.ts')` to the `rollupOptions.input` map. Also add a gzip budget guard following the existing `tutorialPrefsBudget()` pattern but for `code-check.js` with `MAX_CODE_CHECK_GZIP = 8 * 1024`.

- [ ] **Step 2: Lazy-load in `ui5-bootstrap.ts`**

Find the existing pattern for conditionally importing islands (look for similar `if (document.querySelector(...)) import(...)` blocks). Add:

```ts
if (document.querySelector('.step-codecheck-mount')) {
  import('./code-check/main.js')
}
```

- [ ] **Step 3: Implement `main.ts`**

```ts
import { createApp } from 'vue'
import CodeCheck from './CodeCheck.vue'

document.querySelectorAll('.step-codecheck-mount').forEach((el) => {
  const ds = (el as HTMLElement).dataset
  let hints: string[] = []
  try { hints = JSON.parse(ds.hints || '[]') } catch { /* ignore */ }
  createApp(CodeCheck, {
    slug: ds.slug || '',
    stepNumber: Number(ds.step || 0),
    goal: ds.goal || '',
    language: ds.language || '',
    hints,
    hasReference: ds.hasReference === 'true'
  }).mount(el as HTMLElement)
})
```

- [ ] **Step 4: Implement `CodeCheck.vue`**

Single-file component with:

- **Props:** `slug, stepNumber, goal, language, hints, hasReference`.
- **State:** `code: string`, `verdict: VerdictShape | null`, `error: 'rate_limited'|'unauthenticated'|'disabled'|'too_long'|'internal'|null`, `submitting: boolean`, `retryAfter: number`.
- **Template:**
  - `<ui5-panel header-text="Try it: code check">` containing:
    - Goal paragraph.
    - If `hints.length`: a `<ul>` of hints. Build via `createElement` + `textContent` (per the project's HTML-property hook rule — never the JS DOM HTML-write property).
    - `<textarea v-model="code" :disabled="submitting" />` styled with monospace font.
    - `<ui5-button design="Emphasized" @click="submit">Check my code</ui5-button>`.
    - `<ui5-busy-indicator v-if="submitting" active />`.
    - When `verdict`:
      - `<ui5-message-strip :design="stripDesign(verdict.verdict)">{{ verdict.summary }}</ui5-message-strip>`.
      - "What you got right:" `<ul>` of `verdict.correctAspects` (only if non-empty).
      - "Suggestions:" `<ul>` of `verdict.suggestions` (only if non-empty).
      - Two buttons: `<ui5-button @click="reset">Try again</ui5-button>` and `<ui5-button v-if="jouleAvailable" @click="askJoule">Ask Joule about this</ui5-button>`.
    - When `error === 'rate_limited'`: a `<ui5-message-strip design="Warning">You've used your hourly checks. Try again in {{ Math.ceil(retryAfter/60) }} min.</ui5-message-strip>`.
    - When `error === 'too_long'`: ditto with "Code is too long; please trim to ~500 lines."
    - When `error === 'unauthenticated'`: hide the textarea entirely; show "Sign in to check your code" with a link to the existing sign-in CTA.
- **`submit()`** — POST to `/api/codecheck` with `{ tutorialSlug: slug, stepNumber, submittedCode: code, language }`. Read `Retry-After` header on 429. Sets `verdict` or `error` accordingly.
- **`reset()`** — clears `verdict` and `error`; keeps `code` so the learner can iterate.
- **`askJoule()`** — calls `window.openJouleWith?.({ seed: 'I submitted code for step ' + stepNumber + ' of ' + slug + '. The grader said: ' + verdict.summary + '. Help me understand.' })`. Hidden when `window.openJouleWith` is undefined.
- **`jouleAvailable`** — computed: `typeof window !== 'undefined' && typeof window.openJouleWith === 'function'`.
- **`stripDesign(v)`** — `v === 'pass' ? 'Positive' : v === 'partial' ? 'Warning' : 'Negative'`.

- [ ] **Step 5: Run the build, watch the budget**

Run: `npm run build:apps` (or however hugo-apps is built; check `package.json` scripts). Watch the gzip budget log. If `code-check.js` exceeds 8 KB gzipped, prune imports until it fits.

- [ ] **Step 6: Manual smoke**

Build and serve locally with hybrid (`npm run dev:hybrid`). Navigate to a pilot tutorial with a CODECHECK block. Paste some code. Click "Check my code". Expect a verdict to render or a structured error.

- [ ] **Step 7: Commit**

```bash
git add hugo-apps/src/code-check hugo-apps/src/ui5-bootstrap.ts hugo-apps/vite.config.ts
git commit -m "feat(codecheck): inline paste-box island with verdict UI (#171)

UI5 panel with goal, hints, textarea, structured pass/partial/fail
verdict, Try-again button, Ask-Joule handoff. Lazy-loaded only when
.step-codecheck-mount is present. Bundle gzip budget: 8 KB."
```

---

### Task 2.4 — `@analytics.exposed` on `CodeCheckSubmissions`

**Files:**
- Modify: `app/admin-annotations.cds` (or wherever `@analytics.exposed` annotations live — the Analytics Explorer reads from here per CLAUDE.md)

- [ ] **Step 1: Find the annotation file**

Run: `grep -l '@analytics.exposed' app/ db/ srv/` to confirm. If it lives in `db/analytics-builder.cds`, edit there.

- [ ] **Step 2: Add the annotation**

```cds
annotate com.sap.developers.ims.CodeCheckSubmissions with @analytics.exposed;
```

- [ ] **Step 3: Verify the entity surfaces in `/admin/analytics`**

Run `cds watch`, visit `/admin-ui/#analytics-explorer`, confirm `CodeCheckSubmissions` appears in the entity browser.

- [ ] **Step 4: Commit**

```bash
git add app/admin-annotations.cds
git commit -m "feat(codecheck): expose CodeCheckSubmissions to Analytics Explorer (#171)

Lets us run ad-hoc verdict-distribution / latency / token-cost
queries from /admin-ui/#analytics-explorer without writing a
custom dashboard."
```

End of Phase 2:

- 3-5 pilot authors have added CODECHECK blocks to their `-Contribution` repos.
- Build + publish-content + island deployed to DEV with `codeCheckEnabled = true` on DEV ChatSettings only.
- A pilot author can paste code and see a verdict on a real tutorial in DEV.

---

## Phase 3 — Evidence collection: hybrid + smoke tests + eval harness

End state: hybrid + smoke suites are green; the eval harness has been run for each pilot tutorial and produced CSVs of agreement / disagreement per author.

### Task 3.1 — Hybrid test: real HANA, mocked LLM

**Files:**
- Create: `test/hybrid/code-check.test.js`

The hybrid suite hits real HANA via `cds bind --exec` but should NOT spend live model tokens in CI. The LLM is mocked; everything else (publish, persist, `@PersonalData` cascade, `@analytics.exposed` query) is real.

- [ ] **Step 1: Write the test**

Create `test/hybrid/code-check.test.js`. Before drafting, read `test/hybrid/_guard.js` and any neighbor (e.g. `test/hybrid/admin-analytics.test.js`) to mirror the `__TEST__` prefix + cleanup pattern.

Cover:

1. **Publish flow:** POST `/content/code-check-specs` with two specs against two `__TEST__`-prefixed slugs. Verify rows appear in `CodeCheckSpecs` joined to `Tutorials`.
2. **Carry-forward semantics:** publish only one of the two specs again; verify the other is NOT deleted.
3. **`dispatchCheckCode` against real HANA + mock LLM:** seed a spec, call dispatch with a mock callModel, verify a `CodeCheckSubmissions` row lands in HANA with full telemetry.
4. **`@PersonalData` cascade:** anonymize the test user via the existing `anonymizeUser` action, verify the submission's `user_ID` is null and `submittedCode` is nulled. (Reuse the pattern from `test/hybrid/admin-tutorials-enhancements.test.js` or wherever the existing personal-data tests live.)
5. **`@analytics.exposed` query works:** `AnalyticsService.runSelectQuery('SELECT verdict, COUNT(*) FROM "COM_SAP_DEVELOPERS_IMS_CODECHECKSUBMISSIONS" GROUP BY verdict')` returns a row count > 0 and is bounded by `LIMIT 5001`.

`afterAll` deletes all `__TEST__`-prefixed rows from `CodeCheckSpecs`, `CodeCheckSubmissions`, `Tutorials`.

- [ ] **Step 2: Set the write-safety env var and run**

```bash
ALLOW_HYBRID_WRITES=true npm run test:hybrid -- code-check
```

Expected: 5 passing.

- [ ] **Step 3: Commit**

```bash
git add test/hybrid/code-check.test.js
git commit -m "test(codecheck): hybrid suite — publish + persist + cascade + analytics (#171)

Real HANA via cds bind --exec; LLM mocked. Verifies the publish
endpoint, carry-forward, dispatch-with-real-DB, @PersonalData
anonymization cascade, and @analytics.exposed surfacing."
```

---

### Task 3.2 — Smoke test: HTTP against deployed DEV

**Files:**
- Create: `test/smoke/code-check.test.js`

Smoke does NO LLM calls; it verifies the HTTP contract.

- [ ] **Step 1: Write the test**

Create `test/smoke/code-check.test.js`. Mirror the existing patterns in `test/smoke/auth-enforcement.test.js` and `test/smoke/content-serve.test.js`.

Cover:

1. `POST ${SMOKE_SRV_URL}/api/codecheck` without auth → 401.
2. `POST ${SMOKE_SRV_URL}/api/codecheck` with a known-bad bearer token → 401.
3. `GET ${SMOKE_BASE_URL}/tutorials/<pilot-slug>/` returns HTML containing `class="step-codecheck-mount"` for at least one step. The HTML must NOT contain a `data-reference-solution` or `referenceSolution` attribute (anti-leak smoke). Use a regex that accepts both quoted and unquoted attribute values per the [Hugo minifier strips quotes](feedback-hugo-minifier-strips-quotes.md) memory.
4. (Optional, if a known XSUAA tech-user smoke token is available) authenticated POST returns 200 with a verdict object — but ONLY enable this test when `SMOKE_CODECHECK_TOKEN` env var is set; otherwise skip.

- [ ] **Step 2: Run against deployed DEV**

```bash
SMOKE_BASE_URL=https://tutorial-system-dev-approuter.cfapps.eu10-005.hana.ondemand.com \
SMOKE_SRV_URL=https://tutorial-system-dev-tutorials-srv.cfapps.eu10-005.hana.ondemand.com \
npm run test:smoke -- code-check
```

Expected: 3 passing (auth tests + anti-leak), authenticated test skipped unless token present.

- [ ] **Step 3: Add to deploy.yml smoke step**

The CI smoke step already runs the entire `test/smoke/` directory after deploy. The new file is picked up automatically. Confirm by inspecting `.github/workflows/deploy.yml` for any test-file allowlist.

- [ ] **Step 4: Commit**

```bash
git add test/smoke/code-check.test.js
git commit -m "test(codecheck): smoke — auth enforcement + anti-leak (#171)

401 on unauthenticated /api/codecheck POST; pilot tutorial HTML
contains the mount div but never a referenceSolution attribute."
```

---

### Task 3.3 — Manual evaluation harness

**Files:**
- Create: `scripts/evaluate-code-check.js`
- Create: `scripts/sample-submissions/README.md` (template doc for authors)

This is the spike's deliverable script. Author runs it locally with `cds bind --exec`. Reads a JSONL of expected-outcome submissions, calls live `dispatchCheckCode`, writes a CSV the author opens to manually rate agreement.

- [ ] **Step 1: Implement the script**

Create `scripts/evaluate-code-check.js`:

```js
#!/usr/bin/env node
/**
 * Spike eval harness (issue #171). Run with:
 *   ALLOW_HYBRID_WRITES=true \
 *   npx cds bind --exec -- node scripts/evaluate-code-check.js \
 *     --slug some-tutorial --step 3 \
 *     --submissions sample-submissions.jsonl \
 *     --output verdicts.csv
 *
 * sample-submissions.jsonl format (one per line):
 *   { "id": "s001", "expectedVerdict": "pass",    "code": "..." }
 *   { "id": "s002", "expectedVerdict": "partial", "code": "..." }
 *   { "id": "s003", "expectedVerdict": "fail",    "code": "..." }
 */
import cds from '@sap/cds';
import { readFileSync, writeFileSync } from 'node:fs';
import { dispatchCheckCode } from '../srv/lib/code-check-tool.js';
import { defaultCallModel } from '../srv/lib/code-check-llm.js';
import { defaultLoadStepText } from '../srv/lib/code-check-step-loader.js';

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

const slug = arg('slug');
const stepNumber = Number(arg('step'));
const submissionsPath = arg('submissions');
const outputPath = arg('output', 'verdicts.csv');
if (!slug || !stepNumber || !submissionsPath) {
  console.error('Usage: --slug X --step N --submissions file.jsonl [--output verdicts.csv]');
  process.exit(2);
}

const lines = readFileSync(submissionsPath, 'utf8').split('\n').filter(l => l.trim());
const submissions = lines.map(l => JSON.parse(l));

const rows = [['submission_id', 'expected', 'actual', 'summary', 'latency_ms', 'prompt_tokens', 'completion_tokens']];
for (const s of submissions) {
  const startedAt = Date.now();
  try {
    const verdict = await dispatchCheckCode(
      { tutorialSlug: slug, stepNumber, submittedCode: s.code },
      { user: { id: `eval-${s.id}` }, callModel: defaultCallModel, loadStepText: defaultLoadStepText }
    );
    // Re-fetch the persisted row to get token telemetry
    const db = await cds.connect.to('db');
    const { CodeCheckSubmissions } = cds.entities('com.sap.developers.ims');
    const recent = await db.read(CodeCheckSubmissions)
      .where({ tutorialSlug: slug.toLowerCase(), stepNumber })
      .orderBy({ createdAt: 'desc' })
      .limit(1);
    rows.push([
      s.id, s.expectedVerdict, verdict.verdict,
      JSON.stringify(verdict.summary || ''),
      String(Date.now() - startedAt),
      String(recent[0]?.promptTokens ?? ''),
      String(recent[0]?.completionTokens ?? '')
    ]);
    process.stdout.write('.');
  } catch (err) {
    rows.push([s.id, s.expectedVerdict, 'EXCEPTION', JSON.stringify(err.message), '', '', '']);
    process.stdout.write('!');
  }
}
process.stdout.write('\n');

const csv = rows.map(r => r.map(escape).join(',')).join('\n');
writeFileSync(outputPath, csv);
console.log(`Wrote ${rows.length - 1} rows to ${outputPath}`);
console.log('Open the CSV, add an "agree" column (TRUE/FALSE), compute %.');

function escape(v) {
  if (v == null) return '';
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
```

- [ ] **Step 2: Add the README for authors**

Create `scripts/sample-submissions/README.md`:

```markdown
# Sample submissions for code-check spike (issue #171)

Each line is one submission to grade. Format:

    {"id": "s001", "expectedVerdict": "pass",    "code": "...your code as a JSON string..."}
    {"id": "s002", "expectedVerdict": "partial", "code": "..."}
    {"id": "s003", "expectedVerdict": "fail",    "code": "..."}

Tips:
- Aim for 30 submissions per pilot tutorial step you want to evaluate.
- Spread them ~10/10/10 across pass/partial/fail to expose grader bias on each boundary.
- Include "off-topic" submissions (a poem, empty string, gibberish) — they should all return verdict=fail.
- Include near-correct-but-wrong-language submissions where the goal expects JS but the learner pastes Python.

Run:

    ALLOW_HYBRID_WRITES=true \
      npx cds bind --exec -- node scripts/evaluate-code-check.js \
      --slug your-tutorial-slug --step 3 \
      --submissions scripts/sample-submissions/your-slug-step-3.jsonl \
      --output verdicts/your-slug-step-3.csv

Open the CSV, add an "agree" column with TRUE / FALSE / partial, compute the
percentage on the pass/fail boundary alone (treat "partial" as agree if either
expected or actual is partial — the goal is the pass-vs-fail boundary).
```

- [ ] **Step 3: Add a `.gitignore` entry for verdicts**

Append to root `.gitignore`:

```
# Code-check spike (issue #171) — author-rated CSVs are local artefacts.
/verdicts/
```

- [ ] **Step 4: Commit**

```bash
git add scripts/evaluate-code-check.js scripts/sample-submissions/README.md .gitignore
git commit -m "feat(codecheck): manual evaluation harness for spike #171 (#171)

Reads submissions.jsonl, calls live dispatchCheckCode, writes a
CSV the author rates by hand. Output dir gitignored. The spike's
Phase 4 decision will use these CSVs as evidence."
```

End of Phase 3:

- All three test workspaces green for code-check.
- Eval harness exists; pilot authors can run it.
- Per-pilot CSVs collected (these don't go in the repo — they're shared with the team for the Phase 4 write-up).

---

## Phase 4 — Decision write-up

End state: a comment posted on issue #171 with quantitative evidence; the spike is closed (graduated, iterated, or shelved); the codebase ends up in one of three known states by design.

### Task 4.1 — Aggregate the evidence

**Files:**
- Create: `docs/superpowers/specs/2026-06-02-ai-code-check-spike-evaluation.md` (the write-up)

- [ ] **Step 1: Pull telemetry from HANA**

From `cds bind --exec -- npm run repl` or the Analytics Explorer, run:

```sql
SELECT verdict, COUNT(*) AS n, AVG(latencyMs) AS avg_ms,
       AVG(promptTokens) AS avg_prompt, AVG(completionTokens) AS avg_completion
FROM "COM_SAP_DEVELOPERS_IMS_CODECHECKSUBMISSIONS"
GROUP BY verdict;
```

```sql
SELECT errorReason, COUNT(*) AS n
FROM "COM_SAP_DEVELOPERS_IMS_CODECHECKSUBMISSIONS"
WHERE verdict = 'error'
GROUP BY errorReason;
```

```sql
-- p95 latency on successful checks
SELECT PERCENTILE_DISC(0.95) WITHIN GROUP (ORDER BY latencyMs) AS p95_ms
FROM "COM_SAP_DEVELOPERS_IMS_CODECHECKSUBMISSIONS"
WHERE verdict IN ('pass','partial','fail');
```

- [ ] **Step 2: Compute author-rated agreement**

For each pilot tutorial's CSV (verdicts/*.csv), compute:

- **Pass-vs-fail boundary agreement:** rows where both expected ∈ {pass, fail} and actual ∈ {pass, fail}. Count where they match.
- **Partial sensitivity:** rows where expected = partial. What did the grader call them?
- **Top 3 disagreement categories:** open the disagreement rows and group them by what went wrong.

- [ ] **Step 3: Write the evaluation doc**

Create `docs/superpowers/specs/2026-06-02-ai-code-check-spike-evaluation.md`:

```markdown
# AI Code-Check Spike — Evaluation

**Tracking:** issue #171
**Spec:** [2026-06-02-ai-code-check-spike-design.md](./2026-06-02-ai-code-check-spike-design.md)
**Plan:** [2026-06-02-ai-code-check-spike.md](../plans/2026-06-02-ai-code-check-spike.md)

## Evidence

### Verdict distribution (from CodeCheckSubmissions)

| verdict  | count | avg latency (ms) | avg prompt tokens | avg completion tokens |
|----------|-------|------------------|-------------------|-----------------------|
| pass     |       |                  |                   |                       |
| partial  |       |                  |                   |                       |
| fail     |       |                  |                   |                       |
| error    |       |                  |                   |                       |

### Cost & reliability

- p95 latency on successful checks: ___ ms
- Error rate (verdict=error / total): ___ %
- Error reasons: ___ × upstream / ___ × spec_missing / ___ × schema / ___ × disabled
- Estimated cost per check (avg input × $/M-input + avg output × $/M-output): $___

### Author-rated agreement

| pilot tutorial | step | n | pass-vs-fail agree % | top disagreement category |
|----------------|------|---|----------------------|---------------------------|
| (pilot 1)      |      |   |                      |                           |
| (pilot 2)      |      |   |                      |                           |
| (pilot 3-5)    |      |   |                      |                           |

**Aggregate pass-vs-fail agreement:** ___ %

### Top 3 disagreement categories

1. (e.g. "Grader marked pass when learner missed a required cds.ql clause" — n=__)
2.
3.

## Decision

[ ] **Graduate.** Pass-vs-fail agreement ≥ 80 %. Top disagreement categories will be addressed in the first-class spec.
[ ] **Iterate (Approach C).** Pass-vs-fail agreement 60-79 %. Worth a second iteration with RAG-then-grade to give the model more context.
[ ] **Shelve.** Pass-vs-fail agreement < 60 %. Retain the entities and the flag in main; close the spike.

### Rationale

(One paragraph explaining the call.)

### Follow-up issues

- [ ] (one per top disagreement category, if graduating)
- [ ] (issue #171 capabilities #1 and #2 — separate specs)
```

- [ ] **Step 4: Commit**

```bash
git add docs/superpowers/specs/2026-06-02-ai-code-check-spike-evaluation.md
git commit -m "docs(codecheck): spike evaluation write-up (#171)

Pulls verdict distribution, cost, p95 latency, and author-rated
agreement into a single document. The 'Decision' section is the
spike's terminal state."
```

---

### Task 4.2 — Comment on issue #171

- [ ] **Step 1: Comment summary**

Compose a comment that answers the issue's three sub-questions, focused on capability #3 (code-check):

- What we built and shipped (link to the eval doc).
- Aggregate agreement %, p95 latency, $ per check, error rate.
- The decision and rationale.
- Pointers to the follow-up specs for capabilities #1 and #2 (whether or not we proceed with #3).

```bash
gh issue comment 171 --repo sap-tutorials/tutorials-ims --body-file evaluation-summary.md
```

End of Phase 4. The spike has done its job.

---

## Cross-cutting concerns (read before starting)

### Security

- **Never log `submittedCode`** at info level; only persist to HANA where it is `@PersonalData.IsPotentiallyPersonal`. Cloud Logging structured records use `{ slug, step, user_hash, verdict, latency_ms, tokens, model }` only.
- **Reference solutions in `.tutorial-cache/<slug>.codecheck.json`** are local-only (tutorial cache is gitignored). The publish CLI ships them to HANA over TLS via `CONTENT_API_KEY`. They never reach the client. The smoke test in Task 3.2 enforces this.
- **Prompt injection in submitted code** is a documented known weakness; the schema-enforced verdict enum is the primary defense. Don't pretend to fix it in the spike.
- **Secret detection** in submitted code: implement only if Phase 4 graduates. For the spike, document it in the eval doc and move on.

### CAP 10 readiness (June 2026)

The plan adds entities and an Express route — both are CAP-10 safe. The `@PersonalData` annotations follow the existing audit-logging pattern. No use of removed flags (`compat_srv_getters`, `legacyLocking`, etc.).

### Windows quoting / line-ending traps

- Windows CRLF on multi-section edits has bitten this project before ([feedback-crlf-regression-on-windows.md](feedback-crlf-regression-on-windows.md)). After multi-edit work, run `file <path>` on changed files; normalize via Node if needed.
- The publish-content CLI runs on both Windows and Linux CI. The directory walk in `collectCodeCheckSpecs` uses `path.join` — don't hand-concatenate slashes.

### Hugo gotchas

- Hugo content under `hugo/content/tutorials/` is generated. Editing tutorial markdown files there is wrong; edit the parsers or the source repo.
- After Vite rebuilds the islands, re-run Hugo so `hugo/public` refreshes before `mbt copy` ([feedback-vite-chunks-need-base.md](feedback-vite-chunks-need-base.md)).

### srv-qa cp list audit

When the implementer adds a new file under `srv/lib/`, they MUST re-walk transitive `./` imports from `srv/lib/content-store.js` and confirm every dependency is in `.deploy/mta.yaml`'s `srv-qa` `cp` list ([feedback-srv-qa-cp-list-recurring.md](feedback-srv-qa-cp-list-recurring.md)). Skipping this crashes QA boot. The new files this plan adds:

- `srv/lib/code-check-tool.js`
- `srv/lib/code-check-prompt.js`
- `srv/lib/code-check-handler.js`
- `srv/lib/code-check-llm.js`
- `srv/lib/code-check-step-loader.js`
- `srv/lib/code-check-spec-publish.js`

All six need an entry in `srv-qa` `cp` list (or be excluded by glob — read the existing list and decide).

### Branch hygiene

- Always run `git branch --show-current` in the same Bash invocation as `git commit` and abort if it shows `main` ([feedback-verify-branch-before-commit.md](feedback-verify-branch-before-commit.md)). Implementer should adopt this in their commit script.
- Default to `gh pr create` ([feedback-pr-over-direct-merge.md](feedback-pr-over-direct-merge.md)). Open the draft PR after Phase 1 commits land.

### CLAUDE.md update

After Phase 1 lands and the flag is enabled in DEV, append to the Gotchas section in [CLAUDE.md](../../../CLAUDE.md):

> - **AI code-check (issue #171, behind `ChatSettings.codeCheckEnabled`)** — author opt-in via `[CODECHECK_N]` blocks in rules.vr; trimmed spec ships in Hugo frontmatter, full spec (with reference solution) lives only in the `CodeCheckSpecs` HANA entity. Inline UI hits `/api/codecheck` (XSUAA, per-user 30/hr, per-step 5/5min); the same logic is also reachable as a `checkCode` Joule chat tool when the flag is on. Persistence in `CodeCheckSubmissions`. Spike doc: [docs/superpowers/specs/2026-06-02-ai-code-check-spike-design.md](docs/superpowers/specs/2026-06-02-ai-code-check-spike-design.md).

Add this in its own commit at the end of Phase 1.

---

## Final pre-flight checklist (before declaring spike complete)

- [ ] All 9 unit-test files green (`npm test -- --run`).
- [ ] Hybrid suite green (`ALLOW_HYBRID_WRITES=true npm run test:hybrid`).
- [ ] Smoke suite green against deployed DEV.
- [ ] `cf logs tutorials-srv` shows the structured `code_check` log lines for at least one real submission.
- [ ] Anti-leak smoke test confirms no `referenceSolution` ever reaches HTML.
- [ ] Eval CSVs collected for every pilot tutorial.
- [ ] Evaluation doc written and committed.
- [ ] Decision recorded in the eval doc.
- [ ] Comment posted on issue #171.
- [ ] CLAUDE.md gotcha added.
- [ ] PR merged (or, if shelved, branch closed without merge).
