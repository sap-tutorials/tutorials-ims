# #1257 — Metric names carrying values: 64-char overflow + cardinality explosion

**Issue:** [#1257](https://github.com/sap-tutorials/tutorials-ims/issues/1257)
**Date:** 2026-07-21
**Status:** Design approved

## Problem

The `MetricSnapshots.metric` column is `key String(64)` — a **primary key**
(`db/schema.cds:997`). Several metric emitters interpolate per-tick *values*
into the metric *name*, producing names longer than 64 chars and exploding the
primary-key cardinality.

The reported symptom (live DEV srv logs, 2026-07-21):

```
[APP/PROC/WEB/0] ERR jobs/metrics-rollup: rollup write failed:
inserted value too large for column: max length (64) violated on pos 0,
value='homepage.community_blogs.classifier[result=drained,drained=0,ok=0,parse_error=0,aicore_error=0]';
column 'METRIC'; rc=6959
```

That name is **91 characters**.

### Why this is worse than one long string

1. **Overflow** — names exceed the `String(64)` PK column, so the insert
   is rejected by HANA.
2. **Root cause — values baked into the name** — `drained=0,ok=0,…` are
   *metric values*, not dimensions. They belong in the `value`/`count`
   columns. Baking them into the PK means every distinct count combination
   mints a brand-new row, so the series can never be aggregated
   (`SUM`/`GROUP BY` over a stable name is impossible).
3. **Blast radius** — the rollup writes with a single batch insert
   (`INSERT.into(MetricSnapshots).entries(rows)`, `metrics-rollup-job.js:63`).
   A single overflowing row fails the **entire** tick, so *all* metrics for
   that 5-minute window are silently lost (logged as `warn`, not thrown).

### Convention already documents the right shape

`docs/developers/architecture/observability.md`:
- "Naming: use dotted namespaces (`subsystem.what.kind`)."
- "Keep total distinct names ≤ 20 in v1 to stay well within the
  `MetricSnapshots` cardinality budget."

The `homepage.community_blogs.*` metrics were added later and violate both
rules; they are also absent from the catalog table in that doc.

## Affected sites

Five emitter callsites carry the anti-pattern (values in the name):

| File:line | Current name | Issue |
|---|---|---|
| `srv/lib/community-blogs-classifier.js:272` | `…classifier[result=drained,drained=N,ok=N,parse_error=N,aicore_error=N]` | 91 chars; 4 values baked in |
| `srv/lib/community-blogs-fetcher.js:226` | `…fetch[source=${slug},result=hit,inserted=N,updated=N]` | 2 values + unbounded slug |
| `srv/lib/community-blogs-fetcher.js:176` | `…fetch[source=${slug},result=fetch_error]` | unbounded slug |
| `srv/lib/community-blogs-fetcher.js:182` | `…fetch[source=${slug},result=fetch_error]` | unbounded slug |
| `srv/lib/community-blogs-fetcher.js:192` | `…fetch[source=${slug},result=parse_error]` | unbounded slug |
| `srv/homepage-service.js:535` | `homepage.community_blogs[result=served,count=${n}]` | `count` value baked in |

**Correct (left untouched)** — low-cardinality dimension, no value:
- `srv/jobs/refresh-community-events-job.js:103` — `homepage.events.refresh[result=${result}]` (`ok`/`partial`)
- `srv/homepage-service.js:530/532/555` — `homepage.community_blogs[result=degraded_empty|degraded|error]`

## Design

Three layers. Layers 1–2 fix the data; layer 3 makes the whole class of bug
non-fatal to a rollup tick going forward.

### Layer 1 — correct the emitters

Dimensions stay in the name (`[result=hit]`); additive counts move to their
own dotted counters incremented by N.

**classifier.js:272** — replace the single 91-char line with:
```js
metrics.counter('homepage.community_blogs.classifier.drained', summary.drained);
metrics.counter('homepage.community_blogs.classifier.ok', summary.ok);
metrics.counter('homepage.community_blogs.classifier.parse_error', summary.parseError);
metrics.counter('homepage.community_blogs.classifier.aicore_error', summary.aicoreError);
```
Longest name: `homepage.community_blogs.classifier.aicore_error` = 48 chars.

**fetcher.js:226** (success) — becomes:
```js
metrics.counter('homepage.community_blogs.fetch[result=hit]');
metrics.counter('homepage.community_blogs.fetch.inserted', stats.inserted);
metrics.counter('homepage.community_blogs.fetch.updated', stats.updated);
```

**fetcher.js:176/182/192** (errors) — **drop `source=${slug}`** from the name
(unbounded; source detail already survives in the adjacent `log.warn` line):
```js
metrics.counter('homepage.community_blogs.fetch[result=fetch_error]'); // :176, :182
metrics.counter('homepage.community_blogs.fetch[result=parse_error]'); // :192
```

**homepage-service.js:535** — drop `count=`:
```js
metrics.counter('homepage.community_blogs[result=served]');
```

Exact per-tick counts are not lost: they already survive in the existing
`LOG.info(JSON.stringify(summary))` lines in the classifier and fetcher, and
are now also queryable as aggregatable counters.

### Layer 2 — `counter(name, n = 1)` in metrics.js

Extend the counter signature to accept an increment amount:
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
Backward compatible — all existing `counter(name)` callsites default `n = 1`.
`n === 0` is allowed (records the series at 0 without incrementing — useful for
"drained 0 this tick" visibility).

### Layer 3 — two defenses

**3a. Ingestion guard (`MAX_NAME_LEN = 64`)** — `counter`, `gauge`, and
`observe` reject a name longer than 64 chars, routing to the existing
rate-limited `warn()` and dropping only that one metric. It never reaches the
batch insert. `MAX_NAME_LEN` mirrors the `String(64)` schema column; documented
as such in a code comment.

**3b. Batch-insert hardening (`metrics-rollup-job.js`)** — when the batch
insert throws for a reason other than PK collision, fall back to inserting rows
one at a time so a single poison row cannot sink the whole tick:
```js
} catch (err) {
  if (/uniqu|primary|duplicate/i.test(err.message || '')) { /* unchanged */ }
  // Non-collision failure: salvage the good rows one-by-one.
  LOG.warn(`rollup batch insert failed (${err.message}) — falling back to per-row`);
  let wrote = 0; const dropped = [];
  for (const row of rows) {
    try { await INSERT.into(MetricSnapshots).entries([row]); wrote++; }
    catch (e) { dropped.push({ metric: row.metric, reason: e.message }); }
  }
  if (dropped.length) LOG.warn(`rollup dropped ${dropped.length} row(s): ${JSON.stringify(dropped)}`);
  return { wrote, degraded: true, dropped: dropped.length };
}
```
With layer 3a in place a poison row should never be produced in the first
place; 3b is defence-in-depth for any future emitter that bypasses the library
(e.g. a direct row shape).

## Testing (TDD — tests first)

**`srv/lib/__tests__/metrics.test.js`:**
- `counter(name, n)` adds `n` (e.g. `counter('x', 5)` → 5; two calls → 10).
- `counter(name)` still defaults to +1 (regression).
- `counter(name, 0)` records the name at 0.
- name > 64 chars → no throw, warns, absent from `snapshot()`.
- invalid `n` (NaN, negative, non-number) → no throw, warns, counter unchanged.

**classifier + fetcher — extend existing `test/unit/community-blogs-classifier.test.js`
and `test/unit/community-blogs-fetcher.test.js`:**
- Spy on `metrics.counter`; assert every emitted name is ≤ 64 chars and matches
  `/^[a-z0-9_.]+(\[[a-z0-9_=]+\])?$/` (no numeric value labels like `drained=0`).
- classifier drains with counts → four `.drained/.ok/.parse_error/.aicore_error`
  counters emitted with the right N.

**rollup job test — NEW file `test/unit/metrics-rollup-job.test.js`
(no existing test for `srv/jobs/metrics-rollup-job.js`):**
- Mock `INSERT.into` that throws a non-collision error on a multi-row batch but
  succeeds on single-row inserts → good rows survive, `degraded:true`, poison
  row appears in the `dropped` log.
- PK-collision path still returns `{skipped:true}` (regression).

## Docs

- `docs/developers/architecture/observability.md` — add the new
  `homepage.community_blogs.*` counters to the catalog table; note the
  `MAX_NAME_LEN = 64` ingestion guard in the "How to add a new metric" section.

## Out of scope (YAGNI)

- **No column widen.** `metric` is a PK and the values don't belong there;
  widening would entrench the anti-pattern and require a `.hdbmigrationtable`
  change (must be regenerated via `cds build --production`, never hand-edited).
- **No admin-UI change.** These metrics are not surfaced on `/admin-ui/#metrics`.
- **No new feature flag.** Reuses `METRICS_ENABLED`.

## Rollout

Pure srv code change (no schema/DB change → no migration, no `cds build`
artifact churn). Ships on the next srv deploy. On deploy the classifier's next
drain writes the corrected names; the stale over-long name simply stops being
emitted (old rows age out under the existing 30-day `MetricSnapshots` retention
cron).
