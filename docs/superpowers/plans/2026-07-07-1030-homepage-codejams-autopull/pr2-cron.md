# PR 2 — Cron registration

**Parent plan:** [../2026-07-07-1030-homepage-codejams-autopull.md](../2026-07-07-1030-homepage-codejams-autopull.md)
**Spec:** [../../specs/2026-07-07-1030-homepage-codejams-autopull-design.md](../../specs/2026-07-07-1030-homepage-codejams-autopull-design.md)

**Scope:** Task 9 only. Registers the `refresh-community-events` cron in `srv/jobs/scheduler.js`. Ships AFTER PR 1 has been merged and the backfill has run on DEV — this PR is what turns the 6-hour refresh loop ON.

**Merge criteria:**
- `npm test` green (existing scheduler tests + a new one asserting the job is registered).
- After deploy to DEV: `cf logs tutorials-srv --recent | grep 'refresh-community-events'` shows the job wiring log and a first-cycle summary within 6 h.

---

## Task 9: Register `refresh-community-events` cron

**Files:**
- Modify: `srv/jobs/scheduler.js` (find `jobName: 'fetch-community-events'` — add sibling registration nearby)
- Modify: existing scheduler-registration test if any (`test/unit/scheduler-registration.test.js` likely exists — extend it)

**Interfaces:**
- Consumes: `runRefreshCommunityEvents` from Task 4.
- Produces: cron entry `refresh-community-events` firing every 6 h at minute 17.

- [ ] **Step 1: Locate the existing `fetch-community-events` registration**

Run:

```bash
grep -n "jobName: 'fetch-community-events'" srv/jobs/scheduler.js
```

Expected: prints the line number where the sibling registration lives (e.g., line 860).

- [ ] **Step 2: Add the new registration**

Immediately after the existing `fetch-community-events` `registerJob({ ... })` block (find the closing `});`), insert:

```js
  // #1030 — Every 6 h at minute 17 (off :00/:30 to avoid stampede). Keeps the
  // Row 3 homepage events band fresh without incurring LLM cost — this job
  // ONLY re-pulls Khoros + RSS and upserts CommunityEvents (title, url,
  // location, region, ...). The twice-weekly fetch-community-events job
  // above still owns embedding + concept-link extraction.
  //
  // Spec: docs/superpowers/specs/2026-07-07-1030-homepage-codejams-autopull-design.md §5
  registerJob({
    jobName: 'refresh-community-events',
    schedule: '17 */6 * * *',
    ttlMs: 10 * 60 * 1000,        // 10 min — job is lightweight, no LLM cost
    description: 'Refresh CommunityEvents (CodeJams + Devtoberfest) for homepage — no LLM (6h cadence)',
    fn: async (logId, opts) => {
      const { runRefreshCommunityEvents } = await import('./refresh-community-events-job.js');
      return runRefreshCommunityEvents(logId, opts);
    },
  });
```

- [ ] **Step 3: Write a registration-assertion test**

Find or create `test/unit/scheduler-registration.test.js`. Look for existing test:

```bash
grep -rn "refresh-community-events\|fetch-community-events" test/unit/ | head
```

If a similar test already exists (asserting `fetch-community-events` is registered), extend it. Otherwise, create `test/unit/scheduler-refresh-events-registration.test.js`:

```js
// test/unit/scheduler-refresh-events-registration.test.js
// #1030 — assert the new refresh-community-events job is wired to the registry.

import { describe, it, expect, beforeAll } from 'vitest';
import { registerJobs, _getJobRegistry } from '../../srv/jobs/scheduler.js';

describe('scheduler registration', () => {
  beforeAll(() => {
    if (_getJobRegistry().size === 0) registerJobs();
  });

  it('registers refresh-community-events at 17 */6 * * *', () => {
    const job = _getJobRegistry().get('refresh-community-events');
    expect(job).toBeDefined();
    expect(job.schedule).toBe('17 */6 * * *');
    expect(job.description).toMatch(/Refresh CommunityEvents/i);
    expect(typeof job.fn).toBe('function');
  });

  it('keeps the twice-weekly fetch-community-events job registered', () => {
    // Guardrail: the new job is IN ADDITION TO, not a replacement for, the extraction job.
    const twiceWeekly = _getJobRegistry().get('fetch-community-events');
    expect(twiceWeekly).toBeDefined();
    expect(twiceWeekly.schedule).toBe('31 4 * * 1,4');
  });
});
```

- [ ] **Step 4: Run tests, verify they pass**

```bash
npm test -- scheduler-refresh-events-registration
```

Expected: PASS both cases.

- [ ] **Step 5: Verify no other registration test regressed**

```bash
npm test -- scheduler
```

Expected: PASS.

- [ ] **Step 6: Commit + push**

```bash
git add srv/jobs/scheduler.js test/unit/scheduler-refresh-events-registration.test.js
git commit -m "feat(#1030): register refresh-community-events cron (17 */6 * * *)"
git push -u origin HEAD
```

- [ ] **Step 7: Open draft PR**

```bash
gh pr create --draft \
  --title "feat(#1030): PR 2 — register refresh-community-events cron" \
  --body "$(cat <<'EOF'
Part 2 of 3 for #1030 (homepage CodeJams auto-pull).

## What ships here
- Registers \`refresh-community-events\` cron at \`17 */6 * * *\` in \`srv/jobs/scheduler.js\`
- Registration-assertion test (also guards that the twice-weekly extraction job stays registered)

## Preconditions
- PR 1 (\`CommunityEvents.region\` + refresh-job scaffold + backfill) must be merged
- Backfill script has been run on DEV HANA

## Verification after DEV deploy
1. \`cf logs tutorials-srv --recent | grep 'CronService wired'\` — should show one more job than before
2. Wait up to 6 h (or trigger manually via admin UI job kicker if available)
3. \`cf logs tutorials-srv --recent | grep 'refresh-community-events'\` — expect a summary line \`{"fetched":N,"upserted":N,...}\`

Closes part 2 of #1030.
EOF
)"
```

---

## PR 2 Merge Checklist

- [ ] Task 9 committed
- [ ] Registration test green
- [ ] Draft PR references #1030 and calls out that PR 1 must land first
- [ ] After DEV deploy: first cycle summary line observed in logs within 6 h
