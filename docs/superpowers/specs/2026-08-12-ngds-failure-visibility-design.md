# NGDS Silent-Failure Visibility — Design

**Date:** 2026-08-12
**Status:** Approved (design)
**Author:** Tom (via Claude)

## Problem

The PROD NGDS outbound feed failed for ~2 days (from 2026-08-10 18:00 UTC) with **zero operator signal**. Root cause of the outage was a destination misconfiguration (`ngds-destination` name/credentials); this design does **not** fix that. It fixes the reason the outage was *invisible*.

Four gaps let it stay silent (all confirmed in code):

1. **Fire-and-forget send.** `sendTaskRecordToNgds` (`srv/lib/ngds-client.js`) catches the send error, logs it, queues to `NGDSFailedMessages`, and returns `{success:false}` without rethrowing. Correct for UX (a user's completion never fails on an NGDS problem), but no signal escapes.
2. **Misleading metric.** The only counters are `skipped.*` and `sent`. `maybeAutoSendCompletion` (`srv/lib/ngds-autosend.js`) increments `ngds.autosend.sent` *after* the internally-caught send, so **`sent` increments even on failure**. Dashboards showed green throughout the outage. There is no `ngds.autosend.failed`.
3. **Unwatched queue.** Nothing monitors `NGDSFailedMessages` depth or the `FAILED_PERMANENTLY` (data-loss) count.
4. **Retry job hides failure from the scheduler.** The scheduler raises a `ScheduledJobFailed` ANS alert only when a job **throws** (`scheduler.js:177`). `retryNgds` (`srv/jobs/ngds-retry.js`) catches every per-message error and returns normally, so a run where 100% of messages fail is recorded as SUCCESS — the one built-in alert is structurally bypassed.

## Goals / Non-Goals

**Goals**
- A silent NGDS outage becomes visible within **≤2h** (one retry cycle).
- Metrics tell the truth regardless of alert wiring.
- No change to the live completion (hot) path.

**Non-Goals (YAGNI)**
- Minutes-fast edge alert on the completion path.
- Admin-UI config for thresholds (code constants for now).
- Changing the fire-and-forget send design.
- Backfilling the 68 already-dropped records (a separate ops task, after the destination/password fix).

## Design

Decisions: **detection ≤2h via the existing retry job**; **thresholds are code constants**.

### Change 1 — Truthful metric (`srv/lib/ngds-autosend.js`)

`sendTaskRecordToNgds` already returns `{ success, error }`. In `maybeAutoSendCompletion`, replace the unconditional `metrics.counter('ngds.autosend.sent')` with:

```js
const outcome = await sendTaskRecordToNgds(record, database);
if (outcome && outcome.success) metrics.counter('ngds.autosend.sent');
else metrics.counter('ngds.autosend.failed');
```

`sent` now means *delivered*; a failure increments `ngds.autosend.failed`, which the metrics rollup persists to `MetricSnapshots`. This is the failsafe signal: it does **not** depend on ANS/alerting being enabled.

### Change 2 — Retry-job alerts + gauges (`srv/jobs/ngds-retry.js`)

`retryNgds` already tracks per 2h run: `retried`, `exhausted` (newly `FAILED_PERMANENTLY`), `failed` (retry attempts that failed this cycle). Compute `pendingRemaining = pending.length − retried − exhausted` (no extra query). After the loop, before `return`:

- **Metrics** (always): `metrics.gauge('ngds.failed_messages.pending', pendingRemaining)`, `metrics.counter('ngds.retry.failed', failed)` (if >0), `metrics.counter('ngds.retry.exhausted', exhausted)` (if >0).
- **Data-loss alert** (`exhausted > 0`):
  ```js
  await alerting.raise({
    eventType: 'NgdsSendExhausted', severity: 'ERROR', category: 'ALERT',
    subject: `NGDS: ${exhausted} message(s) permanently dropped`,
    body: `retryNgds marked ${exhausted} message(s) FAILED_PERMANENTLY this run. `
        + `${pendingRemaining} still pending. NGDS badge events for these are lost.`,
    resource: { resourceName: 'ngds-retry', resourceType: 'job' },
  });
  ```
- **Backlog alert** (`failed > 0` **or** `pendingRemaining >= BACKLOG_THRESHOLD`):
  ```js
  await alerting.raise({
    eventType: 'NgdsBacklog', severity: 'WARNING', category: 'ALERT',
    subject: `NGDS feed unhealthy: ${pendingRemaining} pending, ${failed} failed this run`,
    body: `retryNgds: retried=${retried}, failed=${failed}, exhausted=${exhausted}, `
        + `pendingRemaining=${pendingRemaining}. NGDS may be unreachable or misconfigured.`,
    resource: { resourceName: 'ngds-retry', resourceType: 'job' },
  });
  ```

`failed > 0` fires on the **first** retry cycle of an outage (a send was attempted and rejected). `BACKLOG_THRESHOLD = 20` is a magnitude backstop.

`alerting.raise` is **awaited** here (background cron, internally 5s-capped and fail-open — it cannot throw into or wedge the job). Import: `import * as alerting from '../lib/alerting.js'`.

### Change 3 — nothing else

No hot-path edit, no config surface, no send-design change.

## Load-bearing operational caveat

`alerting.raise` is gated by `ChatSettings.alertsEnabled` (default **OFF**). If alerting is OFF in PROD, the new **alerts** are also silent. Therefore closing the gap operationally requires **confirming `alertsEnabled=true` in PROD** and that the ANS destination is healthy. Change 1 (metrics) is unconditional and is the backstop that works even if ANS is down.

## Testing

Unit (vitest, in-memory SQLite — `retryNgds` uses plain cds.ql on `NGDSFailedMessages`):

- **autosend:** mocked `sendTaskRecordToNgds` returning `{success:true}` → only `ngds.autosend.sent`; `{success:false}` → only `ngds.autosend.failed`.
- **retry:** seed `NGDSFailedMessages`; mock `postPayload` (fail all / succeed all / mixed) and the `alerting` module; assert:
  - all-fail-with-exhaustion → `NgdsSendExhausted`/ERROR raised;
  - failures without exhaustion → `NgdsBacklog`/WARNING raised;
  - all-succeed → no alert, gauges set to 0 pending.

## Plan-time checks

- `srv/lib/ngds-client.js` has a near-duplicate `retryFailedMessages`. Verify whether it is dead code or a second caller; if live, apply the same alerting/metrics, otherwise leave (or remove) consistently.
- Confirm `metrics` gauge/counter names stay ≤64 chars (`MetricSnapshots.metric` key limit).
- srv-qa `cp` list: this touches `srv/jobs/` and `srv/lib/` — re-walk transitive `./` imports; `alerting.js`/`metrics.js` are already shipped, but confirm no new dep is introduced that srv-qa lacks.
