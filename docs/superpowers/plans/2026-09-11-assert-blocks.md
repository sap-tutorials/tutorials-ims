# Assert Blocks → Verifiable Tutorials Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Parse author-supplied `[ASSERT_N]` postconditions from `rules.vr`, emit them into Hugo step frontmatter + a `<slug>.assert.json` sidecar, and persist them to HANA `AssertSpecs` via the existing content-publish endpoint pattern.

**Architecture:** A faithful mirror of the CodeCheck pipeline: a new `scripts/parsers/assert.ts` parser (reads `rules.vr`, keyed by step number) → `TutorialStep.asserts` field → frontmatter whitelist + `.tutorial-cache/<slug>.assert.json` sidecar → `POST /content/assert-specs` carry-forward upsert handler → `AssertSpecs` entity. Parsing is inert (no runtime consumer, no feature flag) until #3/#4 ship.

**Tech Stack:** TypeScript (parsers, fetch/publish scripts), Node.js ESM (`srv/lib`, `scripts/lib`), CAP CDS (`db/schema.cds`), Vitest + in-memory SQLite (tests).

**Spec:** `docs/superpowers/specs/2026-09-11-assert-blocks-design.md`

## Global Constraints

- **Scope: parse + persist only.** No assertion runner, no CI execution, no `verify.sh`/SKILL.md emission, no UI surface, no feature flag.
- **Tolerant parsing:** a malformed `[ASSERT_N]` block is dropped with `console.warn` — never throw. A parse failure must never abort a tutorial build or content publish.
- **Assert blocks live in `rules.vr`,** the same companion file as `[VALIDATE_N]`/`[CODECHECK_N]` — never in the step markdown body. `scripts/parsers/v2.ts` is untouched.
- **`N` in `[ASSERT_N]` = the step number** (matching `[CODECHECK_N]`). Multiple asserts on one step = repeat `[ASSERT_N]` with the same `N`; `assertIndex` is 0-based order of appearance within that step.
- **Tutorial slugs are lowercase canonical** — always `.toLowerCase()` before writing sidecar slugs and before resolving `Tutorials` in the handler.
- **Carry-forward semantics:** the publish handler never DELETEs; specs absent from a payload are retained.
- **CDS entity namespace:** `com.sap.developers.ims`. `AssertSpecs` is `: managed`, inline in `db/schema.cds`, NOT journaled (absent from `db/persistence.cds`) — mirrors `CodeCheckSpecs`.
- **srv/lib change → srv-qa cp-list audit:** any new `srv/lib/*.js` reachable from `srv/server.js` must be in `.deploy/mta.yaml`'s `srv-qa` `cp` list.
- **Tests run offline** under `npm test` (in-memory SQLite). No HANA, no deploy required to prove this slice.

---

### Task 1: Parser — types + `scripts/parsers/assert.ts`

**Files:**
- Modify: `scripts/parsers/types.ts` (add `AssertType`, `AssertBlock`; add `asserts?` to `TutorialStep`)
- Create: `scripts/parsers/assert.ts`
- Test: `test/unit/assert-parser.test.js`

**Interfaces:**
- Consumes: nothing (leaf).
- Produces:
  - `export type AssertType = 'cmd' | 'http' | 'file'`
  - `export interface AssertBlock { index: number; stepNumber: number; type: AssertType; run?: string; expectExit?: number; method?: string; path?: string; expectStatus?: number; filePath?: string; expectContains?: boolean; match?: string }`
  - `export function parseAssertBlocks(content: string): Map<number, AssertBlock[]>`
  - `export function attachAssertSpecs<T extends { number: number; asserts?: AssertBlock[] }>(steps: T[], specs: Map<number, AssertBlock[]>): AssertBlock[]`

- [ ] **Step 1: Write the failing test**

Create `test/unit/assert-parser.test.js`:

```js
// test/unit/assert-parser.test.js
import { describe, it, expect, vi } from 'vitest';
import { parseAssertBlocks, attachAssertSpecs } from '../../scripts/parsers/assert.ts';

const RULES = `
[ASSERT_1]
###Type
cmd
###Run
cds compile srv
###Expect
exit 0
###Match
Deployed
[ASSERT_1]
###Type
http
###Method
get
###Path
/catalog/Books
###Expect
status 200
[ASSERT_2]
###Type
file
###Path
srv/cat-service.cds
###Expect
contains
###Match
service CatalogService
`;

describe('parseAssertBlocks', () => {
  it('parses all three types; multi-assert step keyed by ascending assertIndex', () => {
    const map = parseAssertBlocks(RULES);
    expect([...map.keys()].sort()).toEqual([1, 2]);

    const step1 = map.get(1);
    expect(step1).toHaveLength(2);
    expect(step1[0]).toMatchObject({ index: 0, stepNumber: 1, type: 'cmd', run: 'cds compile srv', expectExit: 0, match: 'Deployed' });
    expect(step1[1]).toMatchObject({ index: 1, stepNumber: 1, type: 'http', method: 'GET', path: '/catalog/Books', expectStatus: 200 });

    const step2 = map.get(2);
    expect(step2).toHaveLength(1);
    expect(step2[0]).toMatchObject({ index: 0, stepNumber: 2, type: 'file', filePath: 'srv/cat-service.cds', expectContains: true, match: 'service CatalogService' });
  });

  it('file exists → expectContains:false, no match required', () => {
    const map = parseAssertBlocks(`[ASSERT_3]\n###Type\nfile\n###Path\na/b.cds\n###Expect\nexists\n`);
    expect(map.get(3)[0]).toMatchObject({ type: 'file', filePath: 'a/b.cds', expectContains: false });
    expect(map.get(3)[0].match).toBeUndefined();
  });

  it('warn-and-skip: unknown type, missing Run, missing Match on contains, stray marker', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(parseAssertBlocks(`[ASSERT_1]\n###Type\nquantum\n`).size).toBe(0);
    expect(parseAssertBlocks(`[ASSERT_1]\n###Type\ncmd\n###Expect\nexit 0\n`).size).toBe(0); // no Run
    expect(parseAssertBlocks(`[ASSERT_1]\n###Type\nfile\n###Path\na\n###Expect\ncontains\n`).size).toBe(0); // no Match
    expect(parseAssertBlocks(`[ASSERT_1]\n`).size).toBe(0); // stray marker, no subsections
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe('attachAssertSpecs', () => {
  it('sets step.asserts on matching steps and returns the flat sidecar array', () => {
    const map = parseAssertBlocks(RULES);
    const steps = [{ number: 1, title: 'One' }, { number: 2, title: 'Two' }, { number: 3, title: 'Three' }];
    const sidecar = attachAssertSpecs(steps, map);
    expect(steps[0].asserts).toHaveLength(2);
    expect(steps[1].asserts).toHaveLength(1);
    expect(steps[2].asserts).toBeUndefined();
    expect(sidecar).toHaveLength(3); // 2 + 1 flattened
  });

  it('skips specs whose step number has no matching step', () => {
    const map = parseAssertBlocks(`[ASSERT_9]\n###Type\nfile\n###Path\nx\n###Expect\nexists\n`);
    const steps = [{ number: 1, title: 'One' }];
    expect(attachAssertSpecs(steps, map)).toHaveLength(0);
    expect(steps[0].asserts).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/assert-parser.test.js`
Expected: FAIL — cannot resolve `../../scripts/parsers/assert.ts` (module not written yet).

- [ ] **Step 3: Add types to `scripts/parsers/types.ts`**

Append the two exports and extend `TutorialStep`:

```ts
export type AssertType = 'cmd' | 'http' | 'file';

export interface AssertBlock {
  index: number;        // assertIndex within the step, 0-based (order of appearance)
  stepNumber: number;   // N from [ASSERT_N]
  type: AssertType;
  run?: string;         // cmd
  expectExit?: number;  // cmd
  method?: string;      // http, upper-cased
  path?: string;        // http
  expectStatus?: number;// http
  filePath?: string;    // file
  expectContains?: boolean; // file: false ⇒ "exists"; true ⇒ "contains"
  match?: string;       // shared, optional regex source (required for file+contains)
}
```

In the existing `TutorialStep` interface add:

```ts
  asserts?: AssertBlock[];
```

- [ ] **Step 4: Write `scripts/parsers/assert.ts`**

```ts
import type { AssertBlock, AssertType } from './types.js'

const ASSERT_MARKER = /^\[ASSERT_(\d+)\]\s*$/
// A sibling per-step marker closes an open ASSERT block (same flush pattern as codecheck.ts).
const ANY_MARKER = /^\[(VALIDATE|CODECHECK|ASSERT)_\d+\]\s*$/

const VALID_TYPES = new Set<AssertType>(['cmd', 'http', 'file'])
const HTTP_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'])

// N in [ASSERT_N] is the step number; a step may have multiple blocks.
export function parseAssertBlocks(content: string): Map<number, AssertBlock[]> {
  const result = new Map<number, AssertBlock[]>()
  const lines = content.split('\n')
  let currentNum: number | null = null
  let blockLines: string[] = []

  const flush = () => {
    if (currentNum === null) return
    const arr = result.get(currentNum) ?? []
    const block = parseBlock(blockLines, currentNum, arr.length)
    if (block) { arr.push(block); result.set(currentNum, arr) }
    currentNum = null
    blockLines = []
  }

  for (const line of lines) {
    const m = line.match(ASSERT_MARKER)
    if (m) { flush(); currentNum = parseInt(m[1], 10); continue }
    if (ANY_MARKER.test(line)) { flush(); continue }   // sibling block — close ours
    if (currentNum !== null) blockLines.push(line)
  }
  flush()
  return result
}

function parseBlock(lines: string[], stepNumber: number, index: number): AssertBlock | null {
  const raw = lines.join('\n')
  const type = section(raw, 'Type').toLowerCase()
  if (!VALID_TYPES.has(type as AssertType)) {
    if (type) console.warn(`[assert] step ${stepNumber} assert ${index}: unknown ###Type "${type}" — skipped`)
    return null
  }
  const matchRaw = section(raw, 'Match')
  const match = matchRaw || undefined

  if (type === 'cmd') {
    const run = section(raw, 'Run')
    const expectExit = parseExpect(section(raw, 'Expect'), 'exit')
    if (!run || expectExit === null) {
      console.warn(`[assert] step ${stepNumber} assert ${index}: cmd needs ###Run and "###Expect exit <int>" — skipped`)
      return null
    }
    return { index, stepNumber, type, run, expectExit, match }
  }

  if (type === 'http') {
    const method = section(raw, 'Method').toUpperCase()
    const path = section(raw, 'Path')
    const expectStatus = parseExpect(section(raw, 'Expect'), 'status')
    if (!HTTP_METHODS.has(method) || !path || expectStatus === null) {
      console.warn(`[assert] step ${stepNumber} assert ${index}: http needs valid ###Method, ###Path and "###Expect status <int>" — skipped`)
      return null
    }
    return { index, stepNumber, type, method, path, expectStatus, match }
  }

  // file
  const filePath = section(raw, 'Path')
  const expect = section(raw, 'Expect').toLowerCase()
  if (!filePath || (expect !== 'exists' && expect !== 'contains')) {
    console.warn(`[assert] step ${stepNumber} assert ${index}: file needs ###Path and "###Expect exists|contains" — skipped`)
    return null
  }
  const expectContains = expect === 'contains'
  if (expectContains && !match) {
    console.warn(`[assert] step ${stepNumber} assert ${index}: file+contains requires ###Match — skipped`)
    return null
  }
  return { index, stepNumber, type, filePath, expectContains, match }
}

// "exit 0" / "status 200" → 0 / 200; wrong keyword or non-int → null.
function parseExpect(raw: string, keyword: 'exit' | 'status'): number | null {
  const m = raw.trim().match(new RegExp(`^${keyword}\\s+(-?\\d+)$`))
  return m ? parseInt(m[1], 10) : null
}

function section(raw: string, name: string): string {
  // Match from ###Name through to the next ### heading or end-of-string.
  const re = new RegExp(`###${name}[^\\n]*\\n([\\s\\S]*?)(?=\\n###|$)`)
  const m = raw.match(re)
  return m ? m[1].trim() : ''
}

interface StepLike { number: number; asserts?: AssertBlock[] }

// Attaches asserts[] to matching steps in place; returns the flat sidecar
// array (all blocks across all steps) for <slug>.assert.json.
export function attachAssertSpecs<T extends StepLike>(
  steps: T[], specs: Map<number, AssertBlock[]>
): AssertBlock[] {
  const sidecar: AssertBlock[] = []
  for (const [stepNumber, blocks] of specs) {
    const target = steps.find(s => s.number === stepNumber)
    if (!target) continue
    target.asserts = blocks
    sidecar.push(...blocks)
  }
  return sidecar
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run test/unit/assert-parser.test.js`
Expected: PASS (all cases).

- [ ] **Step 6: Commit**

```bash
git add scripts/parsers/types.ts scripts/parsers/assert.ts test/unit/assert-parser.test.js
git commit -m "feat(2245): assert.ts parser + AssertBlock types (parse rules.vr [ASSERT_N])"
```

---

### Task 2: Frontmatter emit + compose preview parity

**Files:**
- Modify: `scripts/parsers/render-frontmatter.ts` (per-step whitelist, ~L128-139)
- Modify: `scripts/parsers/compose.ts` (preview `opts.rulesVr` block, ~L222-228)
- Test: `test/unit/assert-frontmatter.test.js`

**Interfaces:**
- Consumes: `TutorialStep.asserts` (Task 1); `parseAssertBlocks`, `attachAssertSpecs` (Task 1).
- Produces: `steps[].asserts` present in rendered Hugo frontmatter when authored.

- [ ] **Step 1: Write the failing test**

Create `test/unit/assert-frontmatter.test.js`:

```js
// test/unit/assert-frontmatter.test.js
import { describe, it, expect } from 'vitest';
import { renderHugoFrontmatter } from '../../scripts/parsers/render-frontmatter.ts';

function baseArgs(steps) {
  return {
    slug: 'demo', title: 'Demo', description: 'd', time: 5, level: 'Beginner',
    tags: [], primaryTag: '', author: '', authorProfile: '', youWillLearn: [],
    prerequisites: '', steps, nav: { prev: null, next: null }, lastUpdated: '',
    createdAt: '', contributors: [],
  };
}

describe('renderHugoFrontmatter asserts emit', () => {
  it('emits steps[].asserts when a step carries asserts', () => {
    const steps = [{
      number: 1, title: 'One', content: 'body',
      asserts: [{ index: 0, stepNumber: 1, type: 'cmd', run: 'cds compile', expectExit: 0 }],
    }];
    const out = renderHugoFrontmatter(baseArgs(steps));
    expect(out).toContain('asserts:');
    expect(out).toContain('cds compile');
  });

  it('omits asserts when none authored', () => {
    const steps = [{ number: 1, title: 'One', content: 'body' }];
    const out = renderHugoFrontmatter(baseArgs(steps));
    expect(out).not.toContain('asserts:');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/assert-frontmatter.test.js`
Expected: FAIL — first test: `asserts:` not found (whitelist doesn't emit it yet).

- [ ] **Step 3: Add `asserts` to the frontmatter whitelist**

In `scripts/parsers/render-frontmatter.ts`, inside the `steps.map(s => { ... })` per-step block (immediately after the `if (s.codeCheck) entry.codeCheck = s.codeCheck` line):

```ts
      if (s.asserts?.length) entry.asserts = s.asserts
```

- [ ] **Step 4: Add compose.ts preview parity**

In `scripts/parsers/compose.ts`, import (extend the existing codecheck import or add beside it):

```ts
import { parseAssertBlocks, attachAssertSpecs } from './assert.js'
```

In the `opts.rulesVr` preview block (~L222, beside the existing `parseCodeCheckBlocks(opts.rulesVr)` call):

```ts
    const assertMap = parseAssertBlocks(opts.rulesVr)
    if (assertMap.size) attachAssertSpecs(steps, assertMap)
```

(No sidecar write in preview — preview has no cache, matching codecheck.)

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run test/unit/assert-frontmatter.test.js`
Expected: PASS.

- [ ] **Step 6: Type-check the touched TS**

Run: `npx tsc --noEmit`
Expected: no new errors from `render-frontmatter.ts` / `compose.ts`.

- [ ] **Step 7: Commit**

```bash
git add scripts/parsers/render-frontmatter.ts scripts/parsers/compose.ts test/unit/assert-frontmatter.test.js
git commit -m "feat(2245): emit steps[].asserts in frontmatter + compose preview parity"
```

---

### Task 3: `fetch-tutorials.ts` sidecar wiring

**Files:**
- Modify: `scripts/fetch-tutorials.ts` (beside the codecheck block, ~L1100-1112)

**Interfaces:**
- Consumes: `parseAssertBlocks`, `attachAssertSpecs` (Task 1); `rulesContent`, `steps`, `t.slug`, `CACHE_DIR`, `writeFileSync`, `join` (all already in scope at the codecheck block).
- Produces: `.tutorial-cache/<slug>.assert.json` of shape `{ slug: <lowercase>, specs: AssertBlock[] }`; sets `step.asserts` so frontmatter emit (Task 2) picks it up.

This is a verbatim mirror of the tested codecheck block; its verification is `tsc` + the Task 4 collect test round-tripping the sidecar shape.

- [ ] **Step 1: Add the import**

Beside the existing codecheck import in `scripts/fetch-tutorials.ts`:

```ts
import { parseAssertBlocks, attachAssertSpecs } from './parsers/assert.js'
```

- [ ] **Step 2: Add the sidecar block**

Immediately after the codecheck block closes (after `fetch-tutorials.ts:1112`, still inside the same `if (rulesContent)` scope that guards codecheck):

```ts
        const assertMap = parseAssertBlocks(rulesContent)
        if (assertMap.size) {
          const assertSidecar = attachAssertSpecs(steps, assertMap)
          if (assertSidecar.length) {
            const assertPath = join(CACHE_DIR, `${t.slug.toLowerCase()}.assert.json`)
            // slug lowercased: Tutorials.slug in HANA is lowercase canonical, and
            // the publish handler resolves against the lowercase row.
            writeFileSync(assertPath, JSON.stringify({ slug: t.slug.toLowerCase(), specs: assertSidecar }, null, 2))
          }
        }
```

- [ ] **Step 3: Type-check**

Run: `npx tsc --noEmit`
Expected: no new errors.

- [ ] **Step 4: Commit**

```bash
git add scripts/fetch-tutorials.ts
git commit -m "feat(2245): write <slug>.assert.json sidecar in fetch-tutorials"
```

---

### Task 4: `scripts/lib/publish-asserts.js` — collect + publish

**Files:**
- Create: `scripts/lib/publish-asserts.js`
- Test: `test/unit/assert-publish-cli.test.js`

**Interfaces:**
- Consumes: `.tutorial-cache/<slug>.assert.json` sidecars (Task 3).
- Produces:
  - `export function collectAssertSpecs(cacheDir): Array<{ slug, index, stepNumber, type, ... }>`
  - `export async function publishAssertSpecs(baseUrl, apiKey, specs): Promise<{ upserted, skipped }>` — POSTs to `/content/assert-specs`.

- [ ] **Step 1: Write the failing test**

Create `test/unit/assert-publish-cli.test.js`:

```js
// test/unit/assert-publish-cli.test.js
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { collectAssertSpecs } from '../../scripts/lib/publish-asserts.js';

let dir;
beforeEach(() => { dir = mkdtempSync(path.join(tmpdir(), 'assert-cli-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe('collectAssertSpecs', () => {
  it('flattens specs from every *.assert.json and stamps slug onto each', () => {
    writeFileSync(path.join(dir, 'alpha.assert.json'), JSON.stringify({
      slug: 'alpha',
      specs: [
        { index: 0, stepNumber: 1, type: 'cmd', run: 'x', expectExit: 0 },
        { index: 1, stepNumber: 1, type: 'file', filePath: 'a', expectContains: false },
      ],
    }));
    writeFileSync(path.join(dir, 'beta.assert.json'), JSON.stringify({
      slug: 'beta', specs: [{ index: 0, stepNumber: 2, type: 'http', method: 'GET', path: '/x', expectStatus: 200 }],
    }));
    const out = collectAssertSpecs(dir);
    expect(out).toHaveLength(3);
    expect(out.every(s => typeof s.slug === 'string')).toBe(true);
    expect(out.filter(s => s.slug === 'alpha')).toHaveLength(2);
  });

  it('skips malformed sidecars and non-matching files; returns [] on missing dir', () => {
    writeFileSync(path.join(dir, 'bad.assert.json'), '{not json');
    writeFileSync(path.join(dir, 'nospecs.assert.json'), JSON.stringify({ slug: 'x' }));
    writeFileSync(path.join(dir, 'ignore.txt'), 'nope');
    expect(collectAssertSpecs(dir)).toHaveLength(0);
    expect(collectAssertSpecs(path.join(dir, 'does-not-exist'))).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/assert-publish-cli.test.js`
Expected: FAIL — cannot resolve `scripts/lib/publish-asserts.js`.

- [ ] **Step 3: Write `scripts/lib/publish-asserts.js`**

```js
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const SUFFIX = '.assert.json';

/**
 * Reads every .assert.json sidecar in cacheDir and returns a flat array of
 * { slug, index, stepNumber, type, ...typeSpecificFields }.
 *
 * Defensive: missing dir, malformed JSON, or missing required fields are all
 * silently skipped — a parse failure must never abort the content publish.
 */
export function collectAssertSpecs(cacheDir) {
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

/**
 * POST the consolidated specs to /content/assert-specs.
 * Returns the server's response shape: { upserted, skipped }.
 */
export async function publishAssertSpecs(baseUrl, apiKey, specs) {
  if (!specs.length) return { upserted: 0, skipped: [] };
  const res = await fetch(`${baseUrl}/content/assert-specs`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify({ specs })
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`assert-spec publish failed (${res.status}): ${txt}`);
  }
  return await res.json();
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/unit/assert-publish-cli.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/publish-asserts.js test/unit/assert-publish-cli.test.js
git commit -m "feat(2245): publish-asserts.js collect + POST /content/assert-specs"
```

---

### Task 5: `AssertSpecs` entity + publish handler + route mount

**Files:**
- Modify: `db/schema.cds` (add `AssertSpecs` inline after `CodeCheckSpecs`, ~L870)
- Create: `srv/lib/assert-spec-publish.js`
- Modify: `srv/server.js` (import handler + mount route beside L942)
- Test: `test/unit/assert-spec-publish.test.js`

**Interfaces:**
- Consumes: publish payload `{ specs: Array<{ slug, index, stepNumber, type, run?, expectExit?, method?, path?, expectStatus?, filePath?, expectContains?, match? }> }` (Task 4's `collectAssertSpecs` output).
- Produces:
  - `AssertSpecs` entity keyed `(tutorial, stepNumber, assertIndex)`.
  - `export async function assertSpecPublishHandler(req, res)` — 400 on invalid body/spec; upserts on `(tutorial_ID, stepNumber, assertIndex)`; carry-forward (no DELETE); returns `{ upserted, skipped }`.
  - `POST /content/assert-specs` route.

- [ ] **Step 1: Write the failing test**

Create `test/unit/assert-spec-publish.test.js`:

```js
// test/unit/assert-spec-publish.test.js
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import path from 'node:path';
import cds from '@sap/cds';
import { assertSpecPublishHandler } from '../../srv/lib/assert-spec-publish.js';

beforeAll(async () => {
  await cds.deploy(path.join(process.cwd(), 'db', 'schema.cds')).to('sqlite::memory:');
});

async function seedTutorials() {
  const { AssertSpecs, Tutorials } = cds.entities('com.sap.developers.ims');
  await DELETE.from(AssertSpecs);
  await DELETE.from(Tutorials);
  await INSERT.into(Tutorials).entries([
    { ID: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', slug: 'tutorial-alpha', title: 'Alpha', status: 'ACTIVE' },
    { ID: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', slug: 'tutorial-beta',  title: 'Beta',  status: 'ACTIVE' },
  ]);
}
beforeEach(seedTutorials);

const mockReq = (body) => ({ body });
const mockRes = () => ({
  statusCode: 200, jsonBody: null,
  status(c) { this.statusCode = c; return this; },
  json(b)   { this.jsonBody = b; return this; },
});

const cmd  = (over = {}) => ({ slug: 'tutorial-alpha', index: 0, stepNumber: 1, type: 'cmd', run: 'x', expectExit: 0, ...over });
const http = (over = {}) => ({ slug: 'tutorial-alpha', index: 0, stepNumber: 2, type: 'http', method: 'GET', path: '/x', expectStatus: 200, ...over });
const file = (over = {}) => ({ slug: 'tutorial-alpha', index: 0, stepNumber: 3, type: 'file', filePath: 'a.cds', expectContains: false, ...over });

describe('happy path + column mapping', () => {
  it('cmd/http/file each upsert with mapped columns', async () => {
    const res = mockRes();
    await assertSpecPublishHandler(mockReq({ specs: [cmd(), http(), file({ expectContains: true, match: 'svc' })] }), res);
    expect(res.statusCode).toBe(200);
    expect(res.jsonBody).toEqual({ upserted: 3, skipped: [] });

    const { AssertSpecs } = cds.entities('com.sap.developers.ims');
    const rows = await SELECT.from(AssertSpecs);
    expect(rows).toHaveLength(3);
    const httpRow = rows.find(r => r.assertType === 'http');
    expect(httpRow.httpMethod).toBe('GET');
    expect(httpRow.httpPath).toBe('/x');
    expect(httpRow.expectStatus).toBe(200);
    const fileRow = rows.find(r => r.assertType === 'file');
    expect(fileRow.matchRegex).toBe('svc');
    expect(fileRow.expectContains).toBe(true);
  });
});

describe('multi-assert per step keyed on assertIndex', () => {
  it('two asserts on same step both persist', async () => {
    const res = mockRes();
    await assertSpecPublishHandler(mockReq({ specs: [
      cmd({ index: 0, stepNumber: 1 }),
      cmd({ index: 1, stepNumber: 1, run: 'y' }),
    ] }), res);
    expect(res.jsonBody.upserted).toBe(2);
    const { AssertSpecs } = cds.entities('com.sap.developers.ims');
    expect(await SELECT.from(AssertSpecs)).toHaveLength(2);
  });
});

describe('idempotent + carry-forward', () => {
  it('same payload twice → row count unchanged', async () => {
    const specs = [cmd()];
    await assertSpecPublishHandler(mockReq({ specs }), mockRes());
    await assertSpecPublishHandler(mockReq({ specs }), mockRes());
    const { AssertSpecs } = cds.entities('com.sap.developers.ims');
    expect(await SELECT.from(AssertSpecs)).toHaveLength(1);
  });

  it('row absent from second payload is retained', async () => {
    await assertSpecPublishHandler(mockReq({ specs: [cmd()] }), mockRes());
    await assertSpecPublishHandler(mockReq({ specs: [http()] }), mockRes());
    const { AssertSpecs } = cds.entities('com.sap.developers.ims');
    expect(await SELECT.from(AssertSpecs)).toHaveLength(2);
  });
});

describe('slug not found', () => {
  it('unknown slug skipped; known upserted', async () => {
    const res = mockRes();
    await assertSpecPublishHandler(mockReq({ specs: [cmd(), cmd({ slug: 'nope', stepNumber: 9 })] }), res);
    expect(res.jsonBody).toEqual({ upserted: 1, skipped: ['nope'] });
  });
});

describe('validation (fail-fast)', () => {
  it('null body → 400 invalid_body', async () => {
    const res = mockRes();
    await assertSpecPublishHandler(mockReq(null), res);
    expect(res.jsonBody).toEqual({ error: 'invalid_body' });
  });
  it('specs not array → 400 invalid_body', async () => {
    const res = mockRes();
    await assertSpecPublishHandler(mockReq({ specs: 'x' }), res);
    expect(res.jsonBody).toEqual({ error: 'invalid_body' });
  });
  it('missing slug → 400 invalid_spec', async () => {
    const res = mockRes();
    await assertSpecPublishHandler(mockReq({ specs: [cmd({ slug: undefined })] }), res);
    expect(res.jsonBody).toEqual({ error: 'invalid_spec' });
  });
  it('stepNumber as string → 400 invalid_spec', async () => {
    const res = mockRes();
    await assertSpecPublishHandler(mockReq({ specs: [cmd({ stepNumber: '1' })] }), res);
    expect(res.jsonBody).toEqual({ error: 'invalid_spec' });
  });
  it('index not a number → 400 invalid_spec', async () => {
    const res = mockRes();
    await assertSpecPublishHandler(mockReq({ specs: [cmd({ index: undefined })] }), res);
    expect(res.jsonBody).toEqual({ error: 'invalid_spec' });
  });
  it('unknown type → 400 invalid_spec', async () => {
    const res = mockRes();
    await assertSpecPublishHandler(mockReq({ specs: [cmd({ type: 'quantum' })] }), res);
    expect(res.jsonBody).toEqual({ error: 'invalid_spec' });
  });
  it('fail-fast: bad spec at position 1 prevents write of position 0', async () => {
    const res = mockRes();
    await assertSpecPublishHandler(mockReq({ specs: [cmd(), cmd({ type: 'bogus' })] }), res);
    expect(res.jsonBody).toEqual({ error: 'invalid_spec' });
    const { AssertSpecs } = cds.entities('com.sap.developers.ims');
    expect(await SELECT.from(AssertSpecs)).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/assert-spec-publish.test.js`
Expected: FAIL — cannot resolve `srv/lib/assert-spec-publish.js` (and `AssertSpecs` entity missing).

- [ ] **Step 3: Add the `AssertSpecs` entity to `db/schema.cds`**

Immediately after the `CodeCheckSpecs` entity (~L870):

```cds
// Author-supplied, machine-checkable step postconditions (issue #2245 item #2).
// Populated by the publish-content pipeline (carry-forward upsert); consumed
// by #3 (skill bundles) / #4 (self-healing). No secret columns — public == full.
// NOT journaled (absent from persistence.cds), exactly like CodeCheckSpecs:
// fully regenerable from rules.vr on the next publish.
entity AssertSpecs : managed {
  key tutorial     : Association to Tutorials;
  key stepNumber   : Integer;
  key assertIndex  : Integer;       // 0-based order within the step
  assertType       : String(8);     // 'cmd' | 'http' | 'file'
  run              : LargeString;   // cmd
  expectExit       : Integer;       // cmd
  httpMethod       : String(8);     // http
  httpPath         : LargeString;   // http
  expectStatus     : Integer;       // http
  filePath         : LargeString;   // file
  expectContains   : Boolean;       // file (false ⇒ exists check)
  matchRegex       : LargeString;   // shared, nullable
}
```

- [ ] **Step 4: Write `srv/lib/assert-spec-publish.js`**

```js
// srv/lib/assert-spec-publish.js
// Handler for POST /content/assert-specs
// Bearer-auth protected (CONTENT_API_KEY) via contentAuthMiddleware.
// Upserts AssertSpecs rows keyed (tutorial_ID, stepNumber, assertIndex);
// carry-forward semantics — specs not in the payload are NOT deleted.

import cds from '@sap/cds';
const LOG = cds.log('assert-publish');

const VALID_TYPES = new Set(['cmd', 'http', 'file']);

export async function assertSpecPublishHandler(req, res) {
  const body = req.body;
  if (!body || !Array.isArray(body.specs)) {
    return res.status(400).json({ error: 'invalid_body' });
  }

  // Validate ALL specs first — fail-fast — before any DB writes.
  for (const s of body.specs) {
    if (!s
        || typeof s.slug !== 'string' || !s.slug
        || typeof s.stepNumber !== 'number'
        || typeof s.index !== 'number'
        || typeof s.type !== 'string' || !VALID_TYPES.has(s.type)) {
      return res.status(400).json({ error: 'invalid_spec' });
    }
  }

  const { Tutorials, AssertSpecs } = cds.entities('com.sap.developers.ims');

  const skipped = [];
  let upserted = 0;

  try {
    for (const s of body.specs) {
      const slug = s.slug.toLowerCase();
      const tut = await SELECT.one.from(Tutorials).where({ slug });
      if (!tut) { skipped.push(slug); continue; }

      const key = { tutorial_ID: tut.ID, stepNumber: s.stepNumber, assertIndex: s.index };
      const existing = await SELECT.one.from(AssertSpecs).where(key);

      // Map the JS AssertBlock shape onto the entity's column names.
      const fields = {
        assertType: s.type,
        run: s.run ?? null,
        expectExit: typeof s.expectExit === 'number' ? s.expectExit : null,
        httpMethod: s.method ?? null,
        httpPath: s.path ?? null,
        expectStatus: typeof s.expectStatus === 'number' ? s.expectStatus : null,
        filePath: s.filePath ?? null,
        expectContains: typeof s.expectContains === 'boolean' ? s.expectContains : null,
        matchRegex: s.match ?? null,
      };

      // No DELETE anywhere — carry-forward: specs absent from a payload are RETAINED.
      if (existing) {
        await UPDATE(AssertSpecs).set(fields).where(key);
      } else {
        await INSERT.into(AssertSpecs).entries({ ...key, ...fields });
      }
      upserted++;
    }
  } catch (err) {
    LOG.error('assert-spec-publish failed', err.message);
    return res.status(500).json({ error: 'persist_failed', message: err.message });
  }

  LOG.info('assert-spec-publish', { upserted, skipped: skipped.length });
  return res.status(200).json({ upserted, skipped });
}
```

- [ ] **Step 5: Mount the route in `srv/server.js`**

Add the import beside the code-check handler import (~L77):

```js
import { assertSpecPublishHandler } from './lib/assert-spec-publish.js';
```

Add the route beside the code-check route (~L942):

```js
app.post('/content/assert-specs', express.json({ limit: '5mb' }), contentAuthMiddleware, assertSpecPublishHandler);
```

- [ ] **Step 6: Run the handler test to verify it passes**

Run: `npx vitest run test/unit/assert-spec-publish.test.js`
Expected: PASS.

- [ ] **Step 7: Verify the model compiles for HANA**

Run: `npx cds deploy --to sqlite::memory: > /dev/null && npx cds build --production`
Expected: build succeeds; `AssertSpecs` compiles to a plain `.hdbtable` (not journaled). No hand-editing.

- [ ] **Step 8: Commit**

```bash
git add db/schema.cds srv/lib/assert-spec-publish.js srv/server.js test/unit/assert-spec-publish.test.js
git commit -m "feat(2245): AssertSpecs entity + POST /content/assert-specs carry-forward handler"
```

---

### Task 6: publish-content wiring + deploy/ops guardrails

**Files:**
- Modify: `scripts/publish-content.ts` (import + mirror the code-check collect/publish block, ~L1343-1365)
- Modify: `scripts/check-srv-qa-route-drift.ts` (`ALLOWLIST_ONLY_ON_SRV`, ~L73)
- Modify: `test/unit/check-srv-qa-route-drift.test.ts` (mirror the assertion — if this test file exists; otherwise skip and rely on the script's own guard)
- Modify: `test/smoke/express-route-mutations.test.js` (route list, ~L22)
- Modify: `.deploy/mta.yaml` (`srv-qa` `cp` list — add `assert-spec-publish.js`)
- Modify: `scripts/seed-secrets.cjs` (append `/content/assert-specs` to CONTENT_API_KEY description, ~L58, cosmetic)

**Interfaces:**
- Consumes: `collectAssertSpecs`, `publishAssertSpecs` (Task 4); `POST /content/assert-specs` (Task 5); `withRetry`, `formatErrorChain`, `log`, `channel`, `opts.baseUrl`, `opts.apiKey` (already in scope in publish-content.ts).
- Produces: assert specs published as a non-fatal auxiliary step during every content publish; guards updated so CI passes.

- [ ] **Step 1: Add the publish-content import**

Beside the code-check import in `scripts/publish-content.ts`:

```ts
import { collectAssertSpecs, publishAssertSpecs } from './lib/publish-asserts.js';
```

- [ ] **Step 2: Add the assert publish block**

Immediately after the code-check spec publish `try/catch` (after `publish-content.ts:1365`), mirroring it exactly:

```ts
  // --- assert spec publish (non-fatal auxiliary step, issue #2245) ---
  try {
    const cacheDir = channel === 'qa'
      ? join(process.cwd(), '.tutorial-cache-qa')
      : join(process.cwd(), '.tutorial-cache');
    const specs = collectAssertSpecs(cacheDir);
    if (specs.length) {
      log(`Publishing ${specs.length} assert spec(s) to /content/assert-specs`);
      const result = await withRetry(
        () => publishAssertSpecs(opts.baseUrl, opts.apiKey, specs),
        {
          attempts: 3, backoffMs: [1000, 3000],
          onAttemptFail: (attempt, err, willRetry) => {
            console.error(`[publish-content] assert spec publish failed (attempt ${attempt}/3): ${formatErrorChain(err)}${willRetry ? ' — retrying' : ''}`);
          },
        }
      );
      log(`assert specs upserted=${result.upserted} skipped=${result.skipped.length}`);
    }
  } catch (err) {
    console.error('[publish-content] assert spec publish failed (non-fatal):', formatErrorChain(err));
    // Do NOT exit non-zero — content publish is the critical path; specs are auxiliary.
  }
```

- [ ] **Step 3: Update the srv-qa route-drift allowlist**

In `scripts/check-srv-qa-route-drift.ts`, add to `ALLOWLIST_ONLY_ON_SRV` (~L73), beside `POST /content/code-check-specs`:

```ts
  'POST /content/assert-specs',
```

If `test/unit/check-srv-qa-route-drift.test.ts` exists and asserts the allowlist contents, add the matching expectation there.

- [ ] **Step 4: Update the route smoke test**

In `test/smoke/express-route-mutations.test.js` (~L22), add beside the code-check entry:

```js
  { path: '/content/assert-specs', method: 'POST' },
```

- [ ] **Step 5: Update the srv-qa cp list**

In `.deploy/mta.yaml`, in the `srv-qa` module's `build-parameters.supported-parsers`/`cp` list where `srv/lib/code-check-spec-publish.js` is copied, add the sibling line for `srv/lib/assert-spec-publish.js` (match the exact path form used for the code-check entry). `assert-spec-publish.js` has no `./` imports beyond `@sap/cds`, so no further transitive deps are added.

- [ ] **Step 6: Update seed-secrets description (cosmetic)**

In `scripts/seed-secrets.cjs` (~L58), append `/content/assert-specs` to the endpoint list in the `CONTENT_API_KEY` description string.

- [ ] **Step 7: Run the guard tests + type-check**

Run:
```bash
npx tsc --noEmit
npx vitest run test/smoke/express-route-mutations.test.js
npx tsx scripts/check-srv-qa-route-drift.ts
```
Expected: tsc clean; smoke route test PASS; route-drift check exits 0.

- [ ] **Step 8: Commit**

```bash
git add scripts/publish-content.ts scripts/check-srv-qa-route-drift.ts test/smoke/express-route-mutations.test.js .deploy/mta.yaml scripts/seed-secrets.cjs
git add test/unit/check-srv-qa-route-drift.test.ts 2>/dev/null || true
git commit -m "feat(2245): wire assert-spec publish into publish-content + route/qa guards"
```

---

### Task 7: Full-suite green + PR

**Files:** none (verification + PR).

- [ ] **Step 1: Run the full unit suite**

Run: `npm test`
Expected: green, including the four new test files.

- [ ] **Step 2: Confirm the model still builds**

Run: `npx cds build --production`
Expected: success with `AssertSpecs` present.

- [ ] **Step 3: Open a PR targeting DEV**

```bash
git push -u origin worktree-assert-blocks-2245
gh pr create --base DEV --title "feat(2245): assert blocks — parse + persist verifiable tutorial postconditions" \
  --body "Implements issue #2245 item #2 (parse + persist only). Spec: docs/superpowers/specs/2026-09-11-assert-blocks-design.md; plan: docs/superpowers/plans/2026-09-11-assert-blocks.md."
```

(Never merge directly to `main`; PRs target `DEV`.)

## Definition of done

- Four new test groups green under `npm test`: parser, frontmatter emit, sidecar collect, publish handler.
- `npx cds build --production` succeeds with `AssertSpecs`.
- Route-drift + smoke guards updated and passing.
- No runner, no `verify.sh`, no UI, no feature flag — parse + persist only.

## Self-review notes

- **Spec coverage:** §4 syntax → Task 1 parser; §5 data model → Task 1 types; §6 parser → Task 1; §7 wiring (1–7) → Tasks 2/3/4/5/6; §8 entity → Task 5; §9 guardrails → Task 6; §10 testing → Tasks 1/2/4/5. All spec sections map to a task.
- **Type consistency:** JS `AssertBlock.type`/`method`/`path`/`match` map to entity columns `assertType`/`httpMethod`/`httpPath`/`matchRegex` in the Task 5 handler; the `index` field is the DB key column `assertIndex`. `parseAssertBlocks`/`attachAssertSpecs`/`collectAssertSpecs`/`publishAssertSpecs`/`assertSpecPublishHandler` names are identical across the tasks that define and consume them.
- **Placeholder scan:** every code step carries real code; guardrail steps (5, 6) reference exact files and the code-check sibling to copy from.
