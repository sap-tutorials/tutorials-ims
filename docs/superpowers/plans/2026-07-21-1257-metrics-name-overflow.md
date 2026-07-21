# #1257 Metric Name Overflow Fix — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop metric emitters from baking per-tick values into metric names, which overflows the `MetricSnapshots.metric` `String(64)` primary key and explodes cardinality; add a library-level guard + per-row insert fallback so this class of bug can never again silently drop a whole rollup tick.

**Architecture:** Three layers. (1) Correct 5 emitter callsites — keep low-cardinality dimensions in the name (`[result=hit]`), move additive counts to their own dotted counters. (2) Extend `metrics.counter(name, n=1)` to increment by N. (3) Two defenses — a 64-char ingestion guard in `metrics.js`, and a per-row insert fallback in the rollup job.

**Tech Stack:** Node.js ESM, `@sap/cds` (CAP 10), Vitest (`--project unit`).

## Global Constraints

- **`metric` column is `key String(64)`** — a HANA primary key (`db/schema.cds:997`). Every emitted metric name MUST be ≤ 64 chars. Copy this literal into the guard as `MAX_NAME_LEN = 64`.
- **No schema/DB change** — do NOT widen the column, do NOT touch `db/**`, do NOT run `cds build`. Pure srv JS.
- **`metrics.js` public calls never throw to the caller** — all paths funnel to the rate-limited `warn()` (module contract, `srv/lib/metrics.js:16-19`).
- **Metric naming convention** (`docs/developers/architecture/observability.md`): dotted namespaces `subsystem.what.kind`; keep distinct names low. Dimensions may use `[key=value]` only for **bounded low-cardinality** keys (e.g. `result=hit`); never interpolate counts or unbounded ids.
- **Run unit tests with:** `npx vitest run --project unit <file>` from the worktree root. Bare `vitest <file>` skips project config.
- **Work happens in the worktree** `.claude/worktrees/fix-1257-metrics-name-overflow` on branch `worktree-fix-1257-metrics-name-overflow`. Commit from there (pre-commit hook blocks feature-branch commits in the primary tree).

---

## File Structure

- `srv/lib/metrics.js` — MODIFY: `counter(name, n=1)` + `MAX_NAME_LEN=64` guard on `counter`/`gauge`/`observe`.
- `srv/lib/__tests__/metrics.test.js` — MODIFY: new cases for increment-by-N + over-length guard.
- `srv/lib/community-blogs-classifier.js` — MODIFY: `:271-273` → 4 dotted counters.
- `srv/lib/community-blogs-fetcher.js` — MODIFY: `:176`, `:182`, `:192`, `:225-227` → drop `source=`/values.
- `srv/homepage-service.js` — MODIFY: `:535` → drop `count=`.
- `test/unit/community-blogs-classifier.test.js` — MODIFY: assert emitted names ≤ 64 + no value labels.
- `test/unit/community-blogs-fetcher.test.js` — MODIFY: assert emitted names ≤ 64 + no value labels.
- `srv/jobs/metrics-rollup-job.js` — MODIFY: per-row fallback on non-collision batch failure.
- `test/unit/metrics-rollup-job.test.js` — CREATE: batch-failure salvage + collision regression.
- `docs/developers/architecture/observability.md` — MODIFY: catalog rows + guard note.

---

### Task 1: Extend `counter(name, n)` + add 64-char ingestion guard in metrics.js

**Files:**
- Modify: `srv/lib/metrics.js`
- Test: `srv/lib/__tests__/metrics.test.js`

**Interfaces:**
- Consumes: nothing (leaf module).
- Produces: `counter(name: string, n?: number)` — increments named counter by `n` (default 1); no-op+warn on non-string/empty name, name length > 64, or non-finite/negative `n`. `gauge(name, value)` and `observe(name, value)` additionally no-op+warn when name length > 64. Exports unchanged otherwise.

- [ ] **Step 1: Write the failing tests**

Add to `srv/lib/__tests__/metrics.test.js`, inside the existing `describe('metrics module (counters + gauges)', ...)` block (after the first `counter()` test, ~line 16):

```js
  it('counter(name, n) increments by n', () => {
    metrics.counter('bulk', 5);
    metrics.counter('bulk', 3);
    expect(metrics.snapshot().counters.bulk).toBe(8);
  });

  it('counter(name) still defaults to +1', () => {
    metrics.counter('one');
    metrics.counter('one');
    expect(metrics.snapshot().counters.one).toBe(2);
  });

  it('counter(name, 0) records the series at 0', () => {
    metrics.counter('zeroed', 0);
    expect(metrics.snapshot().counters.zeroed).toBe(0);
  });

  it('counter with invalid n does not throw and leaves counter unset', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(() => metrics.counter('bad', Number.NaN)).not.toThrow();
    expect(() => metrics.counter('bad2', -3)).not.toThrow();
    expect(() => metrics.counter('bad3', 'x')).not.toThrow();
    const snap = metrics.snapshot();
    expect(snap.counters.bad).toBeUndefined();
    expect(snap.counters.bad2).toBeUndefined();
    expect(snap.counters.bad3).toBeUndefined();
    warnSpy.mockRestore();
  });

  it('rejects a metric name longer than 64 chars (counter/gauge/observe) — no throw, absent from snapshot', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const tooLong = 'x'.repeat(65);
    expect(() => metrics.counter(tooLong)).not.toThrow();
    expect(() => metrics.gauge(tooLong, 1)).not.toThrow();
    expect(() => metrics.observe(tooLong, 1)).not.toThrow();
    const snap = metrics.snapshot();
    expect(snap.counters[tooLong]).toBeUndefined();
    expect(snap.gauges[tooLong]).toBeUndefined();
    expect(snap.histograms[tooLong]).toBeUndefined();
    warnSpy.mockRestore();
  });

  it('accepts a metric name of exactly 64 chars', () => {
    const exactly64 = 'y'.repeat(64);
    metrics.counter(exactly64);
    expect(metrics.snapshot().counters[exactly64]).toBe(1);
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run --project unit srv/lib/__tests__/metrics.test.js`
Expected: FAIL — `counter(name, n)` currently ignores `n` (bulk === 2 not 8); over-length names are currently accepted.

- [ ] **Step 3: Implement the changes**

In `srv/lib/metrics.js`, add the constant near the top (after the `histograms` Map declaration, ~line 26):

```js
// Mirrors MetricSnapshots.metric — key String(64) in db/schema.cds. Names longer
// than this overflow the HANA primary-key column and (pre-#1257) failed the whole
// rollup batch. Guard at ingestion so one bad name drops only itself.
const MAX_NAME_LEN = 64;
```

Replace the `counter` function (lines 41-47) with:

```js
export function counter(name, n = 1) {
  try {
    if (isDisabled()) return;
    if (typeof name !== 'string' || !name) throw new Error(`invalid counter name: ${name}`);
    if (name.length > MAX_NAME_LEN) throw new Error(`metric name too long (${name.length} > ${MAX_NAME_LEN}): ${name}`);
    if (typeof n !== 'number' || !isFinite(n) || n < 0) throw new Error(`invalid counter increment: ${n}`);
    counters.set(name, (counters.get(name) || 0) + n);
  } catch (err) { warn(err.message); }
}
```

In `gauge` (after its existing name check, ~line 52) add:
```js
    if (name.length > MAX_NAME_LEN) throw new Error(`metric name too long (${name.length} > ${MAX_NAME_LEN}): ${name}`);
```

In `observe` (after its existing name check, ~line 76) add the same line:
```js
    if (name.length > MAX_NAME_LEN) throw new Error(`metric name too long (${name.length} > ${MAX_NAME_LEN}): ${name}`);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run --project unit srv/lib/__tests__/metrics.test.js`
Expected: PASS (all cases, including the pre-existing ones).

- [ ] **Step 5: Commit**

```bash
git add srv/lib/metrics.js srv/lib/__tests__/metrics.test.js
git commit -m "feat(#1257): counter(name,n) increment + 64-char metric-name ingestion guard"
```

---

### Task 2: Fix the classifier emitter (the 91-char offender)

**Files:**
- Modify: `srv/lib/community-blogs-classifier.js:271-273`
- Test: `test/unit/community-blogs-classifier.test.js`

**Interfaces:**
- Consumes: `metrics.counter(name, n)` from Task 1.
- Produces: on drain, emits counters `homepage.community_blogs.classifier.drained`, `.ok`, `.parse_error`, `.aicore_error` (each incremented by the matching `summary.*` count). The old `…classifier[result=drained,drained=…]` name is gone.

- [ ] **Step 1: Write the failing test**

Add a new `describe` block at the end of `test/unit/community-blogs-classifier.test.js`. The file already calls `cds.test('serve', ...)` and imports `classifyPendingBatch`.

Add these two imports alongside the existing ones (the `vitest` import at line 8 currently lacks `vi` — add it; and add the metrics module):
```js
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import * as metrics from '../../srv/lib/metrics.js';
```

New block at end of file:
```js
describe('#1257 classifier metric names', () => {
  it('emits only bounded dotted counters — every name ≤ 64 chars, no value labels', async () => {
    const spy = vi.spyOn(metrics, 'counter');
    // Disabled path is the cheapest drain that still emits a classifier metric.
    const orig = process.env.COMMUNITY_BLOGS_CLASSIFIER_ENABLED;
    process.env.COMMUNITY_BLOGS_CLASSIFIER_ENABLED = 'false';
    try {
      await classifyPendingBatch();
    } finally {
      if (orig === undefined) delete process.env.COMMUNITY_BLOGS_CLASSIFIER_ENABLED;
      else process.env.COMMUNITY_BLOGS_CLASSIFIER_ENABLED = orig;
    }
    const names = spy.mock.calls.map((c) => c[0]);
    expect(names.length).toBeGreaterThan(0);
    for (const n of names) {
      expect(n.length).toBeLessThanOrEqual(64);
      expect(n).toMatch(/^[a-z0-9_.]+(\[[a-z0-9_=]+\])?$/);
      expect(n).not.toMatch(/=\d/); // no numeric value baked into the name
    }
    spy.mockRestore();
  });
});
```

> Import `vi` — extend the existing `vitest` import at line 8 to include `vi`.

- [ ] **Step 2: Run test to verify current state**

Run: `npx vitest run --project unit test/unit/community-blogs-classifier.test.js -t "#1257"`
Expected: The disabled path currently emits `homepage.community_blogs.classifier[result=disabled]` (line 203) which is ≤ 64 and has no `=\d`, so this specific assertion may PASS on the disabled branch. To make the test prove the drained path, ALSO assert the drained-branch names directly in Step 3's verification. If the disabled emit already satisfies the regex, harden the test by additionally unit-checking the drained names (see Step 3 note).

- [ ] **Step 3: Implement the fix**

In `srv/lib/community-blogs-classifier.js`, replace lines 271-273:

```js
  metrics.counter(
    `homepage.community_blogs.classifier[result=drained,drained=${summary.drained},ok=${summary.ok},parse_error=${summary.parseError},aicore_error=${summary.aicoreError}]`
  );
```

with:

```js
  metrics.counter('homepage.community_blogs.classifier.drained', summary.drained);
  metrics.counter('homepage.community_blogs.classifier.ok', summary.ok);
  metrics.counter('homepage.community_blogs.classifier.parse_error', summary.parseError);
  metrics.counter('homepage.community_blogs.classifier.aicore_error', summary.aicoreError);
```

Also change the disabled-branch emit at line 203 for consistency (it already fits, but align to the dotted style — OPTIONAL, keep `[result=disabled]` since `result` is a bounded dimension). Leave line 203 as-is.

> Drained-path coverage: to prove the drained names without a full LLM drain, add a second `it` that imports the summary-emitting behavior is covered by the metrics-name regex above once the classifier is enabled with an empty pending set (drains 0). If enabling requires an LLM client, the existing enabled-path tests in this file already seed a fake client — slot the spy into one of those existing `it`s instead and assert the four `.drained/.ok/.parse_error/.aicore_error` names appear. Prefer extending an existing enabled-path test over booting a new drain.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run --project unit test/unit/community-blogs-classifier.test.js`
Expected: PASS (new #1257 block + all pre-existing tests).

- [ ] **Step 5: Commit**

```bash
git add srv/lib/community-blogs-classifier.js test/unit/community-blogs-classifier.test.js
git commit -m "fix(#1257): classifier emits bounded dotted counters, not a 91-char name"
```

---

### Task 3: Fix the fetcher emitters (drop source= and values)

**Files:**
- Modify: `srv/lib/community-blogs-fetcher.js:176`, `:182`, `:192`, `:225-227`
- Test: `test/unit/community-blogs-fetcher.test.js`

**Interfaces:**
- Consumes: `metrics.counter(name, n)` from Task 1.
- Produces: fetch emits `homepage.community_blogs.fetch[result=hit|fetch_error|parse_error]` (bounded) + `homepage.community_blogs.fetch.inserted` / `.updated` counters (incremented by N). No `source=` or unbounded id in any name.

- [ ] **Step 1: Write the failing test**

`test/unit/community-blogs-fetcher.test.js` already imports `fetchOneSource` + `vi`, boots `cds.test('serve', ...)`, and exercises fetch via `await fetchOneSource(source, { db })` with a `global.fetch` stub (see the existing `describe('fetchOneSource', ...)` block, ~line 76, for the source/db/fetch-stub setup to copy). Add `import * as metrics from '../../srv/lib/metrics.js';` alongside the existing imports. Add this block at the end of the file, reusing the same source + fetch-stub setup as the nearest existing `fetchOneSource` test (a successful fetch, so the `[result=hit]` + `.inserted`/`.updated` names all emit):

```js
describe('#1257 fetcher metric names', () => {
  beforeEach(() => { process.env.RSS_TRANSPORT = 'fetch'; });
  afterEach(() => { delete process.env.RSS_TRANSPORT; });

  it('every emitted fetch metric name is ≤ 64 chars with no source= or value labels', async () => {
    const spy = vi.spyOn(metrics, 'counter');
    const db = await cds.connect.to('db');
    // Copy the happy-path source object + global.fetch stub from the existing
    // successful-fetch test above (the one asserting inserted rows).
    global.fetch = /* same fake-RSS stub as the existing success test */ global.fetch;
    const source = { ID: 'x', topicSlug: 'some-topic', label: 'Test', url: 'https://example.test/rss' };
    await fetchOneSource(source, { db });
    const names = spy.mock.calls.map((c) => c[0]);
    expect(names.length).toBeGreaterThan(0);
    for (const n of names) {
      expect(n.length).toBeLessThanOrEqual(64);
      expect(n).not.toMatch(/source=/);
      expect(n).not.toMatch(/=\d/);
    }
    spy.mockRestore();
  });
});
```
> Wire the `source` object and `global.fetch` stub to match the existing successful-fetch test in this file (do not invent a new harness). The assertions on `names` are the actual test.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --project unit test/unit/community-blogs-fetcher.test.js -t "#1257"`
Expected: FAIL — current names contain `source=` and (`:225`) `inserted=N,updated=N`.

- [ ] **Step 3: Implement the fix**

`:176` and `:182` — replace both identical lines:
```js
    metrics.counter(`homepage.community_blogs.fetch[source=${source.topicSlug || source.ID},result=fetch_error]`);
```
with:
```js
    metrics.counter('homepage.community_blogs.fetch[result=fetch_error]');
```

`:192` — replace:
```js
    metrics.counter(`homepage.community_blogs.fetch[source=${source.topicSlug || source.ID},result=parse_error]`);
```
with:
```js
    metrics.counter('homepage.community_blogs.fetch[result=parse_error]');
```

`:225-227` (success) — replace:
```js
  metrics.counter(
    `homepage.community_blogs.fetch[source=${source.topicSlug || source.ID},result=hit,inserted=${stats.inserted},updated=${stats.updated}]`
  );
```
with:
```js
  metrics.counter('homepage.community_blogs.fetch[result=hit]');
  metrics.counter('homepage.community_blogs.fetch.inserted', stats.inserted);
  metrics.counter('homepage.community_blogs.fetch.updated', stats.updated);
```

Source detail is unchanged in the adjacent `log.warn` lines — no observability lost.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run --project unit test/unit/community-blogs-fetcher.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add srv/lib/community-blogs-fetcher.js test/unit/community-blogs-fetcher.test.js
git commit -m "fix(#1257): fetcher metric names drop unbounded source= and value labels"
```

---

### Task 4: Fix the homepage-service served counter

**Files:**
- Modify: `srv/homepage-service.js:535`

**Interfaces:**
- Consumes: `metrics.counter` (existing signature).
- Produces: `homepage.community_blogs[result=served]` (no `count=`).

- [ ] **Step 1: Change the line**

In `srv/homepage-service.js`, replace line 535:
```js
          metrics.counter(`homepage.community_blogs[result=served,count=${value.length}]`);
```
with:
```js
          metrics.counter('homepage.community_blogs[result=served]');
```

- [ ] **Step 2: Verify no other served-count assertion exists**

Run: `grep -rn "result=served,count" srv test`
Expected: no matches (only the line you just changed, now gone).

- [ ] **Step 3: Commit**

```bash
git add srv/homepage-service.js
git commit -m "fix(#1257): homepage served counter drops baked-in count= value"
```

---

### Task 5: Per-row insert fallback in the rollup job

**Files:**
- Modify: `srv/jobs/metrics-rollup-job.js:65-73`
- Test: `test/unit/metrics-rollup-job.test.js` (CREATE)

**Interfaces:**
- Consumes: nothing new.
- Produces: `runMetricsRollup()` — on a non-collision batch-insert failure, retries rows individually; returns `{ wrote: number, degraded: true, dropped: number }`. Collision path unchanged (`{ wrote: 0, skipped: true }`). Happy path unchanged (`{ wrote: rows.length }`).

- [ ] **Step 1: Write the failing test**

Create `test/unit/metrics-rollup-job.test.js`. Mock `@sap/cds` and the CAP global `INSERT` so no DB is needed:

```js
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as metrics from '../../srv/lib/metrics.js';

// Minimal cds stub — the job uses cds.log and cds.entities(NAMESPACE).
vi.mock('@sap/cds', () => {
  const log = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() });
  return { default: { log, entities: () => ({ MetricSnapshots: { name: 'MetricSnapshots' } }) } };
});

let insertCalls;
function installInsert(behavior) {
  insertCalls = [];
  globalThis.INSERT = {
    into: () => ({
      entries: (rows) => {
        insertCalls.push(rows);
        return behavior(rows);
      },
    }),
  };
}

describe('#1257 rollup per-row fallback', () => {
  beforeEach(() => {
    metrics._resetForTest();
    delete process.env.METRICS_ENABLED;
    metrics.counter('a.b.c', 1);
    metrics.counter('d.e.f', 1);
  });
  afterEach(() => { delete globalThis.INSERT; });

  it('salvages good rows when the batch insert throws a non-collision error', async () => {
    // Batch (array length > 1) throws; single-row inserts succeed.
    installInsert((rows) => {
      if (rows.length > 1) throw new Error('inserted value too large for column');
      return Promise.resolve();
    });
    const { runMetricsRollup } = await import('../../srv/jobs/metrics-rollup-job.js');
    const res = await runMetricsRollup({ instanceId: 'test-instance' });
    expect(res.degraded).toBe(true);
    expect(res.wrote).toBe(2);
    expect(res.dropped).toBe(0);
  });

  it('collision on the batch still returns skipped (regression)', async () => {
    installInsert(() => { throw new Error('unique constraint violated'); });
    const { runMetricsRollup } = await import('../../srv/jobs/metrics-rollup-job.js');
    const res = await runMetricsRollup({ instanceId: 'test-instance' });
    expect(res.skipped).toBe(true);
    expect(res.wrote).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --project unit test/unit/metrics-rollup-job.test.js`
Expected: FAIL — current code has no per-row fallback; the first test sees the batch throw fall through to `{ wrote: 0, error: ... }` (no `degraded`).

- [ ] **Step 3: Implement the fallback**

In `srv/jobs/metrics-rollup-job.js`, replace the `catch` block (lines 65-73):

```js
  } catch (err) {
    // Primary-key collision (same window re-run) is expected on manual re-fires.
    if (/uniqu|primary|duplicate/i.test(err.message || '')) {
      LOG.info(`rollup already written for ${windowStart} on ${instanceId} — skipping`);
      return { wrote: 0, skipped: true };
    }
    // Non-collision failure (e.g. a single poison row): salvage the good rows
    // by inserting one at a time so one bad row can't sink the whole tick (#1257).
    LOG.warn(`rollup batch insert failed (${err.message}) — falling back to per-row`);
    let wrote = 0;
    const dropped = [];
    for (const row of rows) {
      try {
        await INSERT.into(MetricSnapshots).entries([row]);
        wrote++;
      } catch (e) {
        dropped.push({ metric: row.metric, reason: e.message });
      }
    }
    if (dropped.length) LOG.warn(`rollup dropped ${dropped.length} row(s): ${JSON.stringify(dropped)}`);
    return { wrote, degraded: true, dropped: dropped.length };
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run --project unit test/unit/metrics-rollup-job.test.js`
Expected: PASS (both tests).

- [ ] **Step 5: Commit**

```bash
git add srv/jobs/metrics-rollup-job.js test/unit/metrics-rollup-job.test.js
git commit -m "fix(#1257): rollup salvages good rows per-row when batch insert fails"
```

---

### Task 6: Update observability doc

**Files:**
- Modify: `docs/developers/architecture/observability.md`

**Interfaces:** none (docs).

- [ ] **Step 1: Add catalog rows**

In the "Metrics catalog" table (after line 26, the `db.pool.timeout` row), add:

```markdown
| `homepage.community_blogs[result=served\|degraded\|degraded_empty\|error]` | counter | `srv/homepage-service.js` communityBlogs | Shelf serve outcome |
| `homepage.community_blogs.classifier.{drained,ok,parse_error,aicore_error}` | counter | `srv/lib/community-blogs-classifier.js` | Per-drain classifier counts |
| `homepage.community_blogs.fetch[result=hit\|fetch_error\|parse_error]` | counter | `srv/lib/community-blogs-fetcher.js` | Per-source fetch outcome |
| `homepage.community_blogs.fetch.{inserted,updated}` | counter | `srv/lib/community-blogs-fetcher.js` | Rows inserted/updated per fetch |
| `homepage.events.refresh[result=ok\|partial]` | counter | `srv/jobs/refresh-community-events-job.js` | Events refresh outcome |
```

- [ ] **Step 2: Note the guard**

In the "How to add a new metric" section, after item 4 (line 35), add:

```markdown
5. **Names are capped at 64 chars** (`MAX_NAME_LEN` in `metrics.js`, mirroring
   the `MetricSnapshots.metric` `String(64)` primary key). Never interpolate
   counts or unbounded ids into a name — put counts in their own dotted counter
   (`counter(name, n)`) and keep only bounded dimensions in `[key=value]` tags.
   Over-length names are dropped at ingestion with a warning, never persisted.
```

- [ ] **Step 3: Commit**

```bash
git add docs/developers/architecture/observability.md
git commit -m "docs(#1257): catalog community_blogs metrics + document 64-char name guard"
```

---

### Task 7: Full unit-suite regression + push

**Files:** none (verification).

- [ ] **Step 1: Run the affected files together**

Run: `npx vitest run --project unit srv/lib/__tests__/metrics.test.js test/unit/community-blogs-classifier.test.js test/unit/community-blogs-fetcher.test.js test/unit/metrics-rollup-job.test.js`
Expected: all PASS.

- [ ] **Step 2: Grep for any missed value-in-name emitters**

Run: `grep -rnE "metrics\.(counter|gauge|observe)\(\`[^\`]*=\$\{" srv`
Expected: no matches (no remaining interpolated values in metric names). If any surface, fix them the same way before pushing.

- [ ] **Step 3: Push and open PR**

```bash
git push -u origin worktree-fix-1257-metrics-name-overflow
gh pr create --repo sap-tutorials/tutorials-ims --fill \
  --title "fix(#1257): metric names carrying values — 64-char overflow + cardinality" \
  --body "Closes #1257. See docs/superpowers/specs/2026-07-21-1257-metrics-name-overflow-design.md"
```
