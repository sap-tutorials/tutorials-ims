# Tutorial Feedback Form Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Qualtrics survey deeplink with a self-hosted Vue feedback form, persisted to HANA via a CAP action exposed at `/feedback/submit`, with admin reporting (List Report + dashboard) in the existing admin shell.

**Architecture:** New CDS entity `TutorialFeedback` + `TutorialFeedbackAggregate` projection. Anonymous submission flows through a new unauthenticated AppRouter route → Express bridge in `srv/server.js` → `submitTutorialFeedback` action on `DeveloperService`. Admin reads via read-only projections on `AdminService`. Public form is a Vue island bundled with the existing `apps/` workspace, mounted by a Hugo template change.

**Tech Stack:** CAP Node.js (`@sap/cds`), HANA Cloud, Vue 3 + Vite, SAP Fundamental Styles (Horizon), Fiori Elements (List Report), freestyle SAPUI5 (`sap.tnt.ToolPage`), vitest (unit + hybrid + smoke).

**Spec:** [`docs/superpowers/specs/2026-05-20-tutorial-feedback-form-design.md`](../specs/2026-05-20-tutorial-feedback-form-design.md)

**Reviewer-flagged caveats to honor:**

- `wasAuthenticated` is a client-supplied boolean (auth-none route strips JWT). Spoofable but acceptable — it's a quality metric, not a security boundary.
- `_clientIp` is set by the Express bridge on `req.data` and read by the action handler. Never declared in the action signature; CAP passes through unknown keys for in-process callers.
- `submitterIpHash` salt rotates daily at UTC midnight. Existing rate-limit Map keys are pruned by a `setInterval` sweep.
- Slug validation uses `ContentFiles` (source of truth for served tutorials), NOT `RepoCatalog`. Match against any version (`(slug, version)` is the composite key).
- Admin XML bindings must use `text="{comment}"` — never `htmlText` — to preserve XSS escaping.
- Comment is bounded server-side at 2000 chars and stripped of control characters.

---

## File Structure

**New files:**

```text
srv/lib/feedback-salt.js                        SHA-256 daily-salted IP hash
srv/__tests__/feedback-salt.test.js
srv/__tests__/tutorial-feedback.test.js         action handler unit tests
srv/__tests__/tutorial-feedback-aggregate.test.js  projection math tests
test/hybrid/feedback.test.js                    real-HANA insert + projection
test/smoke/feedback.test.js                     deployed endpoint smoke tests
apps/src/tutorial-feedback/main.ts              Vue mount entry
apps/src/tutorial-feedback/TutorialFeedbackForm.vue
apps/src/tutorial-feedback/api.ts               probeAuth + submit wrappers
apps/src/tutorial-feedback/types.ts             FeedbackSubmission, RatingScale
app/admin/feedback/webapp/manifest.json         Fiori Elements List Report
app/admin/feedback/webapp/Component.js
app/admin/feedback/webapp/index.html
app/admin/feedback/webapp/i18n/i18n.properties
app/admin-shell/webapp/view/TutorialFeedbackDashboard.view.xml
app/admin-shell/webapp/controller/TutorialFeedbackDashboard.controller.js
```

**Modified files:**

```text
db/schema.cds                                   add TutorialFeedback entity
db/views.cds                                    add TutorialFeedbackAggregate projection
srv/developer-service.cds                       declare submitTutorialFeedback action
srv/developer-service.js                        wire action handler + rate limit
srv/server.js                                   add Express bridge POST /feedback/submit
srv/admin-service.cds                           expose 2 read-only projections
app/admin-annotations.cds                       @UI annotations for TutorialFeedback
approuter/xs-app.json                           add /feedback/ auth-none route
apps/vite.config.ts                             register tutorial-feedback input
hugo/layouts/partials/feedback-share.html       replace Qualtrics card + new popup
app/admin-shell/webapp/manifest.json            add Feedback nav group
CLAUDE.md                                       document SUBMISSION_SALT_SECRET
```

---

## Task 1: Add TutorialFeedback entity to schema

**Files:**

- Modify: `db/schema.cds`

- [ ] **Step 1: Append entity definition to `db/schema.cds`**

```cds
entity TutorialFeedback : managed {
  key ID            : UUID;
  tutorialSlug      : String(200) @mandatory;
  submittedAt       : Timestamp default $now;
  wasAuthenticated  : Boolean default false;
  submitterIpHash   : String(64);
  ratingUseCase     : Integer;
  ratingRelevance   : Integer;
  ratingDuration    : Integer;
  ratingStructure   : Integer;
  ratingInteresting : Integer;
  ratingVisuals     : Integer;
  npsScore          : Integer;
  comment           : String(2000);
}
```

- [ ] **Step 2: Run `cds compile` to verify schema parses**

```bash
npx cds compile db/schema.cds --to sql > /dev/null
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add db/schema.cds
git commit -m "feat(feedback): add TutorialFeedback entity"
```

---

## Task 2: Add TutorialFeedbackAggregate projection

**Files:**

- Modify: `db/views.cds`

- [ ] **Step 1: Append projection to `db/views.cds`**

```cds
entity TutorialFeedbackAggregate as
  select from TutorialFeedback {
    key tutorialSlug,
    count(*)                                       as responseCount  : Integer,
    avg(ratingUseCase)                             as avgUseCase     : Decimal(4,2),
    avg(ratingRelevance)                           as avgRelevance   : Decimal(4,2),
    avg(ratingDuration)                            as avgDuration    : Decimal(4,2),
    avg(ratingStructure)                           as avgStructure   : Decimal(4,2),
    avg(ratingInteresting)                         as avgInteresting : Decimal(4,2),
    avg(ratingVisuals)                             as avgVisuals     : Decimal(4,2),
    avg(npsScore)                                  as avgNps         : Decimal(4,2),
    sum(case when npsScore >= 9 then 1 else 0 end) as promoters      : Integer,
    sum(case when npsScore <= 6 then 1 else 0 end) as detractors     : Integer
  } group by tutorialSlug;
```

Place near other aggregate projections in the file. If `db/views.cds` does not exist, create it with `using { com.sap.developers.ims as db } from './schema';` and the projection.

- [ ] **Step 2: Verify schema compiles with the projection**

```bash
npx cds compile db/ --to sql > /tmp/schema.sql && grep -c "TutorialFeedbackAggregate" /tmp/schema.sql
```

Expected: `1` (or higher).

- [ ] **Step 3: Run cds build to generate HANA migration table**

```bash
npm run build:cds
```

Expected: `db/src/com.sap.developers.ims.TutorialFeedback.hdbmigrationtable` (or equivalent file under `gen/db/src/`) is generated.

- [ ] **Step 4: Commit (include generated migration files)**

```bash
git add db/views.cds db/src/ gen/
git commit -m "feat(feedback): add TutorialFeedbackAggregate projection + HANA migration"
```

---

## Task 3: Salt helper with TDD

**Files:**

- Create: `srv/lib/feedback-salt.js`
- Create: `srv/__tests__/feedback-salt.test.js`

- [ ] **Step 1: Write failing tests**

```js
// srv/__tests__/feedback-salt.test.js
const { describe, it, expect, beforeAll } = require('vitest');

beforeAll(() => { process.env.SUBMISSION_SALT_SECRET = 'test-secret-do-not-use'; });

describe('feedback-salt', () => {
  it('hashIp is deterministic within a UTC day', () => {
    const { hashIp } = require('../lib/feedback-salt');
    const day = new Date('2026-05-20T12:00:00Z');
    expect(hashIp('1.2.3.4', day)).toBe(hashIp('1.2.3.4', day));
  });

  it('hashIp differs across days', () => {
    const { hashIp } = require('../lib/feedback-salt');
    const a = hashIp('1.2.3.4', new Date('2026-05-20T12:00:00Z'));
    const b = hashIp('1.2.3.4', new Date('2026-05-21T12:00:00Z'));
    expect(a).not.toBe(b);
  });

  it('hashIp returns 64-char hex', () => {
    const { hashIp } = require('../lib/feedback-salt');
    expect(hashIp('1.2.3.4')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('different IPs hash to different values on the same day', () => {
    const { hashIp } = require('../lib/feedback-salt');
    const day = new Date('2026-05-20T12:00:00Z');
    expect(hashIp('1.2.3.4', day)).not.toBe(hashIp('5.6.7.8', day));
  });
});
```

- [ ] **Step 2: Run tests, confirm they fail**

```bash
npx vitest run srv/__tests__/feedback-salt.test.js
```

Expected: FAIL with "Cannot find module '../lib/feedback-salt'".

- [ ] **Step 3: Implement helper**

```js
// srv/lib/feedback-salt.js
const crypto = require('crypto');

function getSecret() {
  const s = process.env.SUBMISSION_SALT_SECRET;
  if (!s) throw new Error('SUBMISSION_SALT_SECRET is not set');
  return s;
}

function dailySaltFor(date = new Date()) {
  const ymd = date.toISOString().slice(0, 10);
  return crypto.createHash('sha256').update(getSecret() + ymd).digest('hex');
}

function hashIp(ip, date = new Date()) {
  return crypto.createHash('sha256').update(ip + dailySaltFor(date)).digest('hex');
}

module.exports = { dailySaltFor, hashIp };
```

- [ ] **Step 4: Run tests, confirm they pass**

```bash
npx vitest run srv/__tests__/feedback-salt.test.js
```

Expected: 4 passed.

- [ ] **Step 5: Commit**

```bash
git add srv/lib/feedback-salt.js srv/__tests__/feedback-salt.test.js
git commit -m "feat(feedback): salt helper with daily-rotating IP hash"
```

---

## Task 4: Declare submitTutorialFeedback action in CDS

**Files:**

- Modify: `srv/developer-service.cds`

- [ ] **Step 1: Add action to DeveloperService**

Append inside the `service DeveloperService { ... }` block:

```cds
@requires: 'any'
action submitTutorialFeedback(
  tutorialSlug      : String,
  ratingUseCase     : Integer,
  ratingRelevance   : Integer,
  ratingDuration    : Integer,
  ratingStructure   : Integer,
  ratingInteresting : Integer,
  ratingVisuals     : Integer,
  npsScore          : Integer,
  comment           : String,
  wasAuthenticated  : Boolean,
  honeypot          : String
) returns { submissionId : UUID };
```

- [ ] **Step 2: Verify CDS compiles**

```bash
npx cds compile srv/ --to sql > /dev/null
```

- [ ] **Step 3: Commit**

```bash
git add srv/developer-service.cds
git commit -m "feat(feedback): declare submitTutorialFeedback action"
```

---

## Task 5: Action handler with TDD

**Files:**

- Modify: `srv/developer-service.js`
- Create: `srv/__tests__/tutorial-feedback.test.js`

- [ ] **Step 1: Write failing test for the happy path**

```js
// srv/__tests__/tutorial-feedback.test.js
const { describe, it, expect, beforeAll, afterAll } = require('vitest');
const cds = require('@sap/cds');

process.env.SUBMISSION_SALT_SECRET = 'test-secret';

const { POST, GET, expect: ax } = cds.test(__dirname + '/../..').in(__dirname + '/../..');

describe('submitTutorialFeedback', () => {
  beforeAll(async () => {
    const db = await cds.connect.to('db');
    await INSERT.into('com.sap.developers.ims.ContentFiles').entries([
      { slug: 'demo-tutorial', version: 1, contentType: 'tutorial' }
    ]);
  });

  afterAll(async () => {
    const db = await cds.connect.to('db');
    await DELETE.from('com.sap.developers.ims.TutorialFeedback');
    await DELETE.from('com.sap.developers.ims.ContentFiles').where({ slug: 'demo-tutorial' });
  });

  it('persists a valid submission and returns submissionId', async () => {
    const { data, status } = await POST('/api/submitTutorialFeedback', {
      tutorialSlug: 'demo-tutorial',
      ratingUseCase: 8, ratingRelevance: 9, ratingDuration: 7,
      ratingStructure: 8, ratingInteresting: 9, ratingVisuals: 8,
      npsScore: 9, comment: 'Great', wasAuthenticated: false, honeypot: '',
      _clientIp: '10.0.0.1'
    });
    expect(status).toBe(200);
    expect(data.submissionId).toMatch(/^[0-9a-f-]{36}$/i);
  });

  it('rejects unknown slug with 400', async () => {
    const res = await POST('/api/submitTutorialFeedback', {
      tutorialSlug: 'no-such-tutorial', wasAuthenticated: false, honeypot: '', _clientIp: '10.0.0.2'
    }).catch(e => e.response);
    expect(res.status).toBe(400);
  });

  it('honeypot returns 200 but does not persist', async () => {
    const before = await SELECT.from('com.sap.developers.ims.TutorialFeedback').where({ tutorialSlug: 'demo-tutorial' });
    await POST('/api/submitTutorialFeedback', {
      tutorialSlug: 'demo-tutorial', wasAuthenticated: false, honeypot: 'i-am-a-bot', _clientIp: '10.0.0.3'
    });
    const after = await SELECT.from('com.sap.developers.ims.TutorialFeedback').where({ tutorialSlug: 'demo-tutorial' });
    expect(after.length).toBe(before.length);
  });

  it('rejects rating outside 0-10 with 400', async () => {
    const res = await POST('/api/submitTutorialFeedback', {
      tutorialSlug: 'demo-tutorial', ratingUseCase: 11,
      wasAuthenticated: false, honeypot: '', _clientIp: '10.0.0.4'
    }).catch(e => e.response);
    expect(res.status).toBe(400);
  });

  it('rate-limits the same IP after 5 submissions in an hour', async () => {
    for (let i = 0; i < 5; i++) {
      await POST('/api/submitTutorialFeedback', {
        tutorialSlug: 'demo-tutorial', wasAuthenticated: false, honeypot: '', _clientIp: '10.0.99.1'
      });
    }
    const res = await POST('/api/submitTutorialFeedback', {
      tutorialSlug: 'demo-tutorial', wasAuthenticated: false, honeypot: '', _clientIp: '10.0.99.1'
    }).catch(e => e.response);
    expect(res.status).toBe(429);
  });

  it('echoes wasAuthenticated into the persisted row', async () => {
    const { data } = await POST('/api/submitTutorialFeedback', {
      tutorialSlug: 'demo-tutorial', wasAuthenticated: true, honeypot: '', _clientIp: '10.0.0.50'
    });
    const row = await SELECT.one.from('com.sap.developers.ims.TutorialFeedback').where({ ID: data.submissionId });
    expect(row.wasAuthenticated).toBe(true);
  });
});
```

Note: tests POST directly to `/api/submitTutorialFeedback` (CAP's default action URL). The Express bridge at `/feedback/submit` is added in Task 6 — these tests exercise the action handler in isolation via CAP's built-in test harness.

- [ ] **Step 2: Run tests, confirm they fail**

```bash
npx vitest run srv/__tests__/tutorial-feedback.test.js
```

Expected: 6 failures (action not implemented).

- [ ] **Step 3: Implement handler in `srv/developer-service.js`**

Add at the top of the file (after existing requires):

```js
const { hashIp } = require('./lib/feedback-salt');

const RATE_LIMIT = new Map();
const RATE_WINDOW_MS = 60 * 60 * 1000;
const RATE_MAX = 5;
const RATE_SWEEP_INTERVAL_MS = 5 * 60 * 1000;

setInterval(() => {
  const cutoff = Date.now() - RATE_WINDOW_MS;
  for (const [k, v] of RATE_LIMIT) if (v.windowStart < cutoff) RATE_LIMIT.delete(k);
}, RATE_SWEEP_INTERVAL_MS).unref();

function rateLimitExceeded(hashedIp) {
  const now = Date.now();
  const cur = RATE_LIMIT.get(hashedIp);
  if (!cur || now - cur.windowStart > RATE_WINDOW_MS) {
    RATE_LIMIT.set(hashedIp, { count: 1, windowStart: now });
    return false;
  }
  cur.count += 1;
  return cur.count > RATE_MAX;
}

function isInt0to10(v) { return v == null || (Number.isInteger(v) && v >= 0 && v <= 10); }

function sanitizeComment(s) {
  if (!s) return null;
  return s.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '').slice(0, 2000);
}
```

Inside the service implementation function (alongside other handlers), add:

```js
this.on('submitTutorialFeedback', async (req) => {
  const d = req.data;

  // 1. Honeypot — silent success
  if (d.honeypot && d.honeypot.trim() !== '') {
    return { submissionId: cds.utils.uuid() };
  }

  // 2. Validate ratings
  for (const k of ['ratingUseCase','ratingRelevance','ratingDuration','ratingStructure','ratingInteresting','ratingVisuals','npsScore']) {
    if (!isInt0to10(d[k])) return req.error(400, `${k} must be an integer 0-10 or null`);
  }
  if (!d.tutorialSlug || typeof d.tutorialSlug !== 'string') return req.error(400, 'tutorialSlug required');

  // 3. Slug existence (against ContentFiles — source of truth for served tutorials)
  const { ContentFiles, TutorialFeedback } = cds.entities('com.sap.developers.ims');
  const exists = await SELECT.one.from(ContentFiles).columns('slug').where({ slug: d.tutorialSlug });
  if (!exists) return req.error(400, 'Unknown tutorial');

  // 4. Rate limit
  const ip = d._clientIp || 'unknown';
  const hashedIp = hashIp(ip);
  if (rateLimitExceeded(hashedIp)) return req.error(429, 'Too many submissions');

  // 5. Persist
  const id = cds.utils.uuid();
  await INSERT.into(TutorialFeedback).entries({
    ID: id,
    tutorialSlug:      d.tutorialSlug,
    wasAuthenticated:  !!d.wasAuthenticated,
    submitterIpHash:   hashedIp,
    ratingUseCase:     d.ratingUseCase     ?? null,
    ratingRelevance:   d.ratingRelevance   ?? null,
    ratingDuration:    d.ratingDuration    ?? null,
    ratingStructure:   d.ratingStructure   ?? null,
    ratingInteresting: d.ratingInteresting ?? null,
    ratingVisuals:     d.ratingVisuals     ?? null,
    npsScore:          d.npsScore          ?? null,
    comment:           sanitizeComment(d.comment)
  });

  return { submissionId: id };
});
```

- [ ] **Step 4: Run tests, confirm they pass**

```bash
npx vitest run srv/__tests__/tutorial-feedback.test.js
```

Expected: 6 passed.

- [ ] **Step 5: Commit**

```bash
git add srv/developer-service.js srv/__tests__/tutorial-feedback.test.js
git commit -m "feat(feedback): submitTutorialFeedback action handler with rate limit"
```

---

## Task 6: Express bridge in srv/server.js

**Files:**

- Modify: `srv/server.js`

- [ ] **Step 1: Read current `srv/server.js` to find the `cds.on('bootstrap')` block**

```bash
grep -n "cds.on('bootstrap'" srv/server.js
```

- [ ] **Step 2: Add the bridge inside the existing `cds.on('bootstrap', (app) => { ... })` callback**

```js
// Tutorial feedback — anonymous submission endpoint
app.post('/feedback/submit', express.json({ limit: '8kb' }), async (req, res) => {
  if (!process.env.SUBMISSION_SALT_SECRET) {
    return res.status(503).json({ error: 'feedback service unavailable' });
  }
  try {
    const dev = await cds.connect.to('DeveloperService');
    const xff = (req.headers['x-forwarded-for'] || '').split(',').map(s => s.trim()).filter(Boolean);
    const clientIp = xff.length ? xff[xff.length - 1] : req.ip;
    const result = await dev.send('submitTutorialFeedback', {
      ...req.body,
      _clientIp: clientIp
    });
    res.status(200).json({ submissionId: result.submissionId });
  } catch (e) {
    const status = (e.code === 400 || e.code === 429 || e.code === 503) ? e.code : 500;
    res.status(status).json({ error: e.message });
  }
});
```

If `express` is not yet required at the top of `srv/server.js`, add `const express = require('express');`.

- [ ] **Step 3: Smoke-check the route locally**

```bash
SUBMISSION_SALT_SECRET=devsecret npm run watch &
sleep 5
curl -s -X POST http://localhost:4004/feedback/submit \
  -H 'content-type: application/json' \
  -d '{"tutorialSlug":"nonexistent","wasAuthenticated":false,"honeypot":""}'
kill %1
```

Expected: `{"error":"Unknown tutorial"}` with HTTP 400.

- [ ] **Step 4: Commit**

```bash
git add srv/server.js
git commit -m "feat(feedback): Express bridge POST /feedback/submit"
```

---

## Task 7: AppRouter route for /feedback/

**Files:**

- Modify: `approuter/xs-app.json`

- [ ] **Step 1: Add the route above the catch-all (line ~189)**

Insert before the `^(.*)$` static catch-all, after `/build/`:

```json
{
  "source": "^/feedback/(.*)$",
  "target": "/feedback/$1",
  "destination": "srv-api",
  "authenticationType": "none",
  "csrfProtection": false
},
```

- [ ] **Step 2: Validate JSON**

```bash
node -e "JSON.parse(require('fs').readFileSync('approuter/xs-app.json'))" && echo OK
```

Expected: `OK`.

- [ ] **Step 3: Commit**

```bash
git add approuter/xs-app.json
git commit -m "feat(feedback): unauthenticated /feedback/ AppRouter route"
```

---

## Task 8: Admin projections

**Files:**

- Modify: `srv/admin-service.cds`

- [ ] **Step 1: Add inside `service AdminService { ... }`**

```cds
@readonly entity TutorialFeedback          as projection on db.TutorialFeedback;
@readonly entity TutorialFeedbackAggregate as projection on db.TutorialFeedbackAggregate;
```

- [ ] **Step 2: Verify CDS compiles**

```bash
npx cds compile srv/ --to sql > /dev/null
```

- [ ] **Step 3: Commit**

```bash
git add srv/admin-service.cds
git commit -m "feat(feedback): expose TutorialFeedback projections on AdminService"
```

---

## Task 9: Aggregate projection math test (hybrid)

**Files:**

- Create: `srv/__tests__/tutorial-feedback-aggregate.test.js`

- [ ] **Step 1: Write the test**

```js
// srv/__tests__/tutorial-feedback-aggregate.test.js
const { describe, it, expect, beforeAll, afterAll } = require('vitest');
const cds = require('@sap/cds');

process.env.SUBMISSION_SALT_SECRET = 'test-secret';
cds.test(__dirname + '/../..');

describe('TutorialFeedbackAggregate projection', () => {
  beforeAll(async () => {
    const db = await cds.connect.to('db');
    const { TutorialFeedback } = cds.entities('com.sap.developers.ims');
    await INSERT.into(TutorialFeedback).entries([
      { ID: cds.utils.uuid(), tutorialSlug: 'agg-test', npsScore: 10, ratingUseCase: 8 },
      { ID: cds.utils.uuid(), tutorialSlug: 'agg-test', npsScore: 9,  ratingUseCase: null },
      { ID: cds.utils.uuid(), tutorialSlug: 'agg-test', npsScore: 5,  ratingUseCase: 2 },
      { ID: cds.utils.uuid(), tutorialSlug: 'agg-test', npsScore: 3,  ratingUseCase: 4 }
    ]);
  });

  afterAll(async () => {
    const { TutorialFeedback } = cds.entities('com.sap.developers.ims');
    await DELETE.from(TutorialFeedback).where({ tutorialSlug: 'agg-test' });
  });

  it('groups by slug with correct counts and NPS arithmetic', async () => {
    const { TutorialFeedbackAggregate } = cds.entities('com.sap.developers.ims');
    const row = await SELECT.one.from(TutorialFeedbackAggregate).where({ tutorialSlug: 'agg-test' });
    expect(row.responseCount).toBe(4);
    expect(row.promoters).toBe(2);  // 10, 9
    expect(row.detractors).toBe(2); // 5, 3
    expect(Number(row.avgUseCase)).toBeCloseTo((8 + 2 + 4) / 3, 2); // null ignored
  });
});
```

- [ ] **Step 2: Run**

```bash
npx vitest run srv/__tests__/tutorial-feedback-aggregate.test.js
```

Expected: 1 passed.

- [ ] **Step 3: Commit**

```bash
git add srv/__tests__/tutorial-feedback-aggregate.test.js
git commit -m "test(feedback): aggregate projection math"
```

---

## Task 10: Vue form — types and API

**Files:**

- Create: `apps/src/tutorial-feedback/types.ts`
- Create: `apps/src/tutorial-feedback/api.ts`

- [ ] **Step 1: Write `types.ts`**

```ts
export type RatingScale = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | null;

export interface FeedbackSubmission {
  tutorialSlug: string;
  ratingUseCase: RatingScale;
  ratingRelevance: RatingScale;
  ratingDuration: RatingScale;
  ratingStructure: RatingScale;
  ratingInteresting: RatingScale;
  ratingVisuals: RatingScale;
  npsScore: RatingScale;
  comment: string;
  wasAuthenticated: boolean;
  honeypot: string;
}
```

- [ ] **Step 2: Write `api.ts`**

```ts
import type { FeedbackSubmission } from './types';

export async function probeAuth(): Promise<boolean> {
  try {
    const r = await fetch('/auth/user', { credentials: 'include' });
    return r.ok;
  } catch { return false; }
}

export async function submitFeedback(payload: FeedbackSubmission): Promise<{ submissionId: string }> {
  const r = await fetch('/feedback/submit', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload)
  });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
  return r.json();
}
```

- [ ] **Step 3: Commit**

```bash
git add apps/src/tutorial-feedback/types.ts apps/src/tutorial-feedback/api.ts
git commit -m "feat(feedback): Vue feedback API + types"
```

---

## Task 11: Vue form component

**Files:**

- Create: `apps/src/tutorial-feedback/TutorialFeedbackForm.vue`

- [ ] **Step 1: Write the component**

Use the existing modal CSS classes from `hugo/static/css/sap-fundamental.css` (`.popup-card`, `.popup-title`) for visual consistency. Component renders the seven Likert rows + NPS row + comment textarea + hidden honeypot.

```vue
<template>
  <div v-if="state === 'idle' || state === 'submitting' || state === 'error'">
    <h3 class="popup-title">How was this tutorial?</h3>
    <form @submit.prevent="onSubmit">
      <div v-for="row in rows" :key="row.key" class="feedback-row">
        <label>{{ row.label }}</label>
        <div class="feedback-scale">
          <button v-for="n in 11" :key="n" type="button"
                  :class="{ selected: form[row.key] === n - 1 }"
                  @click="form[row.key] = n - 1">{{ n - 1 }}</button>
          <button type="button" :class="{ selected: form[row.key] === null }"
                  @click="form[row.key] = null">N/A</button>
        </div>
      </div>
      <label class="feedback-row">
        <span>Anything else?</span>
        <textarea v-model="form.comment" maxlength="2000" rows="3"></textarea>
      </label>
      <input v-model="form.honeypot" type="text" name="honeypot"
             tabindex="-1" autocomplete="off" aria-hidden="true"
             style="position:absolute;left:-9999px" />
      <div v-if="state === 'error'" class="feedback-error">{{ error }}</div>
      <button type="submit" :disabled="state === 'submitting'" class="feedback-btn">
        {{ state === 'submitting' ? 'Submitting…' : 'Submit' }}
      </button>
    </form>
  </div>
  <div v-else-if="state === 'success'" class="feedback-success">
    <h3 class="popup-title">Thanks for your feedback!</h3>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, onMounted } from 'vue';
import { probeAuth, submitFeedback } from './api';
import type { FeedbackSubmission } from './types';

const props = defineProps<{ slug: string; onClose: () => void }>();

const rows = [
  { key: 'ratingUseCase',     label: 'Helpful for my use case' },
  { key: 'ratingRelevance',   label: 'Relevant to my work' },
  { key: 'ratingDuration',    label: 'Right length' },
  { key: 'ratingStructure',   label: 'Well structured' },
  { key: 'ratingInteresting', label: 'Interesting' },
  { key: 'ratingVisuals',     label: 'Good visuals & code samples' },
  { key: 'npsScore',          label: 'Likely to recommend to a colleague' }
] as const;

const state = ref<'idle' | 'submitting' | 'success' | 'error'>('idle');
const error = ref('');
const form = reactive<FeedbackSubmission>({
  tutorialSlug: props.slug,
  ratingUseCase: null, ratingRelevance: null, ratingDuration: null,
  ratingStructure: null, ratingInteresting: null, ratingVisuals: null,
  npsScore: null, comment: '', wasAuthenticated: false, honeypot: ''
});

onMounted(async () => { form.wasAuthenticated = await probeAuth(); });

async function onSubmit() {
  state.value = 'submitting';
  try {
    await submitFeedback(form);
    state.value = 'success';
    setTimeout(() => props.onClose(), 2000);
  } catch (e: any) {
    error.value = e.message || 'Submission failed';
    state.value = 'error';
  }
}
</script>

<style scoped>
.feedback-row { display: flex; flex-direction: column; gap: 0.5rem; margin-bottom: 1rem; }
.feedback-scale { display: flex; gap: 0.25rem; flex-wrap: wrap; }
.feedback-scale button { min-width: 2rem; padding: 0.25rem; border: 1px solid var(--sapButton_BorderColor, #ccc); background: var(--sapButton_Background, #fff); cursor: pointer; }
.feedback-scale button.selected { background: var(--sapButton_Selected_Background, #0070f2); color: var(--sapButton_Selected_TextColor, #fff); }
.feedback-error { color: #b00; margin: 0.5rem 0; }
</style>
```

- [ ] **Step 2: Commit**

```bash
git add apps/src/tutorial-feedback/TutorialFeedbackForm.vue
git commit -m "feat(feedback): Vue feedback form component"
```

---

## Task 12: Vue mount entry + Vite config

**Files:**

- Create: `apps/src/tutorial-feedback/main.ts`
- Modify: `apps/vite.config.ts`

- [ ] **Step 1: Write `main.ts`**

```ts
import { createApp, h } from 'vue';
import TutorialFeedbackForm from './TutorialFeedbackForm.vue';

export function mount(slug: string, popupId: string) {
  const mountId = 'tutorial-feedback-mount';
  const el = document.getElementById(mountId);
  if (!el || el.dataset.mounted) return;
  el.dataset.mounted = '1';
  const close = () => {
    const popup = document.getElementById(popupId);
    if (popup) popup.classList.add('popup-hidden');
  };
  createApp({
    render: () => h(TutorialFeedbackForm, { slug, onClose: close })
  }).mount(el);
}

(window as any).mountTutorialFeedback = mount;
```

- [ ] **Step 2: Add the entry to `apps/vite.config.ts`**

In `rollupOptions.input`, add a line:

```ts
'tutorial-feedback': resolve(__dirname, 'src/tutorial-feedback/main.ts'),
```

- [ ] **Step 3: Build and confirm output**

```bash
npm run build:apps
ls hugo/static/js/tutorial-feedback.js
```

Expected: file exists, size 5-15 kB.

- [ ] **Step 4: Commit**

```bash
git add apps/src/tutorial-feedback/main.ts apps/vite.config.ts
git commit -m "feat(feedback): Vue mount entry + Vite input"
```

---

## Task 13: Hugo template change

**Files:**

- Modify: `hugo/layouts/partials/feedback-share.html`

- [ ] **Step 1: Replace the third `.feedback-option` block (Qualtrics)**

Find the block whose anchor href starts with `https://sapinsights.eu.qualtrics.com` (lines 40-44 in the existing file). Replace the entire `<div class="feedback-option">…</div>` with:

```html
<div class="feedback-option">
  <svg class="feedback-icon" width="48" height="48" viewBox="0 0 48 48" fill="none">
    <rect x="10" y="12" width="28" height="20" rx="2" stroke="currentColor" stroke-width="2" fill="none"/>
    <path d="M10 16l14 10 14-10" stroke="currentColor" stroke-width="2" fill="none"/>
  </svg>
  <span>Send us your thoughts</span>
  <button type="button" class="feedback-btn" onclick="openTutorialFeedbackPopup('{{ .Params.slug }}')">
    Give feedback
  </button>
</div>
```

- [ ] **Step 2: Add a new popup div before `<script>` (around line 67)**

```html
<!-- Tutorial feedback popup -->
<div id="tutorial-feedback-popup" class="popup-overlay popup-hidden" onclick="if(event.target===this)closePopups()">
  <div class="popup-card">
    <button type="button" class="popup-close" onclick="closePopups()" aria-label="Close">&times;</button>
    <div id="tutorial-feedback-mount"></div>
  </div>
</div>
```

- [ ] **Step 3: Extend the `<script>` block with lazy-loader and popup opener**

Append inside the existing `<script>...</script>`:

```js
function openTutorialFeedbackPopup(slug) {
  closePopups();
  document.getElementById('tutorial-feedback-popup').classList.remove('popup-hidden');
  if (window.mountTutorialFeedback) {
    window.mountTutorialFeedback(slug, 'tutorial-feedback-popup');
    return;
  }
  const s = document.createElement('script');
  s.type = 'module';
  s.src = '/js/tutorial-feedback.js';
  s.onload = () => window.mountTutorialFeedback(slug, 'tutorial-feedback-popup');
  document.head.appendChild(s);
}
```

Update `closePopups()` to also hide the new popup:

```js
function closePopups() {
  document.getElementById('feedback-popup').classList.add('popup-hidden');
  document.getElementById('share-popup').classList.add('popup-hidden');
  document.getElementById('tutorial-feedback-popup').classList.add('popup-hidden');
}
```

- [ ] **Step 4: Build Hugo and visually verify on a tutorial page**

```bash
npm run dev
# Open http://localhost:1313/tutorials/<any-slug>/, click Feedback → "Give feedback"
```

Expected: popup opens, form renders with seven rating rows + textarea.

- [ ] **Step 5: Commit**

```bash
git add hugo/layouts/partials/feedback-share.html
git commit -m "feat(feedback): replace Qualtrics card with Vue form modal"
```

---

## Task 14: Admin annotations

**Files:**

- Modify: `app/admin-annotations.cds`

- [ ] **Step 1: Append annotations**

```cds
annotate AdminService.TutorialFeedback with @(
  Capabilities.InsertRestrictions: { Insertable: false },
  Capabilities.UpdateRestrictions: { Updatable: false },
  Capabilities.DeleteRestrictions: { Deletable: false },
  UI.HeaderInfo: {
    TypeName: 'Submission',
    TypeNamePlural: 'Submissions',
    Title: { Value: tutorialSlug }
  },
  UI.SelectionFields: [tutorialSlug, wasAuthenticated, submittedAt],
  UI.LineItem: [
    { Value: tutorialSlug },
    { Value: submittedAt },
    { Value: wasAuthenticated },
    { Value: npsScore },
    { Value: ratingUseCase },
    { Value: ratingRelevance },
    { Value: ratingDuration },
    { Value: ratingStructure },
    { Value: ratingInteresting },
    { Value: ratingVisuals },
    { Value: comment }
  ],
  UI.FieldGroup #Ratings: { Data: [
    { Value: ratingUseCase },
    { Value: ratingRelevance },
    { Value: ratingDuration },
    { Value: ratingStructure },
    { Value: ratingInteresting },
    { Value: ratingVisuals },
    { Value: npsScore }
  ]},
  UI.Facets: [
    { $Type: 'UI.ReferenceFacet', Label: 'Ratings', Target: '@UI.FieldGroup#Ratings' },
    { $Type: 'UI.ReferenceFacet', Label: 'Comment', Target: '@UI.FieldGroup#CommentGroup' }
  ],
  UI.FieldGroup #CommentGroup: { Data: [{ Value: comment }] }
);
```

- [ ] **Step 2: Compile**

```bash
npx cds compile srv/ --to sql > /dev/null
```

- [ ] **Step 3: Commit**

```bash
git add app/admin-annotations.cds
git commit -m "feat(feedback): UI annotations for TutorialFeedback admin"
```

---

## Task 15: Admin Fiori Elements app

**Files:**

- Create: `app/admin/feedback/webapp/manifest.json`
- Create: `app/admin/feedback/webapp/Component.js`
- Create: `app/admin/feedback/webapp/index.html`
- Create: `app/admin/feedback/webapp/i18n/i18n.properties`

- [ ] **Step 1: Copy the structure from a sibling app (e.g. `app/admin/tags/`) and adapt**

```bash
cp -r app/admin/tags/webapp app/admin/feedback/
# Then edit manifest.json: change app id to "feedback", entitySet to "TutorialFeedback",
# and contextPath to "/TutorialFeedback".
```

Key fields in `manifest.json`:

```json
"sap.app": { "id": "tutorials.admin.feedback", "type": "application" },
"sap.ui5": {
  "rootView": { ... },
  "routing": {
    "routes": [
      { "name": "FeedbackList", "pattern": ":?query:", "target": "FeedbackList" },
      { "name": "FeedbackObject", "pattern": "TutorialFeedback({key}):?query:", "target": "FeedbackObject" }
    ],
    "targets": {
      "FeedbackList": {
        "type": "Component", "id": "FeedbackList", "name": "sap.fe.templates.ListReport",
        "options": { "settings": { "contextPath": "/TutorialFeedback", "navigation": { "TutorialFeedback": { "detail": { "route": "FeedbackObject" } } } } }
      },
      "FeedbackObject": {
        "type": "Component", "id": "FeedbackObject", "name": "sap.fe.templates.ObjectPage",
        "options": { "settings": { "contextPath": "/TutorialFeedback" } }
      }
    }
  }
}
```

- [ ] **Step 2: Update `i18n.properties`**

```properties
appTitle=Tutorial Feedback
appDescription=View tutorial feedback submissions
```

- [ ] **Step 3: Commit**

```bash
git add app/admin/feedback/
git commit -m "feat(feedback): admin Fiori Elements List Report"
```

---

## Task 16: Admin shell — Feedback dashboard view

**Files:**

- Create: `app/admin-shell/webapp/view/TutorialFeedbackDashboard.view.xml`
- Create: `app/admin-shell/webapp/controller/TutorialFeedbackDashboard.controller.js`

- [ ] **Step 1: Write the view (mirror `Board.view.xml` shape)**

```xml
<mvc:View
  controllerName="tutorials.adminshell.controller.TutorialFeedbackDashboard"
  xmlns="sap.m" xmlns:mvc="sap.ui.core.mvc" xmlns:l="sap.ui.layout">
  <Page title="Tutorial Feedback Dashboard" showHeader="true">
    <l:Grid defaultSpan="L3 M6 S12">
      <GenericTile header="Total Responses" subheader="All time" press=".onOpenList">
        <TileContent><NumericContent value="{/totalResponses}" /></TileContent>
      </GenericTile>
      <GenericTile header="Avg NPS" subheader="Last 90 days">
        <TileContent><NumericContent value="{/avgNps90d}" /></TileContent>
      </GenericTile>
      <GenericTile header="Avg Overall Rating" subheader="All time">
        <TileContent><NumericContent value="{/avgOverall}" /></TileContent>
      </GenericTile>
      <GenericTile header="% Authenticated" subheader="Submitter logged in">
        <TileContent><NumericContent value="{/pctAuthenticated}" valueColor="Neutral" /></TileContent>
      </GenericTile>
    </l:Grid>
    <Table items="{/aggregates}" growing="true" growingThreshold="50">
      <columns>
        <Column><Text text="Tutorial" /></Column>
        <Column><Text text="Responses" /></Column>
        <Column><Text text="Avg NPS" /></Column>
        <Column><Text text="Promoters" /></Column>
        <Column><Text text="Detractors" /></Column>
      </columns>
      <items>
        <ColumnListItem type="Active" press=".onRowPress">
          <cells>
            <Text text="{tutorialSlug}" />
            <Text text="{responseCount}" />
            <Text text="{avgNps}" />
            <Text text="{promoters}" />
            <Text text="{detractors}" />
          </cells>
        </ColumnListItem>
      </items>
    </Table>
    <Panel headerText="Recent comments">
      <List items="{/recentComments}">
        <FeedListItem text="{comment}" sender="{tutorialSlug}" timestamp="{submittedAt}" />
      </List>
    </Panel>
  </Page>
</mvc:View>
```

Note: `text="{comment}"` is mandatory (XSS — NEVER use `htmlText`).

- [ ] **Step 2: Write the controller**

```js
sap.ui.define([
  "sap/ui/core/mvc/Controller",
  "sap/ui/model/json/JSONModel"
], function (Controller, JSONModel) {
  "use strict";
  return Controller.extend("tutorials.adminshell.controller.TutorialFeedbackDashboard", {
    onInit: function () {
      const oModel = new JSONModel({
        totalResponses: 0, avgNps90d: 0, avgOverall: 0, pctAuthenticated: 0,
        aggregates: [], recentComments: []
      });
      this.getView().setModel(oModel);
      this._refresh();
    },

    _refresh: async function () {
      const oModel = this.getView().getModel();
      const [aggRes, rawRes90d, rawAuth] = await Promise.all([
        fetch('/admin/TutorialFeedbackAggregate'),
        fetch(`/admin/TutorialFeedback?$filter=submittedAt ge ${new Date(Date.now() - 90*24*3600*1000).toISOString()}&$select=npsScore`),
        fetch('/admin/TutorialFeedback?$select=wasAuthenticated&$top=10000')
      ]);
      const agg = (await aggRes.json()).value || [];
      const recent = (await fetch('/admin/TutorialFeedback?$orderby=submittedAt desc&$top=10&$filter=comment ne null').then(r => r.json())).value || [];
      const npsRows = (await rawRes90d.json()).value || [];
      const authRows = (await rawAuth.json()).value || [];

      oModel.setProperty('/aggregates', agg);
      oModel.setProperty('/recentComments', recent);
      oModel.setProperty('/totalResponses', agg.reduce((s, r) => s + r.responseCount, 0));
      oModel.setProperty('/avgNps90d', npsRows.length ? (npsRows.reduce((s, r) => s + (r.npsScore ?? 0), 0) / npsRows.filter(r => r.npsScore != null).length).toFixed(1) : 0);
      oModel.setProperty('/avgOverall', agg.length ? (agg.reduce((s, r) => s + Number(r.avgUseCase || 0), 0) / agg.length).toFixed(1) : 0);
      oModel.setProperty('/pctAuthenticated', authRows.length ? Math.round(100 * authRows.filter(r => r.wasAuthenticated).length / authRows.length) : 0);
    },

    onRowPress: function (oEvent) {
      const slug = oEvent.getSource().getBindingContext().getProperty('tutorialSlug');
      this.getOwnerComponent().getRouter().navTo('feedbackList', { '?query': { '$filter': `tutorialSlug eq '${slug}'` } });
    },

    onOpenList: function () {
      this.getOwnerComponent().getRouter().navTo('feedbackList');
    }
  });
});
```

- [ ] **Step 3: Commit**

```bash
git add app/admin-shell/webapp/view/TutorialFeedbackDashboard.view.xml app/admin-shell/webapp/controller/TutorialFeedbackDashboard.controller.js
git commit -m "feat(feedback): admin shell dashboard view + controller"
```

---

## Task 17: Admin shell — side nav wiring

**Files:**

- Modify: `app/admin-shell/webapp/manifest.json`

- [ ] **Step 1: Add `feedback` to `componentUsages`**

Inside `"sap.ui5": { "componentUsages": { ... } }`:

```json
"feedback": {
  "name": "tutorials.admin.feedback",
  "settings": {},
  "componentData": {},
  "lazy": true
}
```

- [ ] **Step 2: Add side-nav group**

Locate the side-nav configuration (existing groups for Operations, System, etc.) and add:

```json
{
  "title": "Feedback",
  "icon": "sap-icon://feedback",
  "items": [
    { "key": "feedbackList",      "title": "All Submissions", "componentUsage": "feedback" },
    { "key": "feedbackDashboard", "title": "Dashboard",        "viewName": "TutorialFeedbackDashboard" }
  ]
}
```

- [ ] **Step 3: Add route for the dashboard view**

In `routing.routes`:

```json
{ "name": "feedbackDashboard", "pattern": "feedback/dashboard", "target": "feedbackDashboard" }
```

In `routing.targets`:

```json
"feedbackDashboard": { "type": "View", "id": "feedbackDashboard", "name": "TutorialFeedbackDashboard" }
```

- [ ] **Step 4: Verify JSON parses**

```bash
node -e "JSON.parse(require('fs').readFileSync('app/admin-shell/webapp/manifest.json'))" && echo OK
```

- [ ] **Step 5: Build admin shell and visually verify**

```bash
npm run build:admin
# Then in dev: open /admin-ui/, confirm "Feedback" group appears with "All Submissions" + "Dashboard"
```

- [ ] **Step 6: Commit**

```bash
git add app/admin-shell/webapp/manifest.json
git commit -m "feat(feedback): admin shell side-nav Feedback group"
```

---

## Task 18: Hybrid test (real HANA)

**Files:**

- Create: `test/hybrid/feedback.test.js`

- [ ] **Step 1: Write the hybrid test**

```js
// test/hybrid/feedback.test.js
const { describe, it, expect, beforeAll, afterAll } = require('vitest');
const cds = require('@sap/cds');
require('./_guard'); // existing write-safety guard

const TEST_SLUG = '__TEST__feedback-hybrid';

describe('TutorialFeedback (HANA)', () => {
  let db;

  beforeAll(async () => {
    db = await cds.connect.to('db');
    const { ContentFiles } = cds.entities('com.sap.developers.ims');
    await INSERT.into(ContentFiles).entries([{ slug: TEST_SLUG, version: 1, contentType: 'tutorial' }]);
  });

  afterAll(async () => {
    const { TutorialFeedback, ContentFiles } = cds.entities('com.sap.developers.ims');
    await DELETE.from(TutorialFeedback).where({ tutorialSlug: TEST_SLUG });
    await DELETE.from(ContentFiles).where({ slug: TEST_SLUG });
  });

  it('insert + aggregate roundtrip', async () => {
    const { TutorialFeedback, TutorialFeedbackAggregate } = cds.entities('com.sap.developers.ims');
    await INSERT.into(TutorialFeedback).entries([
      { ID: cds.utils.uuid(), tutorialSlug: TEST_SLUG, npsScore: 10, ratingUseCase: 8 },
      { ID: cds.utils.uuid(), tutorialSlug: TEST_SLUG, npsScore: 3,  ratingUseCase: 4 }
    ]);
    const agg = await SELECT.one.from(TutorialFeedbackAggregate).where({ tutorialSlug: TEST_SLUG });
    expect(agg.responseCount).toBe(2);
    expect(agg.promoters).toBe(1);
    expect(agg.detractors).toBe(1);
  });
});
```

- [ ] **Step 2: Run against HANA**

```bash
ALLOW_HYBRID_WRITES=true npm run test:hybrid -- feedback
```

Expected: 1 passed.

- [ ] **Step 3: Commit**

```bash
git add test/hybrid/feedback.test.js
git commit -m "test(feedback): hybrid HANA insert + aggregate"
```

---

## Task 19: Smoke test (deployed endpoint)

**Files:**

- Create: `test/smoke/feedback.test.js`

- [ ] **Step 1: Write smoke test**

```js
// test/smoke/feedback.test.js
const { describe, it, expect } = require('vitest');

const BASE = process.env.SMOKE_BASE_URL;
if (!BASE) throw new Error('SMOKE_BASE_URL not set');

describe('feedback smoke', () => {
  it('rejects unknown slug with 400', async () => {
    const r = await fetch(`${BASE}/feedback/submit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tutorialSlug: 'nonexistent-smoke', wasAuthenticated: false, honeypot: '' })
    });
    expect(r.status).toBe(400);
  });

  it('honeypot returns 200 (silent reject)', async () => {
    const r = await fetch(`${BASE}/feedback/submit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tutorialSlug: 'nonexistent-smoke', wasAuthenticated: false, honeypot: 'bot' })
    });
    expect(r.status).toBe(200);
  });

  it('admin endpoint requires auth (401)', async () => {
    const r = await fetch(`${BASE.replace(/-approuter/, '-tutorials-srv')}/admin/TutorialFeedback`);
    expect([401, 403]).toContain(r.status);
  });
});
```

- [ ] **Step 2: Run against deployed env (CI does this automatically post-deploy)**

```bash
SMOKE_BASE_URL=https://tutorial-system-dev.cfapps.eu10-005.hana.ondemand.com \
  npm run test:smoke -- feedback
```

- [ ] **Step 3: Commit**

```bash
git add test/smoke/feedback.test.js
git commit -m "test(feedback): smoke tests for /feedback/submit"
```

---

## Task 20: Document `SUBMISSION_SALT_SECRET`

**Files:**

- Modify: `CLAUDE.md`

- [ ] **Step 1: Add a bullet under "Gotchas" near the existing `CONTENT_API_KEY` entry**

```markdown
- **`SUBMISSION_SALT_SECRET` env var** — Required by `srv/lib/feedback-salt.js` for IP hashing. The Express bridge at `/feedback/submit` returns 503 if missing. Set in CI secrets and locally when testing the feedback form. Rotation invalidates in-memory rate-limit keys (acceptable).
```

- [ ] **Step 2: Set the env var in `mta.yaml` for the `tutorials-srv` module**

In `.deploy/mta.yaml`, locate the `tutorials-srv` module's `properties` and add:

```yaml
SUBMISSION_SALT_SECRET: "${feedback-salt-secret}"
```

And in the resources section, add (or reference an existing) parameter:

```yaml
- name: feedback-salt-secret
  type: org.cloudfoundry.existing-service
  parameters:
    type: user-provided
```

(Or follow whatever pattern the existing `CONTENT_API_KEY` uses — match its mechanism.)

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md .deploy/mta.yaml
git commit -m "docs(feedback): document SUBMISSION_SALT_SECRET env var"
```

---

## Task 21: Final integration check

- [ ] **Step 1: Full local build**

```bash
npm run build:all
```

Expected: no errors.

- [ ] **Step 2: Run all unit tests**

```bash
npm test
```

Expected: all green, including the 3 new test files.

- [ ] **Step 3: Manual verification on local hybrid dev**

```bash
# Terminal 1: CAP with HANA binding
SUBMISSION_SALT_SECRET=devsecret CONTENT_API_KEY=<DEV-content-api-key> \
  npx cds bind --exec -- npm run watch:hybrid

# Terminal 2: AppRouter
npm run start:approuter
```

Walk through the manual checklist from the spec:

1. Open a tutorial, click Feedback → modal renders
2. Submit anonymously → success
3. Log in, submit → admin row shows `wasAuthenticated: true`
4. Open `/admin-ui/` → Feedback group visible
5. Open Dashboard → KPI tiles populated
6. Open List Report → Object Page drill-down works
7. Try `<script>alert(1)</script>` in comment → renders escaped (NOT executed)

- [ ] **Step 4: Update TODO.md**

If a relevant TODO item exists for "Replace Qualtrics" or "Tutorial feedback", mark it done.

```bash
git add TODO.md
git commit -m "docs: mark tutorial feedback form as done in TODO"
```

---

## Done

The feature is complete when:

- All 21 tasks committed
- Unit + hybrid + smoke tests pass
- Manual checklist verified
- `SUBMISSION_SALT_SECRET` set in DEV space (`cf set-env tutorials-srv SUBMISSION_SALT_SECRET <value>` + restart)
- Deployed and visible in production admin shell
