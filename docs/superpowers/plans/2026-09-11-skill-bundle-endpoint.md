# Installable Skill Bundle Endpoint — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `GET /content/tutorials/:slug/skill` — a public, flag-gated endpoint that streams a zip containing an installable agent Skill (`SKILL.md` procedure + runnable `verify.sh` from assert blocks + provenance/freshness stamp).

**Architecture:** A new pure-composition + data module `srv/lib/skill-bundle.js` reads raw tutorial markdown (`getTutorialSource`), the tutorial's `AssertSpecs`, and freshness inputs (`loadProvenanceInputs`/`deriveConfidence`/`buildEnvelope`), composes two text files, and streams them as a zip via `archiver`. It is wired as a plain Express route in `srv/server.js` registered before the `/content/tutorials/*slug` wildcard, gated by a new DB feature flag.

**Tech Stack:** Node.js ESM, CAP (`@sap/cds`), Express, `archiver@8.0.0` (zip, already a dep), `gray-matter` (frontmatter parse, already a dep), `jose` (via existing provenance libs), Vitest.

**Spec:** `docs/superpowers/specs/2026-09-11-skill-bundle-endpoint-design.md`

## Global Constraints

- **No new dependencies** — `archiver@8.0.0`, `gray-matter`, `js-yaml`, `jose`, `jszip` are all already declared. Adding an undeclared `srv/` runtime dep passes tests but crashes CF.
- **Never write raw SQL** — use `cds.ql` (`SELECT`/`INSERT`/`DELETE`). (The one raw-SQL exception in the codebase is BLOB reads in `content-store.js`; not needed here.)
- **Fail-open on sub-data, fail-closed on the feature** — flag OFF → 404; provenance/assert read errors → still ship the bundle with a degraded stamp / no checks.
- **Feature flags are DB config, never env** — register in `feature-flags/registry.js` (`kind:'db'`), read via `isFlagEnabled(key)` from `srv/lib/feature-flags/db-flags.js` (synchronous).
- **New DB flag MUST be in `feature-flags/registry.js`** or a registry guard test fails and it never surfaces in the admin Feature Flags UI.
- **Slugs are lowercase-canonical** — `.toLowerCase()` before any slug comparison/lookup.
- **Route ordering:** the `/skill` route MUST be registered before `app.get('/content/tutorials/*slug', serveHandler)` or the wildcard swallows it.
- **Tests:** unit/lib tests run under `vitest run --project unit` (globs `test/**/*.test.{js,ts}`); smoke under `--project smoke`. In-memory DB setup: `await cds.deploy(path.join(process.cwd(),'db','schema.cds')).to('sqlite::memory:')` (a file path — NOT `cds.model`).

## Logical assert shape (used across tasks)

```js
// The in-memory shape the composition consumes. It is the #2259 AssertBlock
// minus the sidecar `index` field, with DB columns mapped back to logical names.
/** @typedef {{
 *   stepNumber:number, assertIndex:number, type:'cmd'|'http'|'file',
 *   run?:string, expectExit?:number,
 *   method?:string, path?:string, expectStatus?:number,
 *   filePath?:string, expectContains?:boolean,
 *   match?:string
 * }} LogicalAssert */
```

## Freshness stamp shape (used across tasks)

```js
/** @typedef {{ confidence:'high'|'medium'|'low'|'unknown',
 *   lastVerified:string|null, sourceCommit:string|null, jws:string|null }} FreshnessStamp */
```

---

### Task 1: Feature flag `SKILL_BUNDLE_ENABLED`

**Files:**
- Modify: `srv/lib/feature-flags/registry.js` (add entry after the `PROVENANCE_ENVELOPE_ENABLED` entry, ~line 324)
- Test: `test/unit/feature-flags-registry.test.js` if one exists asserting per-key shape; otherwise rely on the existing registry validator test.

**Interfaces:**
- Consumes: `featureFlagUpsert` helper already imported in `registry.js`.
- Produces: flag key `'SKILL_BUNDLE_ENABLED'`, `imsConfigKey:'flag.skill.bundle'`, read via `isFlagEnabled('SKILL_BUNDLE_ENABLED')`.

- [ ] **Step 1: Add the registry entry**

In `srv/lib/feature-flags/registry.js`, immediately after the `PROVENANCE_ENVELOPE_ENABLED` object:

```js
{
  key: 'SKILL_BUNDLE_ENABLED', label: 'Installable Skill bundle endpoint', category: 'Content',
  kind: 'db', imsConfigKey: 'flag.skill.bundle',
  valueType: 'boolean', default: false, status: 'dev-only',
  description: 'When true, serves an installable agent-Skill zip at '
    + '/content/tutorials/:slug/skill (SKILL.md procedure + verify.sh generated from assert '
    + 'blocks + provenance/freshness stamp). Public, anonymous, read-only over PUBLISHED '
    + 'tutorials. DB-driven config (ImsConfig key flag.skill.bundle); no env var. Default OFF (#2245).',
  howToChange: featureFlagUpsert('SKILL_BUNDLE_ENABLED', 'flag.skill.bundle'),
},
```

- [ ] **Step 2: Run the registry guard test to verify it still passes**

Run: `npx vitest run --project unit test/unit/feature-flags-registry.test.js` (if the file does not exist, run the whole unit tier's registry-related test: `npx vitest run --project unit -t "registry"`)
Expected: PASS (the new entry conforms to the schema; no duplicate key).

- [ ] **Step 3: Commit**

```bash
git add srv/lib/feature-flags/registry.js
git commit -m "feat(2245): register SKILL_BUNDLE_ENABLED feature flag"
```

---

### Task 2: `buildVerifyScript` + shell-quoting (pure)

**Files:**
- Create: `srv/lib/skill-bundle.js` (start the module with these two pure exports)
- Test: `test/unit/skill-bundle-compose.test.js`

**Interfaces:**
- Produces: `export function shquote(s: string): string` and `export function buildVerifyScript(asserts: LogicalAssert[]): string`.

- [ ] **Step 1: Write the failing tests**

Create `test/unit/skill-bundle-compose.test.js`:

```js
import { describe, it, expect } from 'vitest';
import { buildVerifyScript, shquote } from '../../srv/lib/skill-bundle.js';

describe('shquote', () => {
  it('wraps in single quotes and escapes embedded single quotes', () => {
    expect(shquote(`a'b`)).toBe(`'a'\\''b'`);
    expect(shquote('cds compile')).toBe(`'cds compile'`);
  });
});

describe('buildVerifyScript', () => {
  it('emits a bash header with strict mode', () => {
    const s = buildVerifyScript([]);
    expect(s.startsWith('#!/usr/bin/env bash\n')).toBe(true);
    expect(s).toContain('set -euo pipefail');
  });

  it('empty asserts → notice + exit 0', () => {
    const s = buildVerifyScript([]);
    expect(s).toContain('No automated checks defined');
    expect(s.trimEnd().endsWith('exit 0')).toBe(true);
  });

  it('cmd assert runs the command and checks exit code + optional match', () => {
    const s = buildVerifyScript([{ stepNumber: 1, assertIndex: 0, type: 'cmd', run: 'cds compile', expectExit: 0, match: 'ok' }]);
    expect(s).toContain(`'cds compile'`);
    expect(s).toContain('-eq 0');
    expect(s).toContain('grep -Eq');
  });

  it('http assert curls BASE_URL+path with method and checks status', () => {
    const s = buildVerifyScript([{ stepNumber: 2, assertIndex: 0, type: 'http', method: 'GET', path: '/foo', expectStatus: 200 }]);
    expect(s).toContain('BASE_URL="${BASE_URL:-http://localhost:4004}"');
    expect(s).toContain('-X GET');
    expect(s).toContain('${BASE_URL}/foo'.replace('/foo', "'/foo'").length ? '/foo' : '/foo'); // path is shell-quoted
    expect(s).toContain('200');
  });

  it('file exists vs contains', () => {
    const exists = buildVerifyScript([{ stepNumber: 3, assertIndex: 0, type: 'file', filePath: 'a.cds', expectContains: false }]);
    expect(exists).toContain('test -f');
    expect(exists).not.toContain('grep -Eq');
    const contains = buildVerifyScript([{ stepNumber: 3, assertIndex: 0, type: 'file', filePath: 'a.cds', expectContains: true, match: 'service' }]);
    expect(contains).toContain('grep -Eq');
  });

  it('preserves (stepNumber, assertIndex) order and fails overall when any check fails', () => {
    const s = buildVerifyScript([
      { stepNumber: 1, assertIndex: 0, type: 'cmd', run: 'a', expectExit: 0 },
      { stepNumber: 1, assertIndex: 1, type: 'cmd', run: 'b', expectExit: 0 },
    ]);
    expect(s.indexOf("'a'")).toBeLessThan(s.indexOf("'b'"));
    expect(s).toContain('exit 1');
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run --project unit test/unit/skill-bundle-compose.test.js`
Expected: FAIL — cannot resolve `../../srv/lib/skill-bundle.js` (module not created yet).

- [ ] **Step 3: Implement the two functions**

Create `srv/lib/skill-bundle.js`:

```js
// srv/lib/skill-bundle.js
// GET /content/tutorials/:slug/skill — composes an installable agent Skill
// (SKILL.md + verify.sh) as a zip. Item 3 of #2245. Pure composition first,
// data + handler wiring below.

const DEFAULT_BASE_URL = 'http://localhost:4004';

/** POSIX single-quote escape: a'b -> 'a'\''b' */
export function shquote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

/** Build a runnable bash verifier from the tutorial's assert specs. */
export function buildVerifyScript(asserts) {
  const hasHttp = asserts.some((a) => a.type === 'http');
  const L = [];
  L.push('#!/usr/bin/env bash');
  L.push('# Generated by SAP Tutorials — verifies this Skill against SAP\'s official steps.');
  L.push('set -euo pipefail');
  L.push('');
  if (hasHttp) L.push('BASE_URL="${BASE_URL:-' + DEFAULT_BASE_URL + '}"');
  L.push('fails=0');
  L.push('check() { if [ "$1" -eq 0 ]; then echo "  PASS: $2"; else echo "  FAIL: $2"; fails=$((fails+1)); fi; }');
  L.push('');

  if (asserts.length === 0) {
    L.push('echo "No automated checks defined for this tutorial."');
    L.push('exit 0');
    return L.join('\n') + '\n';
  }

  for (const a of asserts) {
    const label = shquote(`step ${a.stepNumber} assert ${a.assertIndex} (${a.type})`);
    L.push(`echo "Running check for ${a.type} @ step ${a.stepNumber}.${a.assertIndex}"`);
    if (a.type === 'cmd') {
      L.push('out=$(' + a.run + ' 2>&1) && rc=$? || rc=$?');
      L.push(`if [ "$rc" -eq ${Number(a.expectExit)} ]; then ok=0; else ok=1; fi`);
      if (a.match) L.push(`if [ "$ok" -eq 0 ] && ! printf '%s' "$out" | grep -Eq -- ${shquote(a.match)}; then ok=1; fi`);
      L.push(`check "$ok" ${label}`);
    } else if (a.type === 'http') {
      L.push(`body=$(mktemp)`);
      L.push(`code=$(curl -s -o "$body" -w '%{http_code}' -X ${a.method} "${'${BASE_URL}'}"${shquote(a.path)} || echo 000)`);
      L.push(`if [ "$code" = ${shquote(String(a.expectStatus))} ]; then ok=0; else ok=1; fi`);
      if (a.match) L.push(`if [ "$ok" -eq 0 ] && ! grep -Eq -- ${shquote(a.match)} "$body"; then ok=1; fi`);
      L.push(`rm -f "$body"`);
      L.push(`check "$ok" ${label}`);
    } else if (a.type === 'file') {
      if (a.expectContains) {
        L.push(`if [ -f ${shquote(a.filePath)} ] && grep -Eq -- ${shquote(a.match || '')} ${shquote(a.filePath)}; then ok=0; else ok=1; fi`);
      } else {
        L.push(`if test -f ${shquote(a.filePath)}; then ok=0; else ok=1; fi`);
      }
      L.push(`check "$ok" ${label}`);
    }
    L.push('');
  }

  L.push('if [ "$fails" -gt 0 ]; then echo "$fails check(s) failed."; exit 1; fi');
  L.push('echo "All checks passed."');
  return L.join('\n') + '\n';
}
```

> Note: fix the deliberately-awkward `path is shell-quoted` assertion in Step 1 to a plain
> `expect(s).toContain(shquote('/foo'))` once you import `shquote` — keep the test readable.

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run --project unit test/unit/skill-bundle-compose.test.js`
Expected: PASS (all `buildVerifyScript`/`shquote` cases).

- [ ] **Step 5: Commit**

```bash
git add srv/lib/skill-bundle.js test/unit/skill-bundle-compose.test.js
git commit -m "feat(2245): generate verify.sh from assert specs"
```

---

### Task 3: `buildSkillMd` (pure)

**Files:**
- Modify: `srv/lib/skill-bundle.js` (add export)
- Test: `test/unit/skill-bundle-compose.test.js` (add a `describe`)

**Interfaces:**
- Consumes: `gray-matter` (default import), the `FreshnessStamp` typedef.
- Produces: `export function buildSkillMd({ slug, source, asserts, stamp }): string` — `source` is the raw tutorial markdown (with frontmatter), `asserts: LogicalAssert[]`, `stamp: FreshnessStamp`.

- [ ] **Step 1: Write the failing tests**

Append to `test/unit/skill-bundle-compose.test.js`:

```js
import { buildSkillMd } from '../../srv/lib/skill-bundle.js';

const SRC = `---\ntitle: Create a CAP Service\ndescription: Build and run a CAP service.\n---\n\n## Step 1\nDo the thing.\n`;

describe('buildSkillMd', () => {
  it('emits YAML frontmatter with name (slug) and description (from source)', () => {
    const md = buildSkillMd({ slug: 'create-cap-service', source: SRC, asserts: [], stamp: { confidence: 'high', lastVerified: '2026-09-01', sourceCommit: 'abc123', jws: null } });
    expect(md).toMatch(/^---\n/);
    expect(md).toContain('name: create-cap-service');
    expect(md).toContain('Create a CAP Service'); // description carried from source title/description
  });

  it('includes the procedure body (source minus frontmatter)', () => {
    const md = buildSkillMd({ slug: 's', source: SRC, asserts: [], stamp: { confidence: 'unknown', lastVerified: null, sourceCommit: null, jws: null } });
    expect(md).toContain('Do the thing.');
    expect(md).not.toContain('title: Create a CAP Service'); // frontmatter not duplicated into body
  });

  it('provenance section reflects the stamp and states check count', () => {
    const md = buildSkillMd({ slug: 's', source: SRC, asserts: [{ stepNumber: 1, assertIndex: 0, type: 'cmd', run: 'x', expectExit: 0 }], stamp: { confidence: 'medium', lastVerified: '2026-08-01', sourceCommit: 'deadbeef', jws: null } });
    expect(md).toContain('confidence: medium');
    expect(md).toContain('2026-08-01');
    expect(md).toContain('deadbeef');
    expect(md).toContain('1'); // one bundled check
  });

  it('includes the JWS fenced block only when present', () => {
    const withJws = buildSkillMd({ slug: 's', source: SRC, asserts: [], stamp: { confidence: 'high', lastVerified: '2026-09-01', sourceCommit: 'abc', jws: 'eyJ.sig' } });
    expect(withJws).toContain('eyJ.sig');
    const without = buildSkillMd({ slug: 's', source: SRC, asserts: [], stamp: { confidence: 'unknown', lastVerified: null, sourceCommit: null, jws: null } });
    expect(without).not.toContain('```jws');
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run --project unit test/unit/skill-bundle-compose.test.js -t buildSkillMd`
Expected: FAIL — `buildSkillMd` is not exported.

- [ ] **Step 3: Implement `buildSkillMd`**

Add to `srv/lib/skill-bundle.js` (top: `import matter from 'gray-matter';`):

```js
export function buildSkillMd({ slug, source, asserts, stamp }) {
  let title = slug;
  let description = '';
  let body = String(source || '');
  try {
    const parsed = matter(String(source || ''));
    title = parsed.data.title || slug;
    description = parsed.data.description || '';
    body = parsed.content.trim();
  } catch {
    body = String(source || '').trim();
  }
  // single-line, quote-safe description for YAML
  const desc = `${title}${description ? ' — ' + description : ''}`.replace(/\s+/g, ' ').replace(/"/g, "'").trim();

  const fm = ['---', `name: ${slug}`, `description: "${desc}"`, '---', ''].join('\n');

  const n = asserts.length;
  const verifyLine = asserts.some((a) => a.type === 'http')
    ? 'Run `BASE_URL=<your-server> bash verify.sh` to check your work.'
    : 'Run `bash verify.sh` to check your work.';

  const provenance = [
    '## Provenance & freshness',
    '',
    `- confidence: ${stamp.confidence}`,
    `- last-verified: ${stamp.lastVerified || 'unknown'}`,
    `- source-commit: ${stamp.sourceCommit || 'unknown'}`,
    '- source: sap-tutorials/Tutorials',
  ];
  if (stamp.jws) {
    provenance.push('', 'Signed attestation (verify against the JWKS at `/.well-known/tutorial-provenance/jwks.json`):', '', '```jws', stamp.jws, '```');
  }

  const verify = [
    '## Verifying this Skill',
    '',
    n === 0
      ? 'No automated checks are bundled with this tutorial. Follow the procedure above.'
      : `${n} automated check(s) are bundled in \`verify.sh\`. ${verifyLine}`,
  ];

  return [fm, `# ${title}`, '', body, '', verify.join('\n'), '', provenance.join('\n'), ''].join('\n');
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run --project unit test/unit/skill-bundle-compose.test.js`
Expected: PASS (both `buildVerifyScript` and `buildSkillMd` groups).

- [ ] **Step 5: Commit**

```bash
git add srv/lib/skill-bundle.js test/unit/skill-bundle-compose.test.js
git commit -m "feat(2245): compose SKILL.md from tutorial source + stamp"
```

---

### Task 4: `loadAssertSpecs(slug)` data helper

**Files:**
- Modify: `srv/lib/skill-bundle.js` (add export)
- Test: `test/unit/skill-bundle-data.test.js`

**Interfaces:**
- Consumes: `cds.entities('com.sap.developers.ims')` → `Tutorials`, `AssertSpecs`.
- Produces: `export async function loadAssertSpecs(slug: string): Promise<LogicalAssert[]>` — ordered by `(stepNumber, assertIndex)`, DB columns remapped to logical names; `[]` on unknown slug or error.

- [ ] **Step 1: Write the failing test**

Create `test/unit/skill-bundle-data.test.js`:

```js
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import path from 'node:path';
import cds from '@sap/cds';
import { loadAssertSpecs } from '../../srv/lib/skill-bundle.js';

beforeAll(async () => {
  await cds.deploy(path.join(process.cwd(), 'db', 'schema.cds')).to('sqlite::memory:');
});

beforeEach(async () => {
  const { AssertSpecs, Tutorials } = cds.entities('com.sap.developers.ims');
  await DELETE.from(AssertSpecs);
  await DELETE.from(Tutorials);
  await INSERT.into(Tutorials).entries([{ ID: 'cccccccc-cccc-cccc-cccc-cccccccccccc', slug: 'tutorial-alpha', title: 'Alpha', status: 'ACTIVE' }]);
  await INSERT.into(AssertSpecs).entries([
    { tutorial_ID: 'cccccccc-cccc-cccc-cccc-cccccccccccc', stepNumber: 2, assertIndex: 0, assertType: 'http', httpMethod: 'GET', httpPath: '/foo', expectStatus: 200 },
    { tutorial_ID: 'cccccccc-cccc-cccc-cccc-cccccccccccc', stepNumber: 1, assertIndex: 1, assertType: 'cmd', run: 'b', expectExit: 0 },
    { tutorial_ID: 'cccccccc-cccc-cccc-cccc-cccccccccccc', stepNumber: 1, assertIndex: 0, assertType: 'cmd', run: 'a', expectExit: 0, matchRegex: 'ok' },
  ]);
});

describe('loadAssertSpecs', () => {
  it('returns [] for an unknown slug', async () => {
    expect(await loadAssertSpecs('nope')).toEqual([]);
  });

  it('orders by (stepNumber, assertIndex) and remaps columns to logical names', async () => {
    const specs = await loadAssertSpecs('tutorial-alpha');
    expect(specs.map((s) => `${s.stepNumber}.${s.assertIndex}`)).toEqual(['1.0', '1.1', '2.0']);
    expect(specs[0]).toMatchObject({ type: 'cmd', run: 'a', expectExit: 0, match: 'ok' });
    expect(specs[2]).toMatchObject({ type: 'http', method: 'GET', path: '/foo', expectStatus: 200 });
  });

  it('lowercases the slug before lookup', async () => {
    const specs = await loadAssertSpecs('TUTORIAL-ALPHA');
    expect(specs).toHaveLength(3);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run --project unit test/unit/skill-bundle-data.test.js`
Expected: FAIL — `loadAssertSpecs` not exported.

- [ ] **Step 3: Implement `loadAssertSpecs`**

Add to `srv/lib/skill-bundle.js` (top: `import cds from '@sap/cds';`):

```js
export async function loadAssertSpecs(slug) {
  try {
    const lc = String(slug || '').toLowerCase();
    const { Tutorials, AssertSpecs } = cds.entities('com.sap.developers.ims');
    const tut = await SELECT.one.from(Tutorials).columns('ID').where({ slug: lc });
    if (!tut) return [];
    const rows = await SELECT.from(AssertSpecs).where({ tutorial_ID: tut.ID }).orderBy('stepNumber', 'assertIndex');
    return rows.map((r) => ({
      stepNumber: r.stepNumber,
      assertIndex: r.assertIndex,
      type: r.assertType,
      run: r.run ?? undefined,
      expectExit: r.expectExit ?? undefined,
      method: r.httpMethod ?? undefined,
      path: r.httpPath ?? undefined,
      expectStatus: r.expectStatus ?? undefined,
      filePath: r.filePath ?? undefined,
      expectContains: typeof r.expectContains === 'boolean' ? r.expectContains : undefined,
      match: r.matchRegex ?? undefined,
    }));
  } catch (e) {
    console.warn('[skill-bundle] loadAssertSpecs fail-open:', e.message);
    return [];
  }
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run --project unit test/unit/skill-bundle-data.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add srv/lib/skill-bundle.js test/unit/skill-bundle-data.test.js
git commit -m "feat(2245): loadAssertSpecs reads + remaps AssertSpecs by slug"
```

---

### Task 5: `buildFreshnessStamp(slug, opts)` data helper

**Files:**
- Modify: `srv/lib/skill-bundle.js` (add export)
- Test: `test/lib/skill-bundle-endpoint.test.js` (created in Task 6 — but add a focused stamp `describe` here via injected deps; if executing strictly in order, put this test in `test/unit/skill-bundle-data.test.js` instead)

**Interfaces:**
- Consumes: `loadProvenanceInputs` from `./provenance-data.js`, `deriveConfidence` from `./provenance-freshness.js`, `buildEnvelope` from `./provenance-envelope.js` — all injectable for testing.
- Produces: `export function makeFreshnessStampLoader({ loadProvenanceInputs, deriveConfidence, buildEnvelope })` returning `async (slug, { provenanceEnabled }) => FreshnessStamp`; plus a default `export async function buildFreshnessStamp(slug, opts)` bound to the real deps.

- [ ] **Step 1: Write the failing test**

Add to `test/unit/skill-bundle-data.test.js`:

```js
import { makeFreshnessStampLoader } from '../../srv/lib/skill-bundle.js';

describe('freshness stamp', () => {
  const inputs = { contentHash: 'h', sourceCommit: 'sha1', builtAt: '2026-09-01', report: { status: 'DONE', runAt: '2026-09-01', openHighCount: 0 } };

  it('derives confidence + commit without a signing key, no jws when provenance disabled', async () => {
    const load = makeFreshnessStampLoader({
      loadProvenanceInputs: async () => inputs,
      deriveConfidence: () => 'high',
      buildEnvelope: async () => ({ jws: 'should.not.appear' }),
    });
    const stamp = await load('s', { provenanceEnabled: false });
    expect(stamp).toMatchObject({ confidence: 'high', sourceCommit: 'sha1', lastVerified: '2026-09-01', jws: null });
  });

  it('adds jws when provenance enabled and envelope builds', async () => {
    const load = makeFreshnessStampLoader({
      loadProvenanceInputs: async () => inputs,
      deriveConfidence: () => 'high',
      buildEnvelope: async () => ({ jws: 'eyJ.sig' }),
    });
    const stamp = await load('s', { provenanceEnabled: true });
    expect(stamp.jws).toBe('eyJ.sig');
  });

  it('fail-open to unknown when inputs are null', async () => {
    const load = makeFreshnessStampLoader({
      loadProvenanceInputs: async () => null,
      deriveConfidence: () => 'unknown',
      buildEnvelope: async () => null,
    });
    const stamp = await load('s', { provenanceEnabled: true });
    expect(stamp).toEqual({ confidence: 'unknown', lastVerified: null, sourceCommit: null, jws: null });
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run --project unit test/unit/skill-bundle-data.test.js -t "freshness stamp"`
Expected: FAIL — `makeFreshnessStampLoader` not exported.

- [ ] **Step 3: Implement**

Add to `srv/lib/skill-bundle.js`:

```js
import { loadProvenanceInputs as _loadProvenanceInputs } from './provenance-data.js';
import { deriveConfidence as _deriveConfidence } from './provenance-freshness.js';
import { buildEnvelope as _buildEnvelope } from './provenance-envelope.js';

export function makeFreshnessStampLoader({ loadProvenanceInputs, deriveConfidence, buildEnvelope }) {
  return async function loadStamp(slug, { provenanceEnabled }) {
    try {
      const inputs = await loadProvenanceInputs(String(slug || '').toLowerCase());
      if (!inputs) return { confidence: 'unknown', lastVerified: null, sourceCommit: null, jws: null };
      const confidence = deriveConfidence({ report: inputs.report, now: Date.now() });
      const lastVerified = inputs.report?.runAt || inputs.builtAt || null;
      let jws = null;
      if (provenanceEnabled) {
        try {
          const env = await buildEnvelope({ slug: String(slug).toLowerCase(), ...inputs });
          jws = env?.jws || null;
        } catch { jws = null; }
      }
      return { confidence, lastVerified, sourceCommit: inputs.sourceCommit || null, jws };
    } catch (e) {
      console.warn('[skill-bundle] freshness stamp fail-open:', e.message);
      return { confidence: 'unknown', lastVerified: null, sourceCommit: null, jws: null };
    }
  };
}

export const buildFreshnessStamp = (slug, opts) =>
  makeFreshnessStampLoader({
    loadProvenanceInputs: _loadProvenanceInputs,
    deriveConfidence: _deriveConfidence,
    buildEnvelope: _buildEnvelope,
  })(slug, opts);
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run --project unit test/unit/skill-bundle-data.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add srv/lib/skill-bundle.js test/unit/skill-bundle-data.test.js
git commit -m "feat(2245): freshness stamp (confidence + commit + optional jws)"
```

---

### Task 6: `createSkillBundleHandler` + zip streaming

**Files:**
- Modify: `srv/lib/skill-bundle.js` (add handler factory + default export)
- Test: `test/lib/skill-bundle-endpoint.test.js`

**Interfaces:**
- Consumes: `archiver` (`import archiver from 'archiver'`), `isFlagEnabled` from `./feature-flags/db-flags.js`, `getTutorialSource` from `./content-store.js`, plus `loadAssertSpecs`/`buildFreshnessStamp`/`buildSkillMd`/`buildVerifyScript` from this module — all injectable.
- Produces: `export function createSkillBundleHandler(deps = {}): (req, res) => Promise<void>` and `export const skillBundleHandler = createSkillBundleHandler()`.
- Response: `application/zip`, `Content-Disposition: attachment; filename="<slug>-skill.zip"`, entries `<slug>/SKILL.md` and `<slug>/verify.sh` (mode `0o755`).

- [ ] **Step 1: Write the failing tests**

Create `test/lib/skill-bundle-endpoint.test.js`:

```js
import { describe, it, expect } from 'vitest';
import { Writable } from 'node:stream';
import JSZip from 'jszip';
import { createSkillBundleHandler } from '../../srv/lib/skill-bundle.js';

// Collect the streamed zip into a buffer via a fake res that is a Writable.
function fakeRes() {
  const chunks = [];
  const res = new Writable({ write(c, _e, cb) { chunks.push(Buffer.from(c)); cb(); } });
  res.statusCode = 200;
  res.headers = {};
  res.setHeader = (k, v) => { res.headers[k.toLowerCase()] = v; };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.jsonBody = b; res.end(); return res; };
  res.buffer = () => Buffer.concat(chunks);
  return res;
}
const req = (slug) => ({ params: { slug } });

const baseDeps = {
  isFlagEnabled: () => true,
  getTutorialSource: async () => ({ markdown: `---\ntitle: T\ndescription: D\n---\n\n## Step 1\nBody.\n` }),
  loadAssertSpecs: async () => [{ stepNumber: 1, assertIndex: 0, type: 'cmd', run: 'x', expectExit: 0 }],
  buildFreshnessStamp: async () => ({ confidence: 'high', lastVerified: '2026-09-01', sourceCommit: 'abc', jws: null }),
  provenanceFlagKey: 'PROVENANCE_ENVELOPE_ENABLED',
};

describe('skill bundle handler', () => {
  it('404 when feature flag is off', async () => {
    const res = fakeRes();
    await createSkillBundleHandler({ ...baseDeps, isFlagEnabled: () => false })(req('t'), res);
    expect(res.statusCode).toBe(404);
  });

  it('404 when the slug has no source markdown', async () => {
    const res = fakeRes();
    await createSkillBundleHandler({ ...baseDeps, getTutorialSource: async () => ({ markdown: null }) })(req('nope'), res);
    expect(res.statusCode).toBe(404);
  });

  it('200 streams a zip with SKILL.md and verify.sh', async () => {
    const res = fakeRes();
    await createSkillBundleHandler(baseDeps)(req('my-tutorial'), res);
    await new Promise((r) => res.on('finish', r));
    expect(res.headers['content-type']).toContain('application/zip');
    expect(res.headers['content-disposition']).toContain('my-tutorial-skill.zip');
    const zip = await JSZip.loadAsync(res.buffer());
    expect(zip.file('my-tutorial/SKILL.md')).toBeTruthy();
    const verify = await zip.file('my-tutorial/verify.sh').async('string');
    expect(verify).toContain('#!/usr/bin/env bash');
    expect(verify).toContain("'x'");
    const skill = await zip.file('my-tutorial/SKILL.md').async('string');
    expect(skill).toContain('name: my-tutorial');
    expect(skill).toContain('confidence: high');
  });

  it('still ships (degraded) when provenance/asserts are empty', async () => {
    const res = fakeRes();
    await createSkillBundleHandler({ ...baseDeps, loadAssertSpecs: async () => [], buildFreshnessStamp: async () => ({ confidence: 'unknown', lastVerified: null, sourceCommit: null, jws: null }) })(req('t'), res);
    await new Promise((r) => res.on('finish', r));
    const zip = await JSZip.loadAsync(res.buffer());
    const verify = await zip.file('t/verify.sh').async('string');
    expect(verify).toContain('No automated checks defined');
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run --project unit test/lib/skill-bundle-endpoint.test.js`
Expected: FAIL — `createSkillBundleHandler` not exported.

- [ ] **Step 3: Implement the handler**

Add to `srv/lib/skill-bundle.js` (top: `import archiver from 'archiver';`, `import { isFlagEnabled as _isFlagEnabled } from './feature-flags/db-flags.js';`, `import { getTutorialSource as _getTutorialSource } from './content-store.js';`):

```js
const VALID_SLUG = /^[a-z0-9]+(?:[-/][a-z0-9]+)*$/;

export function createSkillBundleHandler(deps = {}) {
  const {
    isFlagEnabled = _isFlagEnabled,
    getTutorialSource = _getTutorialSource,
    loadAssertSpecs: _load = loadAssertSpecs,
    buildFreshnessStamp: _stamp = buildFreshnessStamp,
    provenanceFlagKey = 'PROVENANCE_ENVELOPE_ENABLED',
  } = deps;

  return async function handler(req, res) {
    if (!isFlagEnabled('SKILL_BUNDLE_ENABLED')) return res.status(404).end();

    const raw = Array.isArray(req.params?.slug) ? req.params.slug.join('/') : req.params?.slug;
    const slug = String(raw || '').replace(/\/$/, '').toLowerCase();
    if (!slug || !VALID_SLUG.test(slug)) return res.status(404).json({ error: 'not_found' });

    const src = await getTutorialSource(slug);
    if (!src || !src.markdown) return res.status(404).json({ error: 'not_found' });

    const [asserts, stamp] = await Promise.all([
      _load(slug),
      _stamp(slug, { provenanceEnabled: isFlagEnabled(provenanceFlagKey) }),
    ]);

    const skillMd = buildSkillMd({ slug, source: src.markdown, asserts, stamp });
    const verifySh = buildVerifyScript(asserts);

    res.status(200);
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${slug.replace(/\//g, '-')}-skill.zip"`);
    res.setHeader('Cache-Control', 'public, max-age=60, s-maxage=600');

    const archive = archiver('zip', { zlib: { level: 9 } });
    archive.on('error', (err) => {
      console.error('[skill-bundle] archive error:', err.message);
      if (!res.headersSent) res.status(500).end(); else res.destroy(err);
    });
    archive.pipe(res);
    const dir = slug.replace(/\//g, '-');
    archive.append(skillMd, { name: `${dir}/SKILL.md` });
    archive.append(verifySh, { name: `${dir}/verify.sh`, mode: 0o755 });
    await archive.finalize();
  };
}

export const skillBundleHandler = createSkillBundleHandler();
```

> Note: `getTutorialSource` lowercases internally too, but we canonicalize here so the zip
> dir name and `Content-Disposition` are stable. `VALID_SLUG` mirrors `content-store.js`.

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run --project unit test/lib/skill-bundle-endpoint.test.js`
Expected: PASS (4 cases).

- [ ] **Step 5: Run the full compose/data/endpoint set + lint**

Run: `npx vitest run --project unit test/unit/skill-bundle-compose.test.js test/unit/skill-bundle-data.test.js test/lib/skill-bundle-endpoint.test.js`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add srv/lib/skill-bundle.js test/lib/skill-bundle-endpoint.test.js
git commit -m "feat(2245): skill bundle handler streams SKILL.md + verify.sh zip"
```

---

### Task 7: Wire the route in `srv/server.js`

**Files:**
- Modify: `srv/server.js` (import + route registration inside the `cds.on('bootstrap', (app) => {...})` block)
- Test: `test/smoke/express-route-mutations.test.js` (extend the registered-route assertion set)

**Interfaces:**
- Consumes: `skillBundleHandler` from `./lib/skill-bundle.js`.
- Produces: registered route `GET /content/tutorials/:slug/skill`, positioned before `app.get('/content/tutorials/*slug', serveHandler)`.

- [ ] **Step 1: Locate the provenance route registration**

Run: `grep -n "provenanceHandler\|/content/tutorials/\*slug\|/content/tutorials/:slug/provenance" srv/server.js`
Expected: shows the `app.get('/content/tutorials/:slug/provenance', provenanceHandler)` line registered before the `*slug` wildcard.

- [ ] **Step 2: Add the import**

Near the other `srv/lib` imports at the top of `srv/server.js`:

```js
import { skillBundleHandler } from './lib/skill-bundle.js';
```

- [ ] **Step 3: Register the route (immediately after the `/provenance` route)**

```js
app.get('/content/tutorials/:slug/skill', skillBundleHandler);
```

- [ ] **Step 4: Extend the route-mutation smoke test**

In `test/smoke/express-route-mutations.test.js`, add `'GET /content/tutorials/:slug/skill'` to the expected-registered-routes set (match how `/provenance` is asserted there).

- [ ] **Step 5: Run the route smoke test**

Run: `npx vitest run --project smoke test/smoke/express-route-mutations.test.js`
Expected: PASS (new route present, registered before the wildcard).

- [ ] **Step 6: Commit**

```bash
git add srv/server.js test/smoke/express-route-mutations.test.js
git commit -m "feat(2245): register GET /content/tutorials/:slug/skill route"
```

---

### Task 8: Route-drift guard allowlist entry

**Files:**
- Modify: `scripts/check-srv-qa-route-drift.ts` (`ALLOWLIST_ONLY_ON_SRV`, ~line 73)
- Test: `test/unit/check-srv-qa-route-drift.test.ts` (verify guard passes; extend if it enumerates allowlist keys)

**Interfaces:**
- Consumes: nothing new.
- Produces: allowlist key `'GET /content/tutorials/:slug/skill'`.

- [ ] **Step 1: Add the allowlist entry**

In `scripts/check-srv-qa-route-drift.ts`, inside `ALLOWLIST_ONLY_ON_SRV`, after the `/provenance` entry:

```ts
  'GET /content/tutorials/:slug/skill':
    'Installable Skill bundle (#2245) — an anonymous, public, read-only prod content ' +
    'surface that streams a zip (SKILL.md + verify.sh from assert blocks + provenance stamp) ' +
    'over PUBLISHED tutorials. Feature-flagged (SKILL_BUNDLE_ENABLED, DB config, default OFF, ' +
    'DEV-first) and fail-open. Not a QA-channel surface: srv-qa serves tutorials behind ' +
    'requireAuthorScope (author-draft preview) and the Skill bundle is meaningful only for ' +
    'published content. Mirror of the /provenance allowlist rationale.',
```

- [ ] **Step 2: Run the drift-guard test**

Run: `npx vitest run --project unit test/unit/check-srv-qa-route-drift.test.ts`
Expected: PASS (the new srv-only route is allowlisted; guard reports no drift).

- [ ] **Step 3: Commit**

```bash
git add scripts/check-srv-qa-route-drift.ts
git commit -m "feat(2245): allowlist /skill as srv-only in route-drift guard"
```

---

### Task 9: Full-suite verification + PR

**Files:** none (verification + PR).

- [ ] **Step 1: Run the whole unit tier**

Run: `npm test`
Expected: PASS (no regressions; new skill-bundle tests included).

- [ ] **Step 2: Run the route smoke test once more**

Run: `npx vitest run --project smoke test/smoke/express-route-mutations.test.js`
Expected: PASS.

- [ ] **Step 3: Confirm no new dependency crept in**

Run: `git diff origin/DEV -- package.json package-lock.json`
Expected: EMPTY (archiver/gray-matter/jszip were already declared).

- [ ] **Step 4: Push and open a PR targeting DEV**

```bash
git push -u origin feat/skill-bundle-2245
gh pr create --repo sap-tutorials/tutorials-ims --base DEV --head feat/skill-bundle-2245 \
  --title "feat(2245): installable Skill bundle endpoint (item 3)" \
  --body "Implements item 3 of #2245: GET /content/tutorials/:slug/skill streams an installable agent Skill (SKILL.md + verify.sh from assert blocks + provenance stamp) as a zip. Public, gated by SKILL_BUNDLE_ENABLED (DB flag, default OFF). Builds on #2256 (provenance) and #2259 (assert blocks). Spec: docs/superpowers/specs/2026-09-11-skill-bundle-endpoint-design.md"
```

---

## Self-Review

**Spec coverage:**
- Route + registration before wildcard → Task 7. ✅
- Feature flag `SKILL_BUNDLE_ENABLED`, 404 fail-closed → Task 1 + Task 6 Step 3. ✅
- `getTutorialSource` → 404 on missing → Task 6. ✅
- `loadAssertSpecs` direct entity read + column remap → Task 4. ✅
- Freshness stamp (confidence/date/commit, JWS only when provenance on) → Task 5. ✅
- `buildSkillMd` (frontmatter name/description, procedure body, provenance section) → Task 3. ✅
- `buildVerifyScript` (cmd/http/file, empty→exit 0, shell-quoting, ordering) → Task 2. ✅
- Zip via archiver, `application/zip` + `Content-Disposition` → Task 6. ✅
- Error-handling table (flag/slug/fail-open/stream error) → Tasks 6 (handler) + 2/4/5 (fail-open). ✅
- Drift-guard allowlist → Task 8. ✅
- Testing (compose unit, endpoint via jszip, route smoke, drift guard) → Tasks 2/3/4/5/6/7/8. ✅
- "No new dependency" verification → Task 9 Step 3. ✅

**Placeholder scan:** No TBD/TODO. The one awkward assertion in Task 2 Step 1 is flagged with an explicit fix instruction (use `shquote('/foo')`). No "similar to Task N" — code is repeated where read out of order.

**Type consistency:** `LogicalAssert` fields (`type`, `method`, `path`, `match`, `stepNumber`, `assertIndex`, `expectExit`, `expectStatus`, `filePath`, `expectContains`, `run`) are consistent across `loadAssertSpecs` (Task 4), `buildVerifyScript` (Task 2), `buildSkillMd` (Task 3), and endpoint deps (Task 6). `FreshnessStamp` (`confidence`, `lastVerified`, `sourceCommit`, `jws`) consistent across Tasks 3, 5, 6. Handler dep names (`isFlagEnabled`, `getTutorialSource`, `loadAssertSpecs`, `buildFreshnessStamp`, `provenanceFlagKey`) consistent between the factory (Task 6 Step 3) and its tests (Task 6 Step 1).
