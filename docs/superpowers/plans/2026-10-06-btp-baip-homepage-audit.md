# BTP → BAIP Homepage Content Audit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a three-stage workstation pipeline (export → classify → apply) that audits BTP references in Production homepage descriptive text and intelligently rewrites them for the Business AI Platform rename, with a human review gate before any Production write.

**Architecture:** Three `.cjs` scripts under `scripts/btp-audit/`, each run via `cds bind --exec -- node` so they operate against Production service bindings. `export.cjs` reads candidate rows from prod HANA into JSON; `classify.cjs` sends each candidate field to the LLM (via `@sap-ai-sdk/orchestration`, the repo's real completion path) and emits a human report plus a machine changeset; `apply.cjs` writes approved changes back to prod HANA with dry-run-by-default, prod-target guard, and optimistic concurrency. Pure CDS-QL on SQLite for unit tests; raw parameterized SQL on HANA.

**Tech Stack:** Node.js (CJS), `@sap/cds` (`cds.connect.to('db')`), `@sap-ai-sdk/orchestration` `OrchestrationClient`, Vitest + `cds.test` for unit tests. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-10-06-btp-baip-homepage-audit-design.md`

## Global Constraints

- **Never abbreviate the new name to "BAIP"** — output is `SAP Business AI Platform` (prominent/first mention in a field) or `Business AI Platform` (subsequent mentions).
- **Keep tool names verbatim:** `BTP Cockpit`, `BTP CLI` (and any future entries in the KEEP list) are NOT rewritten.
- **Strip service prefix:** `SAP BTP, <service>` / `SAP BTP <service>` → `<service>`.
- **Ambiguous → NEEDS_REVIEW**, never auto-applied.
- **No raw SQL string concatenation of values** — HANA raw SQL uses `?` placeholders with a positional params array (CLAUDE.md hard rule). Identifiers may be interpolated only from the fixed, in-code field allowlist, never from data.
- **Scripts are `.cjs`**, `require('@sap/cds')`, invoked `cds bind --exec -- node scripts/btp-audit/<name>.cjs`. Match existing bound-DB scripts (e.g. `scripts/export-advocates.cjs`).
- **HANA guard idiom:** `const isHana = db.options?.kind === 'hana' || db.constructor?.name === 'HANAService';`
- **HANA table/column naming:** table `COM_SAP_DEVELOPERS_IMS_<ENTITY>` (namespace `com.sap.developers.ims`, upper-cased, dots→underscores); columns quoted-UPPERCASE; read back case-insensitively (`r.VALUE ?? r.value`).
- **Prod write guard:** `apply.cjs` is dry-run by default; `--commit` required to write; aborts unless `cf target` shows the expected prod org/space.
- **Never mutate prod from a workstation casually** — these scripts are the sanctioned exception for a one-off data cleanse; the guard + dry-run + review gate are load-bearing, do not weaken them.

## Entity / Field Map (shared by all tasks)

The audited fields, by CDS entity (namespace `com.sap.developers.ims`). This exact map is the single source of truth; `export.cjs` defines it and the others import it.

| Entity | Key field(s) | Audited text fields |
|---|---|---|
| `HomepageShelves` | `ID` | `title`, `description`, `tagline`, `whyItMatters` |
| `VerbDefinitions` | `verbKey` | `label`, `tagline`, `whyItMatters` |
| `ShelfDefinitions` | `shelfKey` | `label`, `tagline`, `whyItMatters` |
| `HomepageForYouCandidates` | `ID` | `title`, `description` |
| `HomepageFeaturedTopics` | `ID` | `displayTitle`, `notes` |

## File Structure

- `scripts/btp-audit/fields.cjs` — **create.** The entity/field map above plus HANA table-name + key-column metadata, and the candidate-match regex. One responsibility: the shared contract. Imported by all three scripts and the tests.
- `scripts/btp-audit/export.cjs` — **create.** Read prod HANA, filter to candidate rows, write `btp-audit/export.json`.
- `scripts/btp-audit/classify.cjs` — **create.** Read `export.json`, call LLM per candidate, write `btp-audit/report.md` + `btp-audit/changeset.json`. Pure classification logic (prompt build + response parse) factored into exported functions so it is testable without a live LLM.
- `scripts/btp-audit/apply.cjs` — **create.** Read `changeset.json`, dry-run preview or `--commit` write to prod HANA with guards; write `btp-audit/applied.json`.
- `scripts/btp-audit/README.md` — **create.** Run order, env, guards, review-gate instructions.
- `srv/__tests__/btp-audit.test.js` — **create.** Unit tests (in-memory SQLite) for the field map, export filter, classification mapping, and apply guard logic.
- `.gitignore` — **modify.** Ignore the `btp-audit/` output directory (export/report/changeset/applied are run artifacts, not source).
- `package.json` — **modify.** Add npm script aliases for the three stages.

---

### Task 1: Shared field map and candidate matcher (`fields.cjs`)

**Files:**
- Create: `scripts/btp-audit/fields.cjs`
- Test: `srv/__tests__/btp-audit.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `AUDIT_MAP` — array of `{ entity, keyField, textFields, hanaTable, hanaKeyCol }`, where `entity` is the bare entity name (e.g. `'HomepageShelves'`), `keyField` the CDS key property (e.g. `'ID'` / `'verbKey'`), `textFields` the array of audited field names, `hanaTable` the uppercased table name, `hanaKeyCol` the uppercased key column.
  - `CANDIDATE_RE` — `RegExp` `/btp|business technology platform/i` (new instance via a `candidateRe()` factory to avoid shared-lastIndex bugs; `CANDIDATE_RE` itself has no `g` flag so it is safe to reuse).
  - `isCandidate(value)` — returns `true` if a string value matches `CANDIDATE_RE` (false for null/non-string).
  - `NS` — the string `'com.sap.developers.ims'`.

- [ ] **Step 1: Write the failing test**

Append to `srv/__tests__/btp-audit.test.js` (create the file with this content):

```js
import { describe, it, expect } from 'vitest';
import {
  AUDIT_MAP, isCandidate, candidateRe, NS,
} from '../../scripts/btp-audit/fields.cjs';

describe('btp-audit fields map', () => {
  it('covers exactly the five in-scope entities with correct keys and fields', () => {
    const byEntity = Object.fromEntries(AUDIT_MAP.map(m => [m.entity, m]));
    expect(Object.keys(byEntity).sort()).toEqual([
      'HomepageFeaturedTopics', 'HomepageForYouCandidates',
      'HomepageShelves', 'ShelfDefinitions', 'VerbDefinitions',
    ]);
    expect(byEntity.HomepageShelves.keyField).toBe('ID');
    expect(byEntity.HomepageShelves.textFields).toEqual(
      ['title', 'description', 'tagline', 'whyItMatters']);
    expect(byEntity.VerbDefinitions.keyField).toBe('verbKey');
    expect(byEntity.ShelfDefinitions.keyField).toBe('shelfKey');
    expect(byEntity.HomepageFeaturedTopics.textFields).toEqual(
      ['displayTitle', 'notes']);
  });

  it('derives HANA table names as COM_SAP_DEVELOPERS_IMS_<ENTITY>', () => {
    const shelves = AUDIT_MAP.find(m => m.entity === 'HomepageShelves');
    expect(shelves.hanaTable).toBe('COM_SAP_DEVELOPERS_IMS_HOMEPAGESHELVES');
    expect(shelves.hanaKeyCol).toBe('ID');
    const verbs = AUDIT_MAP.find(m => m.entity === 'VerbDefinitions');
    expect(verbs.hanaKeyCol).toBe('VERBKEY');
  });

  it('isCandidate matches BTP variants case-insensitively, ignores non-strings', () => {
    expect(isCandidate('Deploy to SAP BTP today')).toBe(true);
    expect(isCandidate('the business technology platform')).toBe(true);
    expect(isCandidate('Use the btp CLI')).toBe(true);
    expect(isCandidate('Just plain tutorial text')).toBe(false);
    expect(isCandidate(null)).toBe(false);
    expect(isCandidate(42)).toBe(false);
  });

  it('candidateRe() returns a fresh non-global regex each call', () => {
    const a = candidateRe();
    const b = candidateRe();
    expect(a).not.toBe(b);
    expect(a.global).toBe(false);
    expect(NS).toBe('com.sap.developers.ims');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run srv/__tests__/btp-audit.test.js -t 'fields map'`
Expected: FAIL — cannot resolve `../../scripts/btp-audit/fields.cjs` (module not found).

- [ ] **Step 3: Write minimal implementation**

Create `scripts/btp-audit/fields.cjs`:

```js
'use strict';
// Shared contract for the BTP→BAIP homepage audit scripts.
// Single source of truth for which entities/fields are audited and how
// they map onto HANA table/column names.

const NS = 'com.sap.developers.ims';

// Bare field map (entity → key + audited text fields). Order of textFields
// is intentional (matches spec); do not reorder.
const RAW = [
  { entity: 'HomepageShelves',          keyField: 'ID',
    textFields: ['title', 'description', 'tagline', 'whyItMatters'] },
  { entity: 'VerbDefinitions',          keyField: 'verbKey',
    textFields: ['label', 'tagline', 'whyItMatters'] },
  { entity: 'ShelfDefinitions',         keyField: 'shelfKey',
    textFields: ['label', 'tagline', 'whyItMatters'] },
  { entity: 'HomepageForYouCandidates', keyField: 'ID',
    textFields: ['title', 'description'] },
  { entity: 'HomepageFeaturedTopics',   keyField: 'ID',
    textFields: ['displayTitle', 'notes'] },
];

// HANA stores unquoted-declared identifiers upper-cased; table name is the
// namespace + entity, dots→underscores, upper-cased.
const hanaTableFor = (entity) =>
  `${NS}.${entity}`.replace(/\./g, '_').toUpperCase();

const AUDIT_MAP = RAW.map(m => ({
  ...m,
  hanaTable: hanaTableFor(m.entity),
  hanaKeyCol: m.keyField.toUpperCase(),
}));

const candidateRe = () => /btp|business technology platform/i;
const CANDIDATE_RE = /btp|business technology platform/i;

const isCandidate = (value) =>
  typeof value === 'string' && CANDIDATE_RE.test(value);

module.exports = { NS, AUDIT_MAP, candidateRe, CANDIDATE_RE, isCandidate };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run srv/__tests__/btp-audit.test.js -t 'fields map'`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add scripts/btp-audit/fields.cjs srv/__tests__/btp-audit.test.js
git commit -m "feat(btp-audit): shared entity/field map and candidate matcher"
```

---

### Task 2: Classification core (prompt build + response parse)

Pure functions with no I/O, so the "intelligent" rules are unit-tested without a live LLM. `classify.cjs` (Task 4) wires these to the real `OrchestrationClient`.

**Files:**
- Create: `scripts/btp-audit/classify-core.cjs`
- Test: `srv/__tests__/btp-audit.test.js` (append)

**Interfaces:**
- Consumes: nothing (string in, object out).
- Produces:
  - `buildMessages(candidate)` — takes `{ entity, key, field, value }`, returns a `{ system, user }` object: `system` is the full rules prompt string; `user` is the field value wrapped with its entity/field context. (Returned shape feeds `classify.cjs`'s orchestration call: `system` → prompt template, `user` → messagesHistory.)
  - `parseClassification(rawText, candidate)` — parses the model's JSON reply into
    `{ entity, key, field, oldValue, newValue, action, rationale }` where
    `action ∈ {'REPLACE','KEEP','STRIP_PREFIX','NEEDS_REVIEW'}`. On unparseable/invalid
    output returns an action `'NEEDS_REVIEW'` with `newValue: null` and the parse error in
    `rationale` (fail-safe — never throws, never fabricates a REPLACE).
  - `VALID_ACTIONS` — the frozen array of the four action strings.

- [ ] **Step 1: Write the failing test**

Append to `srv/__tests__/btp-audit.test.js`:

```js
import {
  buildMessages, parseClassification, VALID_ACTIONS,
} from '../../scripts/btp-audit/classify-core.cjs';

describe('btp-audit classification core', () => {
  const cand = { entity: 'HomepageShelves', key: 'abc', field: 'tagline',
                 value: 'Build on SAP BTP with the BTP Cockpit.' };

  it('buildMessages embeds the four rules and the field value', () => {
    const { system, user } = buildMessages(cand);
    expect(system).toMatch(/Business AI Platform/);
    expect(system).toMatch(/never.*BAIP/i);
    expect(system).toMatch(/BTP Cockpit/);
    expect(system).toMatch(/STRIP_PREFIX/);
    expect(system).toMatch(/NEEDS_REVIEW/);
    expect(user).toContain('Build on SAP BTP with the BTP Cockpit.');
    expect(user).toContain('HomepageShelves');
    expect(user).toContain('tagline');
  });

  it('parseClassification reads a well-formed REPLACE reply', () => {
    const raw = JSON.stringify({
      action: 'REPLACE',
      newValue: 'Build on SAP Business AI Platform with the BTP Cockpit.',
      rationale: 'Platform ref rewritten; tool name kept.',
    });
    const r = parseClassification(raw, cand);
    expect(r.action).toBe('REPLACE');
    expect(r.newValue).toMatch(/SAP Business AI Platform/);
    expect(r.oldValue).toBe(cand.value);
    expect(r.entity).toBe('HomepageShelves');
    expect(r.field).toBe('tagline');
    expect(r.key).toBe('abc');
  });

  it('parseClassification tolerates fenced ```json blocks', () => {
    const raw = '```json\n{"action":"KEEP","newValue":null,"rationale":"tool name"}\n```';
    const r = parseClassification(raw, cand);
    expect(r.action).toBe('KEEP');
    expect(r.newValue).toBeNull();
  });

  it('parseClassification fails safe to NEEDS_REVIEW on garbage', () => {
    const r = parseClassification('not json at all', cand);
    expect(r.action).toBe('NEEDS_REVIEW');
    expect(r.newValue).toBeNull();
    expect(r.rationale).toMatch(/parse/i);
  });

  it('parseClassification rejects an unknown action as NEEDS_REVIEW', () => {
    const raw = JSON.stringify({ action: 'DELETE_EVERYTHING', newValue: 'x' });
    const r = parseClassification(raw, cand);
    expect(r.action).toBe('NEEDS_REVIEW');
    expect(r.newValue).toBeNull();
  });

  it('parseClassification nulls newValue for KEEP/NEEDS_REVIEW even if model sent one', () => {
    const raw = JSON.stringify({ action: 'KEEP', newValue: 'should be ignored' });
    const r = parseClassification(raw, cand);
    expect(r.action).toBe('KEEP');
    expect(r.newValue).toBeNull();
  });

  it('exposes the four valid actions', () => {
    expect([...VALID_ACTIONS].sort()).toEqual(
      ['KEEP', 'NEEDS_REVIEW', 'REPLACE', 'STRIP_PREFIX']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run srv/__tests__/btp-audit.test.js -t 'classification core'`
Expected: FAIL — cannot resolve `classify-core.cjs`.

- [ ] **Step 3: Write minimal implementation**

Create `scripts/btp-audit/classify-core.cjs`:

```js
'use strict';
// Pure classification logic for the BTP→BAIP audit: builds the LLM prompt and
// parses the reply. No I/O, no SDK — so the rename rules are unit-testable.

const VALID_ACTIONS = Object.freeze(['REPLACE', 'KEEP', 'STRIP_PREFIX', 'NEEDS_REVIEW']);

const SYSTEM_PROMPT = [
  'You audit SAP marketing/UI copy for the rename of "SAP BTP" to the',
  '"Business AI Platform". For ONE text field, decide exactly ONE action and,',
  'when rewriting, return the FULL new field value (not a diff).',
  '',
  'Rules:',
  '1. REPLACE — a standalone reference to the platform itself ("BTP", "SAP BTP",',
  '   "Business Technology Platform"). Rewrite to "SAP Business AI Platform" for',
  '   the first/most prominent mention in the field, and "Business AI Platform"',
  '   for any later mentions. NEVER abbreviate to "BAIP".',
  '2. KEEP — recognised product/tool names stay verbatim: "BTP Cockpit",',
  '   "BTP CLI". If the only BTP reference is such a tool name, action is KEEP.',
  '3. STRIP_PREFIX — a service named "SAP BTP, <service>" or "SAP BTP <service>"',
  '   becomes just "<service>" (drop the "SAP BTP" prefix and any comma).',
  '4. NEEDS_REVIEW — anything ambiguous, novel phrasing, or a possible new/unknown',
  '   tool name you are not confident about. Do NOT guess.',
  '',
  'A single field may need REPLACE even if it also contains a kept tool name —',
  'rewrite the platform refs, keep the tool name.',
  '',
  'Respond with ONLY a JSON object, no prose:',
  '{"action":"REPLACE|KEEP|STRIP_PREFIX|NEEDS_REVIEW",',
  ' "newValue":"<full new text, or null for KEEP/NEEDS_REVIEW>",',
  ' "rationale":"<one short sentence>"}',
].join('\n');

function buildMessages(candidate) {
  const user = [
    `Entity: ${candidate.entity}`,
    `Field: ${candidate.field}`,
    'Current value (between <<< >>>):',
    `<<<${candidate.value}>>>`,
  ].join('\n');
  return { system: SYSTEM_PROMPT, user };
}

function stripFence(text) {
  if (typeof text !== 'string') return '';
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  return (fenced ? fenced[1] : text).trim();
}

function parseClassification(rawText, candidate) {
  const base = {
    entity: candidate.entity, key: candidate.key, field: candidate.field,
    oldValue: candidate.value,
  };
  let obj;
  try {
    obj = JSON.parse(stripFence(rawText));
  } catch (e) {
    return { ...base, action: 'NEEDS_REVIEW', newValue: null,
      rationale: `parse error: ${e.message}` };
  }
  const action = obj && typeof obj.action === 'string' ? obj.action.toUpperCase() : '';
  if (!VALID_ACTIONS.includes(action)) {
    return { ...base, action: 'NEEDS_REVIEW', newValue: null,
      rationale: `invalid action from model: ${JSON.stringify(obj && obj.action)}` };
  }
  const writes = action === 'REPLACE' || action === 'STRIP_PREFIX';
  const newValue = writes && typeof obj.newValue === 'string' ? obj.newValue : null;
  if (writes && newValue === null) {
    return { ...base, action: 'NEEDS_REVIEW', newValue: null,
      rationale: `model chose ${action} but returned no newValue` };
  }
  return { ...base, action, newValue,
    rationale: typeof obj.rationale === 'string' ? obj.rationale : '' };
}

module.exports = { VALID_ACTIONS, SYSTEM_PROMPT, buildMessages, parseClassification };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run srv/__tests__/btp-audit.test.js -t 'classification core'`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add scripts/btp-audit/classify-core.cjs srv/__tests__/btp-audit.test.js
git commit -m "feat(btp-audit): pure classification prompt-build and reply-parse"
```

---

### Task 3: Export script (`export.cjs`)

Reads the five entities from the bound DB, filters to candidate rows, writes `btp-audit/export.json`. Testable DB logic lives in an exported `collectCandidates(db, entities)` that works on both SQLite (CDS QL) and HANA (raw).

**Files:**
- Create: `scripts/btp-audit/export.cjs`
- Test: `srv/__tests__/btp-audit.test.js` (append)

**Interfaces:**
- Consumes: `AUDIT_MAP`, `isCandidate`, `NS` from `fields.cjs`.
- Produces:
  - `collectCandidates(db, entities)` — async; `entities` is the object from `cds.entities(NS)`. Returns an array of `{ entity, key, field, value }` for every audited field whose value `isCandidate`. Uses CDS QL `SELECT` (fine for String columns on both engines — these are NOT LOBs). One row yields up to N candidate records (one per matching field).
  - A CLI entry (IIFE) that connects, calls `collectCandidates`, and writes `btp-audit/export.json` as `{ generatedAt, count, candidates: [...] }`.

- [ ] **Step 1: Write the failing test**

Append to `srv/__tests__/btp-audit.test.js`. This test uses an in-memory CAP instance and seeds rows:

```js
import cds from '@sap/cds';
import { collectCandidates } from '../../scripts/btp-audit/export.cjs';

describe('btp-audit export.collectCandidates (in-memory sqlite)', () => {
  // reuse a single served instance for the DB-backed tests
  cds.test('serve', '--project', '.', '--in-memory');

  it('selects only fields containing BTP variants, one record per field', async () => {
    const db = await cds.connect.to('db');
    const ents = cds.entities('com.sap.developers.ims');
    const { HomepageShelves, VerbDefinitions } = ents;
    await DELETE.from(HomepageShelves).where({ ID: { in: ['s-btp', 's-clean'] } });
    await DELETE.from(VerbDefinitions).where({ verbKey: 'ZZTEST' });
    await INSERT.into(HomepageShelves).entries([
      { ID: 's-btp', verb: 'BUILD', shelf: 'TOOLS',
        title: 'Deploy to SAP BTP', description: 'nothing here',
        tagline: 'Use the BTP Cockpit', whyItMatters: 'plain text' },
      { ID: 's-clean', verb: 'LEARN', shelf: 'REFERENCE',
        title: 'Clean title', description: 'clean', tagline: 'clean', whyItMatters: 'clean' },
    ]);
    await INSERT.into(VerbDefinitions).entries([
      { verbKey: 'ZZTEST', label: 'Build', tagline: 'On Business Technology Platform',
        whyItMatters: 'clean' },
    ]);

    const found = await collectCandidates(db, ents);
    const mine = found.filter(c =>
      (c.entity === 'HomepageShelves' && ['s-btp', 's-clean'].includes(c.key)) ||
      (c.entity === 'VerbDefinitions' && c.key === 'ZZTEST'));

    // s-btp.title, s-btp.tagline, ZZTEST.tagline  => 3; s-clean => 0
    expect(mine.map(c => `${c.entity}.${c.key}.${c.field}`).sort()).toEqual([
      'HomepageShelves.s-btp.tagline',
      'HomepageShelves.s-btp.title',
      'VerbDefinitions.ZZTEST.tagline',
    ]);
    const title = mine.find(c => c.field === 'title');
    expect(title.value).toBe('Deploy to SAP BTP');

    await DELETE.from(HomepageShelves).where({ ID: { in: ['s-btp', 's-clean'] } });
    await DELETE.from(VerbDefinitions).where({ verbKey: 'ZZTEST' });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run srv/__tests__/btp-audit.test.js -t 'collectCandidates'`
Expected: FAIL — cannot resolve `export.cjs`.

- [ ] **Step 3: Write minimal implementation**

Create `scripts/btp-audit/export.cjs`:

```js
'use strict';
// Stage 1 of the BTP→BAIP homepage audit: read candidate rows from the bound
// (Production) DB into btp-audit/export.json. Read-only.
//
// Run: cds bind --exec -- node scripts/btp-audit/export.cjs

const fs = require('node:fs');
const path = require('node:path');
const cds = require('@sap/cds');
const { AUDIT_MAP, isCandidate, NS } = require('./fields.cjs');

const OUT_DIR = path.resolve(process.cwd(), 'btp-audit');

async function collectCandidates(db, entities) {
  const out = [];
  for (const m of AUDIT_MAP) {
    const ent = entities[m.entity];
    if (!ent) continue; // entity not in this model (defensive)
    const cols = [m.keyField, ...m.textFields];
    // Plain String columns — CDS QL SELECT is safe on both SQLite and HANA
    // (no LOBs involved, so no locator-expiry concern).
    const rows = await db.run(SELECT.from(ent).columns(...cols));
    for (const row of rows) {
      const key = row[m.keyField];
      for (const field of m.textFields) {
        const value = row[field];
        if (isCandidate(value)) out.push({ entity: m.entity, key, field, value });
      }
    }
  }
  return out;
}

async function main() {
  await cds.load('*');
  const db = await cds.connect.to('db');
  const entities = cds.entities(NS);
  const isHana = db.options?.kind === 'hana' || db.constructor?.name === 'HANAService';
  console.log(`[btp-audit:export] db kind=${db.options?.kind} hana=${isHana}`);

  const candidates = await collectCandidates(db, entities);
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const payload = { generatedAt: new Date().toISOString(), count: candidates.length, candidates };
  const outFile = path.join(OUT_DIR, 'export.json');
  fs.writeFileSync(outFile, JSON.stringify(payload, null, 2));
  console.log(`[btp-audit:export] wrote ${candidates.length} candidate field(s) → ${outFile}`);
}

if (require.main === module) {
  main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
}

module.exports = { collectCandidates, OUT_DIR };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run srv/__tests__/btp-audit.test.js -t 'collectCandidates'`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/btp-audit/export.cjs srv/__tests__/btp-audit.test.js
git commit -m "feat(btp-audit): export stage — collect BTP candidate fields from DB"
```

---

### Task 4: Classify script (`classify.cjs`) — report + changeset writer

Wires the pure core (Task 2) to the real LLM and renders `report.md` + `changeset.json`. The report/changeset *rendering* is a pure, tested function; the LLM call is thin and injected so the renderer is testable without a model.

**Files:**
- Create: `scripts/btp-audit/classify.cjs`
- Test: `srv/__tests__/btp-audit.test.js` (append)

**Interfaces:**
- Consumes: `buildMessages`, `parseClassification` from `classify-core.cjs`.
- Produces:
  - `classifyAll(candidates, callLlm)` — async; `callLlm(system, user) => Promise<string>` is injected (real impl calls `OrchestrationClient`; tests pass a fake). Returns an array of classification records (the `parseClassification` shape). Classifies sequentially (small volume; avoids rate limits).
  - `renderReport(records)` — returns a Markdown string grouped by action then entity, with a prominent NEEDS_REVIEW section and old→new blocks for REPLACE/STRIP_PREFIX.
  - `toChangeset(records)` — returns the `{ generatedAt, records: [...] }` object written to `changeset.json` (every record, all four actions, so the human can see and flip them).
  - A CLI entry: reads `export.json`, builds the real `callLlm` via `@sap-ai-sdk/orchestration` + `resolveChatLlmSettings()`, writes `report.md` and `changeset.json`.

- [ ] **Step 1: Write the failing test**

Append to `srv/__tests__/btp-audit.test.js`:

```js
import { classifyAll, renderReport, toChangeset } from '../../scripts/btp-audit/classify.cjs';

describe('btp-audit classify orchestration (fake LLM)', () => {
  const candidates = [
    { entity: 'HomepageShelves', key: 's1', field: 'title', value: 'Deploy to SAP BTP' },
    { entity: 'HomepageShelves', key: 's2', field: 'tagline', value: 'Open the BTP Cockpit' },
    { entity: 'VerbDefinitions', key: 'BUILD', field: 'tagline', value: 'SAP BTP, Kyma runtime' },
    { entity: 'HomepageShelves', key: 's3', field: 'description', value: 'Something BTP unclear' },
  ];
  // fake model keyed by field value
  const fake = async (_system, user) => {
    if (user.includes('Deploy to SAP BTP'))
      return JSON.stringify({ action: 'REPLACE', newValue: 'Deploy to SAP Business AI Platform', rationale: 'platform' });
    if (user.includes('BTP Cockpit'))
      return JSON.stringify({ action: 'KEEP', newValue: null, rationale: 'tool name' });
    if (user.includes('Kyma runtime'))
      return JSON.stringify({ action: 'STRIP_PREFIX', newValue: 'Kyma runtime', rationale: 'service prefix' });
    return 'garbage'; // → NEEDS_REVIEW
  };

  it('classifyAll maps each candidate via the injected LLM', async () => {
    const recs = await classifyAll(candidates, fake);
    expect(recs.map(r => r.action)).toEqual(['REPLACE', 'KEEP', 'STRIP_PREFIX', 'NEEDS_REVIEW']);
    expect(recs[0].newValue).toBe('Deploy to SAP Business AI Platform');
    expect(recs[2].newValue).toBe('Kyma runtime');
    expect(recs[3].newValue).toBeNull();
  });

  it('renderReport groups by action and surfaces NEEDS_REVIEW', async () => {
    const md = renderReport(await classifyAll(candidates, fake));
    expect(md).toMatch(/## REPLACE/);
    expect(md).toMatch(/## STRIP_PREFIX/);
    expect(md).toMatch(/## KEEP/);
    expect(md).toMatch(/## NEEDS_REVIEW/);
    expect(md).toMatch(/Deploy to SAP Business AI Platform/);
    expect(md).toMatch(/Something BTP unclear/);
  });

  it('toChangeset includes every record with its action', async () => {
    const cs = toChangeset(await classifyAll(candidates, fake));
    expect(cs.records).toHaveLength(4);
    expect(cs.records.every(r => r.entity && r.field && r.action)).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run srv/__tests__/btp-audit.test.js -t 'classify orchestration'`
Expected: FAIL — cannot resolve `classify.cjs`.

- [ ] **Step 3: Write minimal implementation**

Create `scripts/btp-audit/classify.cjs`:

```js
'use strict';
// Stage 2 of the BTP→BAIP homepage audit: classify each candidate field with
// the LLM and emit a human report + a machine changeset. The LLM call routes
// through the repo's standard completion path (@sap-ai-sdk/orchestration),
// which uses the bound AICore deployment.
//
// Run: cds bind --exec -- node scripts/btp-audit/classify.cjs

const fs = require('node:fs');
const path = require('node:path');
const { buildMessages, parseClassification } = require('./classify-core.cjs');
const { OUT_DIR } = require('./export.cjs');

async function classifyAll(candidates, callLlm) {
  const records = [];
  for (const c of candidates) {
    const { system, user } = buildMessages(c);
    let raw;
    try {
      raw = await callLlm(system, user);
    } catch (e) {
      records.push({ entity: c.entity, key: c.key, field: c.field, oldValue: c.value,
        action: 'NEEDS_REVIEW', newValue: null, rationale: `LLM error: ${e.message}` });
      continue;
    }
    records.push(parseClassification(raw, c));
  }
  return records;
}

function renderReport(records) {
  const order = ['REPLACE', 'STRIP_PREFIX', 'NEEDS_REVIEW', 'KEEP'];
  const lines = ['# BTP → BAIP Homepage Audit Report', '',
    `Generated: ${new Date().toISOString()}`, `Total candidate fields: ${records.length}`, ''];
  for (const action of order) {
    const group = records.filter(r => r.action === action);
    lines.push(`## ${action} (${group.length})`, '');
    for (const r of group) {
      lines.push(`### ${r.entity} / \`${r.key}\` / \`${r.field}\``);
      lines.push(`- rationale: ${r.rationale || '(none)'}`);
      lines.push('- old:', '  ```', `  ${r.oldValue}`, '  ```');
      if (r.newValue != null) lines.push('- new:', '  ```', `  ${r.newValue}`, '  ```');
      lines.push('');
    }
  }
  return lines.join('\n');
}

function toChangeset(records) {
  return { generatedAt: new Date().toISOString(), records };
}

// --- real LLM wiring (only exercised by the CLI entry, not unit tests) ---
async function makeRealCallLlm() {
  const { OrchestrationClient } = require('@sap-ai-sdk/orchestration');
  const { resolveChatLlmSettings } = require('../../srv/lib/chat-settings-resolver.js');
  const { modelName, deploymentId } = await resolveChatLlmSettings();
  return async (system, user) => {
    const client = new OrchestrationClient(
      { promptTemplating: {
          model: { name: modelName, params: { max_tokens: 1024, temperature: 0 } },
          prompt: { template: [{ role: 'system', content: system }] },
      } },
      { deploymentId });
    const response = await client.chatCompletion({
      messagesHistory: [{ role: 'user', content: user }],
    });
    return response.getContent?.() ?? response.getAssistantMessage?.()?.content ?? '';
  };
}

async function main() {
  const inFile = path.join(OUT_DIR, 'export.json');
  const { candidates } = JSON.parse(fs.readFileSync(inFile, 'utf8'));
  console.log(`[btp-audit:classify] ${candidates.length} candidate field(s) from ${inFile}`);
  const callLlm = await makeRealCallLlm();
  const records = await classifyAll(candidates, callLlm);
  fs.writeFileSync(path.join(OUT_DIR, 'report.md'), renderReport(records));
  fs.writeFileSync(path.join(OUT_DIR, 'changeset.json'), JSON.stringify(toChangeset(records), null, 2));
  const counts = records.reduce((a, r) => ((a[r.action] = (a[r.action] || 0) + 1), a), {});
  console.log(`[btp-audit:classify] done:`, counts);
  console.log(`[btp-audit:classify] review btp-audit/report.md, then edit changeset.json if needed`);
}

if (require.main === module) {
  main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
}

module.exports = { classifyAll, renderReport, toChangeset };
```

> **Note for implementer:** the exact completion read-back method (`getContent()` vs `getAssistantMessage()`) must be confirmed against the installed `@sap-ai-sdk/orchestration` version at implementation time — mirror whatever `srv/lib/ai-quiz-llm.js` / `srv/lib/chat-orchestrator.js` use for *text* completions (they read tool calls; find their text path). The chained `??` fallback above is defensive; replace with the confirmed single call. This line is **not** unit-tested (the CLI path uses a live model), so verify it in the manual prod rehearsal.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run srv/__tests__/btp-audit.test.js -t 'classify orchestration'`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add scripts/btp-audit/classify.cjs srv/__tests__/btp-audit.test.js
git commit -m "feat(btp-audit): classify stage — LLM classification, report, changeset"
```

---

### Task 5: Apply core (guards + decision logic)

Pure decision logic for apply: given a changeset record and the current DB value, decide `applied` / `skipped-concurrent-edit` / `skipped-no-change` / `skipped-action`. Tested without a DB.

**Files:**
- Create: `scripts/btp-audit/apply-core.cjs`
- Test: `srv/__tests__/btp-audit.test.js` (append)

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `decideApply(record, currentValue)` — returns `{ status, write }` where `status ∈
    {'applied','skipped-concurrent-edit','skipped-no-change','skipped-action'}` and `write`
    is boolean. Logic: only `REPLACE`/`STRIP_PREFIX` are writable (else `skipped-action`,
    write=false); if `currentValue !== record.oldValue` → `skipped-concurrent-edit`,
    write=false; if `currentValue === record.newValue` → `skipped-no-change` (idempotent
    re-run), write=false; otherwise `applied`, write=true.
  - `assertProdTarget(cfTargetText, expected)` — throws `Error` unless `cfTargetText`
    contains the expected `org` and `space` substrings; returns `true` on match. (`expected`
    defaults to `{ org: process.env.BTP_AUDIT_PROD_ORG, space: process.env.BTP_AUDIT_PROD_SPACE }`.)

- [ ] **Step 1: Write the failing test**

Append to `srv/__tests__/btp-audit.test.js`:

```js
import { decideApply, assertProdTarget } from '../../scripts/btp-audit/apply-core.cjs';

describe('btp-audit apply core', () => {
  const rec = { action: 'REPLACE', oldValue: 'Deploy to SAP BTP',
                newValue: 'Deploy to SAP Business AI Platform' };

  it('applies when current value still equals oldValue', () => {
    expect(decideApply(rec, 'Deploy to SAP BTP')).toEqual({ status: 'applied', write: true });
  });
  it('skips when the row was edited since export (concurrent edit)', () => {
    expect(decideApply(rec, 'Deploy to SAP BTP (edited)'))
      .toEqual({ status: 'skipped-concurrent-edit', write: false });
  });
  it('skips as no-change when already applied (idempotent re-run)', () => {
    expect(decideApply(rec, 'Deploy to SAP Business AI Platform'))
      .toEqual({ status: 'skipped-no-change', write: false });
  });
  it('skips KEEP and NEEDS_REVIEW actions', () => {
    expect(decideApply({ action: 'KEEP', oldValue: 'x', newValue: null }, 'x').write).toBe(false);
    expect(decideApply({ action: 'NEEDS_REVIEW', oldValue: 'x', newValue: null }, 'x').status)
      .toBe('skipped-action');
  });
  it('assertProdTarget throws unless org and space match', () => {
    const txt = 'org: tutorial-system\nspace: prod\napi endpoint: ...';
    expect(assertProdTarget(txt, { org: 'tutorial-system', space: 'prod' })).toBe(true);
    expect(() => assertProdTarget(txt, { org: 'tutorial-system', space: 'dev' })).toThrow(/space/i);
    expect(() => assertProdTarget('org: other\nspace: prod', { org: 'tutorial-system', space: 'prod' }))
      .toThrow(/org/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run srv/__tests__/btp-audit.test.js -t 'apply core'`
Expected: FAIL — cannot resolve `apply-core.cjs`.

- [ ] **Step 3: Write minimal implementation**

Create `scripts/btp-audit/apply-core.cjs`:

```js
'use strict';
// Pure decision logic for the apply stage: no DB, no process calls — unit-testable.

const WRITABLE = new Set(['REPLACE', 'STRIP_PREFIX']);

function decideApply(record, currentValue) {
  if (!WRITABLE.has(record.action) || record.newValue == null) {
    return { status: 'skipped-action', write: false };
  }
  if (currentValue !== record.oldValue) {
    // Row changed since export, OR already applied. Distinguish the benign case.
    if (currentValue === record.newValue) return { status: 'skipped-no-change', write: false };
    return { status: 'skipped-concurrent-edit', write: false };
  }
  if (currentValue === record.newValue) return { status: 'skipped-no-change', write: false };
  return { status: 'applied', write: true };
}

function assertProdTarget(cfTargetText, expected) {
  const exp = expected || {
    org: process.env.BTP_AUDIT_PROD_ORG, space: process.env.BTP_AUDIT_PROD_SPACE,
  };
  const txt = String(cfTargetText || '');
  if (!exp.org || !txt.includes(exp.org)) {
    throw new Error(`cf target org mismatch: expected to contain "${exp.org}". Aborting prod write.`);
  }
  if (!exp.space || !new RegExp(`space:\\s*${exp.space}\\b`, 'i').test(txt)) {
    throw new Error(`cf target space mismatch: expected "${exp.space}". Aborting prod write.`);
  }
  return true;
}

module.exports = { decideApply, assertProdTarget, WRITABLE };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run srv/__tests__/btp-audit.test.js -t 'apply core'`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add scripts/btp-audit/apply-core.cjs srv/__tests__/btp-audit.test.js
git commit -m "feat(btp-audit): apply-core decision logic and prod-target guard"
```

---

### Task 6: Apply script (`apply.cjs`) — DB write with guards

Wires `apply-core` to the DB. Dry-run default; `--commit` writes. Testable `applyChangeset(db, entities, records, { commit })` returns the per-record result log; it reads the current value, calls `decideApply`, and writes via CDS QL `UPDATE` (SQLite tests) / branches to raw parameterized SQL on HANA.

**Files:**
- Create: `scripts/btp-audit/apply.cjs`
- Test: `srv/__tests__/btp-audit.test.js` (append)

**Interfaces:**
- Consumes: `decideApply`, `assertProdTarget` from `apply-core.cjs`; `AUDIT_MAP`, `NS` from `fields.cjs`.
- Produces:
  - `applyChangeset(db, entities, records, opts)` — async; `opts = { commit: boolean }`.
    For each record: looks up the entity's key field + HANA metadata from `AUDIT_MAP`,
    reads the current value, calls `decideApply`; if `write && commit` performs the
    `UPDATE`; always pushes `{ entity, key, field, oldValue, newValue, status }` to the log
    (status is `would-apply` when `write` but not `commit`). Returns the log array.
  - CLI entry: parses `--commit`, runs `cf target` (via `child_process.execSync`), calls
    `assertProdTarget` only when `commit` and `isHana`, reads `changeset.json`, calls
    `applyChangeset`, writes `applied.json`, prints a status summary.

- [ ] **Step 1: Write the failing test**

Append to `srv/__tests__/btp-audit.test.js` (reuses the served instance from Task 3's describe — add inside the same file; `cds.test` is idempotent per process):

```js
import { applyChangeset } from '../../scripts/btp-audit/apply.cjs';

describe('btp-audit applyChangeset (in-memory sqlite)', () => {
  it('writes REPLACE on --commit, skips on dry-run, guards concurrent edits', async () => {
    const db = await cds.connect.to('db');
    const ents = cds.entities('com.sap.developers.ims');
    const { HomepageShelves } = ents;
    await DELETE.from(HomepageShelves).where({ ID: { in: ['a1', 'a2', 'a3'] } });
    await INSERT.into(HomepageShelves).entries([
      { ID: 'a1', verb: 'BUILD', shelf: 'TOOLS', title: 'Deploy to SAP BTP' },
      { ID: 'a2', verb: 'BUILD', shelf: 'TOOLS', title: 'Deploy to SAP BTP' }, // will be edited
      { ID: 'a3', verb: 'BUILD', shelf: 'TOOLS', title: 'Open BTP Cockpit' },  // KEEP
    ]);
    const records = [
      { entity: 'HomepageShelves', key: 'a1', field: 'title',
        oldValue: 'Deploy to SAP BTP', newValue: 'Deploy to SAP Business AI Platform', action: 'REPLACE' },
      { entity: 'HomepageShelves', key: 'a2', field: 'title',
        oldValue: 'Deploy to SAP BTP', newValue: 'Deploy to SAP Business AI Platform', action: 'REPLACE' },
      { entity: 'HomepageShelves', key: 'a3', field: 'title',
        oldValue: 'Open BTP Cockpit', newValue: null, action: 'KEEP' },
    ];

    // dry-run: nothing written
    const dry = await applyChangeset(db, ents, records, { commit: false });
    expect(dry.find(r => r.key === 'a1').status).toBe('would-apply');
    const a1dry = await SELECT.one.from(HomepageShelves).where({ ID: 'a1' });
    expect(a1dry.title).toBe('Deploy to SAP BTP'); // unchanged

    // simulate a concurrent edit to a2
    await UPDATE(HomepageShelves).set({ title: 'Deploy to SAP BTP (hand-edited)' }).where({ ID: 'a2' });

    // commit
    const log = await applyChangeset(db, ents, records, { commit: true });
    expect(log.find(r => r.key === 'a1').status).toBe('applied');
    expect(log.find(r => r.key === 'a2').status).toBe('skipped-concurrent-edit');
    expect(log.find(r => r.key === 'a3').status).toBe('skipped-action');

    const a1 = await SELECT.one.from(HomepageShelves).where({ ID: 'a1' });
    const a2 = await SELECT.one.from(HomepageShelves).where({ ID: 'a2' });
    expect(a1.title).toBe('Deploy to SAP Business AI Platform');
    expect(a2.title).toBe('Deploy to SAP BTP (hand-edited)'); // untouched

    await DELETE.from(HomepageShelves).where({ ID: { in: ['a1', 'a2', 'a3'] } });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run srv/__tests__/btp-audit.test.js -t 'applyChangeset'`
Expected: FAIL — cannot resolve `apply.cjs`.

- [ ] **Step 3: Write minimal implementation**

Create `scripts/btp-audit/apply.cjs`:

```js
'use strict';
// Stage 3 of the BTP→BAIP homepage audit: apply the approved changeset to the
// bound (Production) DB. Dry-run by default; --commit to write. Guards:
// prod cf-target check, optimistic concurrency (value must still equal oldValue).
//
// Run (preview): cds bind --exec -- node scripts/btp-audit/apply.cjs
// Run (write):   cds bind --exec -- node scripts/btp-audit/apply.cjs --commit

const fs = require('node:fs');
const path = require('node:path');
const { execSync } = require('node:child_process');
const cds = require('@sap/cds');
const { AUDIT_MAP, NS } = require('./fields.cjs');
const { decideApply, assertProdTarget } = require('./apply-core.cjs');
const { OUT_DIR } = require('./export.cjs');

const META = Object.fromEntries(AUDIT_MAP.map(m => [m.entity, m]));

async function readCurrent(db, entities, meta, key) {
  // Single-column reads; plain Strings (no LOBs) so CDS QL is safe on both engines.
  const row = await db.run(
    SELECT.one.from(entities[meta.entity]).where({ [meta.keyField]: key }));
  return row || null;
}

async function writeValue(db, entities, meta, key, field, newValue) {
  const isHana = db.options?.kind === 'hana' || db.constructor?.name === 'HANAService';
  if (isHana) {
    // Raw parameterized SQL — identifiers come from the fixed in-code map (never data),
    // values are bound via ? placeholders (CLAUDE.md: no SQL string concat of values).
    const sql = `UPDATE ${meta.hanaTable} SET "${field.toUpperCase()}" = ? ` +
                `WHERE "${meta.hanaKeyCol}" = ?`;
    await db.run(sql, [newValue, key]);
  } else {
    await db.run(UPDATE(entities[meta.entity]).set({ [field]: newValue })
      .where({ [meta.keyField]: key }));
  }
}

async function applyChangeset(db, entities, records, opts) {
  const commit = !!(opts && opts.commit);
  const log = [];
  for (const r of records) {
    const meta = META[r.entity];
    if (!meta) { log.push({ ...pick(r), status: 'skipped-unknown-entity' }); continue; }
    const row = await readCurrent(db, entities, meta, r.key);
    if (!row) { log.push({ ...pick(r), status: 'skipped-missing-row' }); continue; }
    const currentValue = row[r.field];
    const { status, write } = decideApply(r, currentValue);
    if (write && commit) {
      await writeValue(db, entities, meta, r.key, r.field, r.newValue);
      log.push({ ...pick(r), status: 'applied' });
    } else if (write && !commit) {
      log.push({ ...pick(r), status: 'would-apply' });
    } else {
      log.push({ ...pick(r), status });
    }
  }
  return log;
}

function pick(r) {
  return { entity: r.entity, key: r.key, field: r.field,
    oldValue: r.oldValue, newValue: r.newValue, action: r.action };
}

async function main() {
  const commit = process.argv.includes('--commit');
  await cds.load('*');
  const db = await cds.connect.to('db');
  const entities = cds.entities(NS);
  const isHana = db.options?.kind === 'hana' || db.constructor?.name === 'HANAService';

  if (commit && isHana) {
    const target = execSync('cf target', { encoding: 'utf8' });
    assertProdTarget(target); // throws → aborts before any write
    console.log('[btp-audit:apply] prod target confirmed; committing.');
  } else if (commit && !isHana) {
    console.log('[btp-audit:apply] --commit on non-HANA db (local); skipping cf target guard.');
  } else {
    console.log('[btp-audit:apply] DRY RUN (no --commit). No rows will be written.');
  }

  const { records } = JSON.parse(fs.readFileSync(path.join(OUT_DIR, 'changeset.json'), 'utf8'));
  const log = await applyChangeset(db, entities, records, { commit });
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, 'applied.json'),
    JSON.stringify({ generatedAt: new Date().toISOString(), commit, log }, null, 2));
  const counts = log.reduce((a, r) => ((a[r.status] = (a[r.status] || 0) + 1), a), {});
  console.log('[btp-audit:apply] result:', counts);
}

if (require.main === module) {
  main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
}

module.exports = { applyChangeset };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run srv/__tests__/btp-audit.test.js -t 'applyChangeset'`
Expected: PASS.

- [ ] **Step 5: Run the full audit test file**

Run: `npx vitest run srv/__tests__/btp-audit.test.js`
Expected: PASS (all describes green).

- [ ] **Step 6: Commit**

```bash
git add scripts/btp-audit/apply.cjs srv/__tests__/btp-audit.test.js
git commit -m "feat(btp-audit): apply stage — guarded DB write with dry-run default"
```

---

### Task 7: Runbook, npm aliases, gitignore

Operational wiring so Tom can run the pipeline and so run artifacts don't get committed.

**Files:**
- Create: `scripts/btp-audit/README.md`
- Modify: `package.json` (scripts block)
- Modify: `.gitignore`

**Interfaces:**
- Consumes: all three stage scripts.
- Produces: npm aliases `btp-audit:export`, `btp-audit:classify`, `btp-audit:apply`.

- [ ] **Step 1: Add npm script aliases**

In `package.json`, add to the `"scripts"` object (match existing `cds bind --exec` style):

```json
"btp-audit:export": "cds bind --exec -- node scripts/btp-audit/export.cjs",
"btp-audit:classify": "cds bind --exec -- node scripts/btp-audit/classify.cjs",
"btp-audit:apply": "cds bind --exec -- node scripts/btp-audit/apply.cjs"
```

- [ ] **Step 2: Ignore run artifacts**

Append to `.gitignore`:

```gitignore
# BTP→BAIP audit run artifacts (export/report/changeset/applied)
/btp-audit/
```

- [ ] **Step 3: Write the runbook**

Create `scripts/btp-audit/README.md`:

```markdown
# BTP → BAIP Homepage Content Audit

One-off data-cleanse pipeline: audit BTP references in Production homepage
descriptive text and rewrite them for the Business AI Platform rename.

Spec: `docs/superpowers/specs/2026-10-06-btp-baip-homepage-audit-design.md`

## Entities audited

HomepageShelves, VerbDefinitions, ShelfDefinitions, HomepageForYouCandidates,
HomepageFeaturedTopics (homepage descriptive text only).

## Rules

- Platform refs (BTP / SAP BTP / Business Technology Platform) → "SAP Business AI
  Platform" (first/prominent) or "Business AI Platform" (later). NEVER "BAIP".
- Tool names kept: BTP Cockpit, BTP CLI.
- "SAP BTP, <service>" → "<service>".
- Ambiguous → NEEDS_REVIEW (never auto-applied).

## Prerequisites

- `cf login` to the **prod** space; `cf target` must show the prod org/space.
- Export the expected target so the apply guard can assert it:
  ```bash
  export BTP_AUDIT_PROD_ORG=<prod-org>
  export BTP_AUDIT_PROD_SPACE=prod
  ```
- Prod AICore binding available for the classify step.

## Run order

```bash
# 1. Export candidates from prod (read-only)
npm run btp-audit:export            # → btp-audit/export.json

# 2. Classify with the LLM
npm run btp-audit:classify          # → btp-audit/report.md + btp-audit/changeset.json

# 3. REVIEW btp-audit/report.md.  Optionally hand-edit btp-audit/changeset.json
#    (e.g. flip a NEEDS_REVIEW to REPLACE with a chosen newValue, or set an
#     action to KEEP).

# 4. Dry run (no writes) — preview exactly what would change
npm run btp-audit:apply             # → btp-audit/applied.json (status would-apply)

# 5. Commit the changes to prod
npm run btp-audit:apply -- --commit # → btp-audit/applied.json (status applied)
```

## Safety

- `apply` is dry-run unless `--commit` is passed.
- On `--commit` against HANA it runs `cf target` and aborts unless org+space match
  `BTP_AUDIT_PROD_ORG` / `BTP_AUDIT_PROD_SPACE`.
- Optimistic concurrency: a field is written only if its current DB value still
  equals the `oldValue` captured at export time; anything edited since is skipped
  and recorded as `skipped-concurrent-edit`.
- Re-running `apply --commit` is idempotent (already-applied rows → `skipped-no-change`).

## Rollback

`btp-audit/applied.json` holds before/after for every written field. To revert,
build a changeset that swaps oldValue↔newValue for the `applied` records and run
the apply stage again.
```

- [ ] **Step 4: Verify npm aliases resolve**

Run: `npm run btp-audit:export -- --help 2>&1 | head -5 || true`
Expected: the command is recognized by npm (it will attempt `cds bind`; without a binding it errors on bind, which is fine — we're only confirming the alias wiring, not running against prod here).

- [ ] **Step 5: Commit**

```bash
git add scripts/btp-audit/README.md package.json .gitignore
git commit -m "docs(btp-audit): runbook, npm aliases, ignore run artifacts"
```

---

## Final Verification (after all tasks)

- [ ] Run the full audit test file: `npx vitest run srv/__tests__/btp-audit.test.js` — all green.
- [ ] Run lint if the repo lints scripts: `npx eslint scripts/btp-audit/ || true`.
- [ ] Confirm no run artifacts are staged: `git status --short btp-audit/` shows nothing (gitignored).
- [ ] Manual prod rehearsal (read-only first): `npm run btp-audit:export` then `npm run btp-audit:classify`, review `report.md`, then `npm run btp-audit:apply` (dry run) BEFORE any `--commit`. Confirm the `@sap-ai-sdk/orchestration` text read-back (Task 4 note) returns real completions.
- [ ] Open a PR to `DEV` (per repo rule: PRs target DEV, never direct-merge to main). The scripts touch no served code paths, so no deploy is required for them to be usable — they run from a workstation via `cds bind`.
