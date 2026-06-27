# Author-Nudge Digest + "Last Chance" Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Refactor the weekly author-nudge cron to send one digest email per author (grouping all of that author's stale tutorials), and add two admin-triggered "Last Chance" actions (per-author + bulk sweep) driven by a dedicated `last-chance.html` template.

**Architecture:** Additive wrap on top of #545's existing infrastructure. New helpers (`groupNotificationsByAuthor`, `digestSubject`, `renderTutorialList`, `determineRecipientsForDigest`) live in `srv/lib/contributor-notifications.js`. New optional `template` parameter on `sendNotificationEmail` selects template by base name. Legacy per-tutorial path stays reachable behind `ImsConfig.useDigestNotifications=false` (default `true`).

**Tech Stack:** CAP (Node.js, ESM), SAP HANA Cloud, nodemailer, Vitest, Fiori Elements (admin UI), `@cap-js/audit-logging`. Spec at [2026-06-27-622-author-digest-last-chance-design.md](../specs/2026-06-27-622-author-digest-last-chance-design.md).

---

## File Structure

**Modify:**
- `srv/lib/mail-client.js` — widen `loadTemplate()` and `sendNotificationEmail()` to accept a `template` base-name string.
- `srv/lib/contributor-notifications.js` — add `groupNotificationsByAuthor()`, `digestSubject()`, `renderTutorialList()`, `determineRecipientsForDigest()`, `escapeHtml()`. Extend `TIMING_KNOBS` with 3 new entries (1 bool + 2 int) and add type-aware parser. Widen `computeStaleNotifications()` SELECT to include `author.email` + `author.displayName`.
- `srv/jobs/scheduler.js` — branch weekly cron body on `knobs.useDigest`.
- `srv/admin-service.cds` — add `sendLastChanceEmail` + `sendLastChanceEmailsAllDormant` actions and a `DormantAuthors` view.
- `srv/admin-service.js` — implement both actions.
- `db/data/com.sap.developers.ims-ImsConfig.csv` — seed 3 new rows.
- `app/admin-annotations.cds` — annotations for the `DormantAuthors` view + actions tile.
- `app/admin/operations/` — Fiori OP extension for the new tile.
- `docs/developers/operations/smtp-credentials-rotation.md` — note new actions exist.
- `test/unit/templates-notification.test.js` — extend for 5 new templates.

**Create (templates):**
- `srv/templates/notification/digest-level-{0,1,2,3}.html`
- `srv/templates/notification/last-chance.html`

**Create (tests):**
- `test/unit/mail-client-template-param.test.js`
- `test/unit/render-tutorial-list.test.js`
- `test/unit/digest-subject.test.js`
- `test/unit/group-notifications-by-author.test.js`
- `test/unit/resolve-timing-knobs-bool.test.js`
- `test/unit/determine-recipients-for-digest.test.js`
- `test/unit/cron-digest-mode.test.js`
- `test/unit/admin-last-chance-action.test.js`
- `test/unit/admin-bulk-last-chance.test.js`
- `test/hybrid/digest-cron.test.js`
- `test/smoke/admin-last-chance.smoke.test.js`

**Conventions in this codebase to know:**
- Tests: `npm test` (unit, in-memory SQLite), `npm run test:hybrid` (real HANA via `cds bind --exec`; needs `cf login` to DEV space; honors `ALLOW_HYBRID_WRITES=true`), `npm run test:smoke` (HTTP against deployed; `SMOKE_BASE_URL` + `SMOKE_SRV_URL`).
- ESM throughout (`"type": "module"`). Use `import`/`export`.
- Module-singleton-multiplicity on Vitest+CDS Windows uses `globalThis[Symbol.for(...)]` pattern (see `srv/lib/mail-client.js:18-23`).
- HDI seed CSVs use semicolon delimiter, header `ID;legacyId;key;value` for `ImsConfig`. UUIDs explicit so re-import is idempotent.
- New `db/schema.cds` changes require `cds build --production` before commit. **No schema changes in this plan** — `ImsConfig` already exists; we only seed new rows.
- Run tests in a single project filter where possible (`npx vitest run --project unit test/unit/<file>`) for fast iteration.

---

## Task 1: Widen `mail-client.js` to accept a `template` base-name parameter

**Files:**
- Modify: `srv/lib/mail-client.js:90-94` (loadTemplate), `srv/lib/mail-client.js:100` (sendNotificationEmail)
- Test: `test/unit/mail-client-template-param.test.js` (new)

Load-bearing API change. Must land first.

- [ ] **Step 1: Write the failing test**

Create `test/unit/mail-client-template-param.test.js`:

```javascript
import { describe, it, expect } from 'vitest';
import { loadTemplate } from '../../srv/lib/mail-client.js';

describe('loadTemplate — accepts numeric level or base name', () => {
  it('numeric level still works (legacy path)', () => {
    expect(loadTemplate(0)).toMatch(/first reminder/i);
    expect(loadTemplate(3)).toMatch(/deadline for reviewing/i);
  });

  it('base name string reads the matching .html file', () => {
    expect(loadTemplate('first')).toMatch(/first reminder/i);
    expect(loadTemplate('final')).toMatch(/deadline for reviewing/i);
  });

  it('unknown base name throws', () => {
    expect(() => loadTemplate('no-such-template')).toThrow();
  });

  it('rejects base names with path separators or ".." (defense-in-depth)', () => {
    expect(() => loadTemplate('../etc/passwd')).toThrow();
    expect(() => loadTemplate('foo/bar')).toThrow();
    expect(() => loadTemplate('foo\\bar')).toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --project unit test/unit/mail-client-template-param.test.js`
Expected: FAIL — `loadTemplate('first')` throws because `TEMPLATE_NAMES['first']` is `undefined`.

- [ ] **Step 3: Implement — widen `loadTemplate` and `sendNotificationEmail`**

In `srv/lib/mail-client.js`, replace the `loadTemplate` function (lines 90-94):

```javascript
export function loadTemplate(levelOrName) {
  let name;
  if (typeof levelOrName === 'number') {
    name = TEMPLATE_NAMES[levelOrName];
    if (!name) throw new Error(`Invalid notification level: ${levelOrName}`);
  } else if (typeof levelOrName === 'string') {
    if (levelOrName.includes('/') || levelOrName.includes('\\') || levelOrName.includes('..')) {
      throw new Error(`Invalid template name: ${levelOrName}`);
    }
    name = levelOrName;
  } else {
    throw new Error(`loadTemplate requires a number or string, got ${typeof levelOrName}`);
  }
  return readFileSync(join(TEMPLATE_DIR, `${name}.html`), 'utf-8');
}
```

On line 100, change the `sendNotificationEmail` signature and the `loadTemplate` call:

```javascript
export async function sendNotificationEmail({ to, cc, subject, level, variables, template }) {
  const LOG = cds.log('mail');
  // template takes precedence over level when provided.
  // Legacy callers passing only level get byte-identical behavior.
  const templateKey = template ?? level;
  const html = resolveTemplate(loadTemplate(templateKey), variables);
  // ... rest unchanged
```

- [ ] **Step 4: Run tests to verify pass + no regression**

Run: `npx vitest run --project unit test/unit/mail-client-template-param.test.js test/unit/templates-notification.test.js`
Expected: PASS — new file all 4 cases; existing templates file all cases.

- [ ] **Step 5: Commit**

```bash
git add srv/lib/mail-client.js test/unit/mail-client-template-param.test.js
git commit -m "feat(#622): sendNotificationEmail accepts template base-name param

loadTemplate() now accepts either a numeric level (legacy ladder) or a
string base name. sendNotificationEmail() gains an optional template
param that takes precedence over level. Defense-in-depth rejects path
separators in template names.

Refs #622"
```

---

## Task 2: Add `escapeHtml` + `renderTutorialList` helpers

**Files:**
- Modify: `srv/lib/contributor-notifications.js` (append exports)
- Test: `test/unit/render-tutorial-list.test.js` (new)

- [ ] **Step 1: Write the failing test**

Create `test/unit/render-tutorial-list.test.js`:

```javascript
import { describe, it, expect } from 'vitest';
import { renderTutorialList, escapeHtml } from '../../srv/lib/contributor-notifications.js';

describe('escapeHtml', () => {
  it('escapes &, <, >, ", and \'', () => {
    expect(escapeHtml('Tom & Jerry')).toBe('Tom &amp; Jerry');
    expect(escapeHtml('<script>')).toBe('&lt;script&gt;');
    expect(escapeHtml(`"hello"`)).toBe('&quot;hello&quot;');
    expect(escapeHtml("it's")).toBe('it&#39;s');
  });

  it('handles null/undefined gracefully', () => {
    expect(escapeHtml(null)).toBe('');
    expect(escapeHtml(undefined)).toBe('');
  });
});

describe('renderTutorialList', () => {
  const dashboardUrl = 'https://example.com/dashboard';

  it('renders <ul> with one <li> per tutorial', () => {
    const html = renderTutorialList([
      { title: 'A', slug: 'a', reviewedDate: '2025-01-01T00:00:00.000Z' },
      { title: 'B', slug: 'b', reviewedDate: '2025-02-15T00:00:00.000Z' },
    ], dashboardUrl);
    expect(html).toMatch(/^<ul>/);
    expect(html).toMatch(/<\/ul>$/);
    expect(html.match(/<li>/g)).toHaveLength(2);
    expect(html).toContain('>A</a>');
    expect(html).toContain('>B</a>');
    expect(html).toContain('2025-01-01');
    expect(html).toContain('2025-02-15');
  });

  it('HTML-escapes titles', () => {
    const html = renderTutorialList(
      [{ title: '<script>alert(1)</script>', slug: 's', reviewedDate: '2025-01-01' }],
      dashboardUrl
    );
    expect(html).not.toContain('<script>alert');
    expect(html).toContain('&lt;script&gt;');
  });

  it('URL-encodes slug in anchor href', () => {
    const html = renderTutorialList(
      [{ title: 'X', slug: 'has spaces & ampersand', reviewedDate: '2025-01-01' }],
      dashboardUrl
    );
    expect(html).toContain('has%20spaces%20%26%20ampersand');
  });

  it('preserves dashboardUrl', () => {
    const html = renderTutorialList(
      [{ title: 'X', slug: 's', reviewedDate: '2025-01-01' }],
      'https://custom.example/foo'
    );
    expect(html).toContain('href="https://custom.example/foo#/tutorial/s"');
  });

  it('falls back to em-dash when reviewedDate is null', () => {
    const html = renderTutorialList(
      [{ title: 'X', slug: 's', reviewedDate: null }],
      dashboardUrl
    );
    expect(html).toContain('last reviewed —');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --project unit test/unit/render-tutorial-list.test.js`
Expected: FAIL — both helpers are not exported.

- [ ] **Step 3: Implement**

Append to `srv/lib/contributor-notifications.js`:

```javascript
/**
 * HTML-escape a string for safe embedding in attribute or text contexts.
 * Defense-in-depth — tutorial titles come from controlled sources, but
 * the cost is negligible.
 */
export function escapeHtml(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Pre-render the per-tutorial <ul> for digest + last-chance emails.
 * Returns the HTML string for substitution as ${tutorialListHtml}.
 * Avoids extending resolveTemplate() to support iteration.
 *
 * @param {Array<{title:string, slug:string, reviewedDate:string|null}>} tutorials
 * @param {string} dashboardUrl
 * @returns {string}
 */
export function renderTutorialList(tutorials, dashboardUrl) {
  const items = tutorials.map(t => {
    const title = escapeHtml(t.title);
    const slug = encodeURIComponent(t.slug);
    const date = t.reviewedDate ? String(t.reviewedDate).slice(0, 10) : '—';
    return `<li><a href="${dashboardUrl}#/tutorial/${slug}">${title}</a> — last reviewed ${date}</li>`;
  });
  return `<ul>${items.join('')}</ul>`;
}
```

- [ ] **Step 4: Run tests to verify pass**

Run: `npx vitest run --project unit test/unit/render-tutorial-list.test.js`
Expected: PASS (all 7 cases).

- [ ] **Step 5: Commit**

```bash
git add srv/lib/contributor-notifications.js test/unit/render-tutorial-list.test.js
git commit -m "feat(#622): add escapeHtml + renderTutorialList helpers

Pre-render <ul> for digest + last-chance emails; HTML-escapes title,
URL-encodes slug, formats date as YYYY-MM-DD with em-dash fallback.

Refs #622"
```

---

## Task 3: Add `digestSubject` helper

**Files:**
- Modify: `srv/lib/contributor-notifications.js`
- Test: `test/unit/digest-subject.test.js` (new)

- [ ] **Step 1: Write the failing test**

Create `test/unit/digest-subject.test.js`:

```javascript
import { describe, it, expect } from 'vitest';
import { digestSubject } from '../../srv/lib/contributor-notifications.js';

describe('digestSubject', () => {
  it('singular for one tutorial', () => {
    expect(digestSubject({ tutorials: [{}], worstLevel: 0 }))
      .toBe('1 stale tutorial needs review');
  });

  it('plural for multiple tutorials', () => {
    expect(digestSubject({ tutorials: [{}, {}, {}], worstLevel: 1 }))
      .toBe('3 stale tutorials need review');
  });

  it('switches to "FINAL NOTICE" prose at worstLevel=3', () => {
    expect(digestSubject({ tutorials: [{}, {}], worstLevel: 3 }))
      .toBe('FINAL NOTICE: 2 stale tutorials pending retirement');
  });

  it('singular final notice', () => {
    expect(digestSubject({ tutorials: [{}], worstLevel: 3 }))
      .toBe('FINAL NOTICE: 1 stale tutorial pending retirement');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --project unit test/unit/digest-subject.test.js`
Expected: FAIL — `digestSubject` not exported.

- [ ] **Step 3: Implement**

Append to `srv/lib/contributor-notifications.js`:

```javascript
/**
 * Build the subject line for a digest email. Levels 0-2 use the
 * "need review" wording; level 3 escalates to "FINAL NOTICE: pending
 * retirement". Pluralizes noun + verb.
 */
export function digestSubject(digest) {
  const count = digest.tutorials.length;
  const noun = count === 1 ? 'tutorial' : 'tutorials';
  if (digest.worstLevel === 3) {
    return `FINAL NOTICE: ${count} stale ${noun} pending retirement`;
  }
  const verb = count === 1 ? 'needs' : 'need';
  return `${count} stale ${noun} ${verb} review`;
}
```

- [ ] **Step 4: Run tests to verify pass**

Run: `npx vitest run --project unit test/unit/digest-subject.test.js`
Expected: PASS (all 4 cases).

- [ ] **Step 5: Commit**

```bash
git add srv/lib/contributor-notifications.js test/unit/digest-subject.test.js
git commit -m "feat(#622): add digestSubject helper

Returns 'N stale tutorial(s) need review' for levels 0-2 and
'FINAL NOTICE: ...' for level 3. Pluralizes noun + verb correctly.

Refs #622"
```

---

## Task 4: Extend `TIMING_KNOBS` to support type-aware parsing (bool + 3 new keys)

**Files:**
- Modify: `srv/lib/contributor-notifications.js:7-37` (TIMING_KNOBS table + `resolveTimingKnobs`)
- Test: `test/unit/resolve-timing-knobs-bool.test.js` (new)

- [ ] **Step 1: Write the failing test**

Create `test/unit/resolve-timing-knobs-bool.test.js`:

```javascript
import { describe, it, expect, beforeEach, vi } from 'vitest';
import cds from '@sap/cds';
import { resolveTimingKnobs } from '../../srv/lib/contributor-notifications.js';

describe('resolveTimingKnobs — bool + new int knobs', () => {
  let warnSpy;
  beforeEach(async () => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await cds.deploy(`namespace com.sap.developers.ims;
      entity ImsConfig { key ID : UUID; key : String; value : String; }`)
      .to('sqlite::memory:');
  });

  async function seed(rows) {
    const { ImsConfig } = cds.entities('com.sap.developers.ims');
    await DELETE.from(ImsConfig);
    for (const r of rows) {
      await INSERT.into(ImsConfig).entries({ ID: cds.utils.uuid(), key: r.key, value: r.value });
    }
  }

  it('useDigestNotifications "true" → true', async () => {
    await seed([{ key: 'useDigestNotifications', value: 'true' }]);
    const k = await resolveTimingKnobs();
    expect(k.useDigest).toBe(true);
  });

  it('useDigestNotifications "false" → false', async () => {
    await seed([{ key: 'useDigestNotifications', value: 'false' }]);
    const k = await resolveTimingKnobs();
    expect(k.useDigest).toBe(false);
  });

  it('useDigestNotifications "TRUE" / "False" (case-insensitive)', async () => {
    await seed([{ key: 'useDigestNotifications', value: 'TRUE' }]);
    let k = await resolveTimingKnobs();
    expect(k.useDigest).toBe(true);
    await seed([{ key: 'useDigestNotifications', value: 'False' }]);
    k = await resolveTimingKnobs();
    expect(k.useDigest).toBe(false);
  });

  it('useDigestNotifications "yes" → default true + WARN', async () => {
    await seed([{ key: 'useDigestNotifications', value: 'yes' }]);
    const k = await resolveTimingKnobs();
    expect(k.useDigest).toBe(true); // default
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('useDigestNotifications'));
  });

  it('missing row → default true + NO warn', async () => {
    await seed([]);
    const k = await resolveTimingKnobs();
    expect(k.useDigest).toBe(true);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('lastChanceMinLevel + lastChanceDormancyDays default to 3 / 60', async () => {
    await seed([]);
    const k = await resolveTimingKnobs();
    expect(k.lastChanceMinLevel).toBe(3);
    expect(k.lastChanceDormancyDays).toBe(60);
  });

  it('lastChanceDormancyDays negative → WARN + default 60', async () => {
    await seed([{ key: 'lastChanceDormancyDays', value: '-10' }]);
    const k = await resolveTimingKnobs();
    expect(k.lastChanceDormancyDays).toBe(60);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('lastChanceDormancyDays'));
  });

  it('existing knobs still work', async () => {
    await seed([{ key: 'staleDaysThreshold', value: '45' }]);
    const k = await resolveTimingKnobs();
    expect(k.staleDays).toBe(45);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --project unit test/unit/resolve-timing-knobs-bool.test.js`
Expected: FAIL — `k.useDigest` is `undefined`.

- [ ] **Step 3: Implement type-aware parser**

In `srv/lib/contributor-notifications.js`, replace lines 1-37 with:

```javascript
import cds from '@sap/cds';

const STALE_DAYS_DEFAULT = 90;
const RESEND_INTERVAL_DAYS = 30;
const MAX_NOTIFICATION_LEVEL = 3;
const USE_DIGEST_DEFAULT = true;
const LAST_CHANCE_MIN_LEVEL_DEFAULT = 3;
const LAST_CHANCE_DORMANCY_DAYS_DEFAULT = 60;

const TIMING_KNOBS = [
  { key: 'staleDaysThreshold',     field: 'staleDays',              type: 'int',  defaultValue: STALE_DAYS_DEFAULT },
  { key: 'resendIntervalDays',     field: 'resendIntervalDays',     type: 'int',  defaultValue: RESEND_INTERVAL_DAYS },
  { key: 'maxNotificationLevel',   field: 'maxLevel',               type: 'int',  defaultValue: MAX_NOTIFICATION_LEVEL },
  { key: 'useDigestNotifications', field: 'useDigest',              type: 'bool', defaultValue: USE_DIGEST_DEFAULT },
  { key: 'lastChanceMinLevel',     field: 'lastChanceMinLevel',     type: 'int',  defaultValue: LAST_CHANCE_MIN_LEVEL_DEFAULT },
  { key: 'lastChanceDormancyDays', field: 'lastChanceDormancyDays', type: 'int',  defaultValue: LAST_CHANCE_DORMANCY_DAYS_DEFAULT },
];

/**
 * Resolve timing knobs from ImsConfig. Type-aware: int knobs require a
 * positive integer; bool knobs accept only "true"/"false" (case-insensitive).
 * Invalid non-empty values WARN + fall back to default; missing rows fall
 * back silently.
 */
export async function resolveTimingKnobs() {
  const { ImsConfig } = cds.entities('com.sap.developers.ims');
  const out = {};
  for (const { key, field, type, defaultValue } of TIMING_KNOBS) {
    const row = await SELECT.one.from(ImsConfig).where({ key });
    const raw = row?.value;
    out[field] = parseKnob(key, raw, type, defaultValue);
  }
  return out;
}

function parseKnob(key, raw, type, defaultValue) {
  if (raw == null || raw === '') return defaultValue;
  if (type === 'bool') {
    const lc = String(raw).toLowerCase();
    if (lc === 'true') return true;
    if (lc === 'false') return false;
    console.warn(`[contributor-notifications] ImsConfig.${key}="${raw}" is not "true"/"false"; using default ${defaultValue}`);
    return defaultValue;
  }
  const parsed = parseInt(raw, 10);
  if (Number.isFinite(parsed) && parsed > 0) return parsed;
  console.warn(`[contributor-notifications] ImsConfig.${key}="${raw}" is not a positive integer; using default ${defaultValue}`);
  return defaultValue;
}
```

- [ ] **Step 4: Run tests to verify pass + no regression**

Run: `npx vitest run --project unit test/unit/resolve-timing-knobs-bool.test.js`
Expected: PASS (all 8 cases).

Sanity-check: `npx vitest run --project unit`
Expected: All previously-passing tests still pass.

- [ ] **Step 5: Commit**

```bash
git add srv/lib/contributor-notifications.js test/unit/resolve-timing-knobs-bool.test.js
git commit -m "feat(#622): type-aware TIMING_KNOBS parser + 3 new knobs

Adds bool support to resolveTimingKnobs() and 3 new keys:
useDigestNotifications (bool, default true), lastChanceMinLevel
(int, default 3), lastChanceDormancyDays (int, default 60).

Bool knobs accept only true/false (case-insensitive); anything
else WARNs and falls back to default. Missing rows fall back silently.

Refs #622"
```

---

## Task 5: Seed 3 new `ImsConfig` rows for default knob values

**Files:**
- Modify: `db/data/com.sap.developers.ims-ImsConfig.csv`

- [ ] **Step 1: Append 3 new rows**

Edit `db/data/com.sap.developers.ims-ImsConfig.csv` so the file becomes:

```
ID;legacyId;key;value
aaaaaaaa-aaaa-4aaa-8aaa-000000000001;;staleDaysThreshold;90
aaaaaaaa-aaaa-4aaa-8aaa-000000000002;;resendIntervalDays;30
aaaaaaaa-aaaa-4aaa-8aaa-000000000003;;maxNotificationLevel;3
aaaaaaaa-aaaa-4aaa-8aaa-000000000004;;useDigestNotifications;true
aaaaaaaa-aaaa-4aaa-8aaa-000000000005;;lastChanceMinLevel;3
aaaaaaaa-aaaa-4aaa-8aaa-000000000006;;lastChanceDormancyDays;60
```

- [ ] **Step 2: Commit**

```bash
git add db/data/com.sap.developers.ims-ImsConfig.csv
git commit -m "feat(#622): seed default values for 3 new ImsConfig knobs

useDigestNotifications=true, lastChanceMinLevel=3,
lastChanceDormancyDays=60. Matches hardcoded defaults in
TIMING_KNOBS so HDI redeploy that wipes the rows reverts to
identical behavior (no outage).

Refs #622"
```

---

## Task 6: Widen `computeStaleNotifications()` SELECT for author FK fields

**Files:**
- Modify: `srv/lib/contributor-notifications.js` (inside the `for (const meta of staleMeta)` loop)

- [ ] **Step 1: Locate the SELECT to widen**

In `srv/lib/contributor-notifications.js`, find `const repoOwnerRow = await SELECT.one.from(TutorialMeta)`. This is the second SELECT inside the `for (const meta of staleMeta)` loop.

- [ ] **Step 2: Widen the SELECT and the pushed record**

Replace the `repoOwnerRow` SELECT and its consumer `notifications.push({...})` block with:

```javascript
// Pull repo owner + author FK fields in a single SELECT. The Association
// chains compile to LEFT JOINs on HANA. NULL-safe — if any link is missing,
// the corresponding field is null.
const fkRow = await SELECT.one.from(TutorialMeta)
  .columns(
    'repository.repositoryOwner.email as repoOwnerEmail',
    'tutorial.author.email as authorUserEmail',
    'tutorial.author.displayName as authorUserName'
  )
  .where({ tutorial_ID: tutorial.ID });

notifications.push({
  tutorialId: tutorial.ID,
  slug: tutorial.slug,
  title: tutorial.title,
  reviewedDate: meta.reviewedDate,
  notificationLevel: meta.notificationNumber || 0,
  lastNotificationDate: meta.lastNotificationDate ?? null,
  contributors: contributors.map(c => ({ name: c.name, email: c.email, role: c.role })),
  repoOwner: fkRow?.repoOwnerEmail ?? null,
  authorUserEmail: fkRow?.authorUserEmail ?? null,
  authorUserName: fkRow?.authorUserName ?? null,
});
```

`lastNotificationDate` is added because the bulk-sweep dormancy filter in Task 10 needs it.

- [ ] **Step 3: Run all unit tests for regressions**

Run: `npx vitest run --project unit`
Expected: All tests pass. If any existing test asserted on the exact shape of `notifications`, update it to use `expect.objectContaining(...)`.

- [ ] **Step 4: Commit**

```bash
git add srv/lib/contributor-notifications.js
git commit -m "feat(#622): widen computeStaleNotifications SELECT for author FK

Per-tutorial notification records now include authorUserEmail,
authorUserName (via tutorial.author.* path) and lastNotificationDate.
Single SELECT — compiles to LEFT JOINs on HANA, NULL-safe.

Enables groupNotificationsByAuthor and bulk-sweep dormancy filter.

Refs #622"
```

---

## Task 7: Implement `groupNotificationsByAuthor`

**Files:**
- Modify: `srv/lib/contributor-notifications.js`
- Test: `test/unit/group-notifications-by-author.test.js` (new)

- [ ] **Step 1: Write the failing test**

Create `test/unit/group-notifications-by-author.test.js`:

```javascript
import { describe, it, expect } from 'vitest';
import { groupNotificationsByAuthor } from '../../srv/lib/contributor-notifications.js';

function n({ tutorialId, slug, title = 'T', level = 0,
             reviewedDate = '2025-01-01T00:00:00.000Z',
             lastNotificationDate = null, contributors = [], repoOwner = null,
             authorUserEmail = null, authorUserName = null }) {
  return {
    tutorialId, slug, title,
    reviewedDate,
    notificationLevel: level,
    lastNotificationDate,
    contributors, repoOwner, authorUserEmail, authorUserName
  };
}

describe('groupNotificationsByAuthor', () => {
  it('groups 5 tutorials across 3 authors + 1 unresolvable', () => {
    const input = [
      n({ tutorialId: 1, slug: 't1', authorUserEmail: 'alice@sap.com', authorUserName: 'Alice', level: 1 }),
      n({ tutorialId: 2, slug: 't2', authorUserEmail: 'alice@sap.com', authorUserName: 'Alice', level: 2,
          reviewedDate: '2024-09-01T00:00:00.000Z' }),
      n({ tutorialId: 3, slug: 't3', contributors: [{ name: 'Bob', email: 'bob@sap.com', role: 'OWNER' }], level: 0 }),
      n({ tutorialId: 4, slug: 't4', contributors: [{ name: 'Carol', email: 'carol@sap.com', role: 'AUTHOR' }], level: 3 }),
      n({ tutorialId: 5, slug: 't5' }), // no FK, no contributors → unresolvable
    ];
    const digests = groupNotificationsByAuthor(input);
    expect(digests).toHaveLength(4);

    const alice = digests.find(d => d.authorEmail === 'alice@sap.com');
    expect(alice.authorSource).toBe('Tutorials.author');
    expect(alice.authorName).toBe('Alice');
    expect(alice.tutorials).toHaveLength(2);
    expect(alice.worstLevel).toBe(2);
    expect(alice.worstReviewedDate).toBe('2024-09-01T00:00:00.000Z');

    const bob = digests.find(d => d.authorEmail === 'bob@sap.com');
    expect(bob.authorSource).toBe('TutorialContributors');

    const orphan = digests.find(d => d.authorEmail === null);
    expect(orphan.authorSource).toBe('none');
    expect(orphan.tutorials).toHaveLength(1);
  });

  it('case-insensitive grouping — FK and contributor email differing only in case converge', () => {
    const input = [
      n({ tutorialId: 1, slug: 't1', authorUserEmail: 'Alice@Sap.com', authorUserName: 'Alice' }),
      n({ tutorialId: 2, slug: 't2', contributors: [{ name: 'Alice', email: 'alice@sap.com', role: 'OWNER' }] }),
    ];
    const digests = groupNotificationsByAuthor(input);
    expect(digests).toHaveLength(1);
    expect(digests[0].authorEmail).toBe('alice@sap.com');
    expect(digests[0].tutorials).toHaveLength(2);
  });

  it('FK with null/empty email falls through to contributors', () => {
    const input = [
      n({ tutorialId: 1, slug: 't1', authorUserEmail: '', authorUserName: 'Alice',
          contributors: [{ name: 'Bob', email: 'bob@sap.com', role: 'OWNER' }] }),
      n({ tutorialId: 2, slug: 't2', authorUserEmail: null,
          contributors: [{ name: 'Bob', email: 'bob@sap.com', role: 'OWNER' }] }),
    ];
    const digests = groupNotificationsByAuthor(input);
    expect(digests).toHaveLength(1);
    expect(digests[0].authorEmail).toBe('bob@sap.com');
    expect(digests[0].authorSource).toBe('TutorialContributors');
  });

  it('contributors OWNER role wins over AUTHOR', () => {
    const input = [n({ tutorialId: 1, slug: 't1', contributors: [
      { name: 'A', email: 'author@sap.com', role: 'AUTHOR' },
      { name: 'O', email: 'owner@sap.com', role: 'OWNER' },
    ] })];
    expect(groupNotificationsByAuthor(input)[0].authorEmail).toBe('owner@sap.com');
  });

  it('falls back to AUTHOR when no OWNER present', () => {
    const input = [n({ tutorialId: 1, slug: 't1', contributors: [
      { name: 'A', email: 'author@sap.com', role: 'AUTHOR' },
      { name: 'C', email: 'contrib@sap.com', role: 'CONTRIBUTOR' },
    ] })];
    expect(groupNotificationsByAuthor(input)[0].authorEmail).toBe('author@sap.com');
  });

  it('worstLevel = max across tutorials', () => {
    const input = [
      n({ tutorialId: 1, slug: 't1', authorUserEmail: 'a@sap.com', level: 0 }),
      n({ tutorialId: 2, slug: 't2', authorUserEmail: 'a@sap.com', level: 3 }),
      n({ tutorialId: 3, slug: 't3', authorUserEmail: 'a@sap.com', level: 1 }),
    ];
    expect(groupNotificationsByAuthor(input)[0].worstLevel).toBe(3);
  });

  it('worstReviewedDate = min (oldest) across tutorials', () => {
    const input = [
      n({ tutorialId: 1, slug: 't1', authorUserEmail: 'a@sap.com', reviewedDate: '2025-03-01T00:00:00.000Z' }),
      n({ tutorialId: 2, slug: 't2', authorUserEmail: 'a@sap.com', reviewedDate: '2024-12-15T00:00:00.000Z' }),
    ];
    expect(groupNotificationsByAuthor(input)[0].worstReviewedDate).toBe('2024-12-15T00:00:00.000Z');
  });

  it('empty input → empty array', () => {
    expect(groupNotificationsByAuthor([])).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --project unit test/unit/group-notifications-by-author.test.js`
Expected: FAIL.

- [ ] **Step 3: Implement**

Append to `srv/lib/contributor-notifications.js`:

```javascript
/**
 * Per-tutorial author resolution.
 * 1. Tutorials.author FK with non-empty Users.email → FK path
 * 2. Else: contributors OWNER → AUTHOR priority → contributor path
 * 3. Else: { authorEmail: null, authorSource: 'none' }
 */
function resolveAuthor(n) {
  if (n.authorUserEmail && String(n.authorUserEmail).trim() !== '') {
    return {
      authorEmail: String(n.authorUserEmail).toLowerCase(),
      authorSource: 'Tutorials.author',
      authorName: n.authorUserName ?? null,
    };
  }
  const owner = n.contributors?.find(c => c.role === 'OWNER')
    ?? n.contributors?.find(c => c.role === 'AUTHOR');
  if (owner?.email) {
    return {
      authorEmail: String(owner.email).toLowerCase(),
      authorSource: 'TutorialContributors',
      authorName: owner.name ?? null,
    };
  }
  return { authorEmail: null, authorSource: 'none', authorName: null };
}

/**
 * Group per-tutorial notification records by author email (case-insensitive).
 * Tutorials with no resolvable author land in a single { authorEmail: null }
 * bucket. Pure function — no DB calls.
 */
export function groupNotificationsByAuthor(notifications) {
  const map = new Map();
  for (const n of notifications) {
    const { authorEmail, authorSource, authorName } = resolveAuthor(n);
    const key = authorEmail ?? '__null__';
    let d = map.get(key);
    if (!d) {
      d = { authorEmail, authorSource, authorName, tutorials: [], worstLevel: 0, worstReviewedDate: null };
      map.set(key, d);
    }
    d.tutorials.push(n);
    if (n.notificationLevel > d.worstLevel) d.worstLevel = n.notificationLevel;
    if (n.reviewedDate && (!d.worstReviewedDate || n.reviewedDate < d.worstReviewedDate)) {
      d.worstReviewedDate = n.reviewedDate;
    }
  }
  return Array.from(map.values());
}
```

- [ ] **Step 4: Run tests to verify pass**

Run: `npx vitest run --project unit test/unit/group-notifications-by-author.test.js`
Expected: PASS (all 8 cases).

- [ ] **Step 5: Commit**

```bash
git add srv/lib/contributor-notifications.js test/unit/group-notifications-by-author.test.js
git commit -m "feat(#622): groupNotificationsByAuthor helper

Pure function — array of per-tutorial notifications in, array of
AuthorDigest out. Resolves via Tutorials.author FK first, falls back
to contributors OWNER → AUTHOR priority. Group key is case-folded.
Orphan tutorials bucket under authorEmail=null.

Refs #622"
```

---

## Task 8: Implement `determineRecipientsForDigest`

**Files:**
- Modify: `srv/lib/contributor-notifications.js`
- Test: `test/unit/determine-recipients-for-digest.test.js` (new)

- [ ] **Step 1: Write the failing test**

Create `test/unit/determine-recipients-for-digest.test.js`:

```javascript
import { describe, it, expect } from 'vitest';
import { determineRecipientsForDigest } from '../../srv/lib/contributor-notifications.js';

const baseDigest = (tutorials, worstLevel, authorEmail = 'alice@sap.com') => ({
  authorEmail, authorSource: 'Tutorials.author', authorName: 'Alice',
  tutorials, worstLevel, worstReviewedDate: '2024-01-01',
});

describe('determineRecipientsForDigest', () => {
  it('level 0 → to=author, cc=[]', () => {
    const d = baseDigest([{ tutorialId: 1, repoOwner: 'repo@sap.com' }], 0);
    const { to, cc } = determineRecipientsForDigest(d, ['admin@sap.com']);
    expect(to).toEqual(['alice@sap.com']);
    expect(cc).toEqual([]);
  });

  it('level 1 → to=author, cc=[repoOwner]', () => {
    const d = baseDigest([{ tutorialId: 1, repoOwner: 'repo@sap.com' }], 1);
    const { to, cc } = determineRecipientsForDigest(d, ['admin@sap.com']);
    expect(to).toEqual(['alice@sap.com']);
    expect(cc).toEqual(['repo@sap.com']);
  });

  it('level 2 → to=author, cc=[repoOwner, ...admins], deduped', () => {
    const d = baseDigest([{ tutorialId: 1, repoOwner: 'repo@sap.com' }], 2);
    const { to, cc } = determineRecipientsForDigest(d, ['admin1@sap.com', 'admin2@sap.com']);
    expect(to).toEqual(['alice@sap.com']);
    expect(cc).toEqual(['repo@sap.com', 'admin1@sap.com', 'admin2@sap.com']);
  });

  it('level 3 → to=admins, cc=[]', () => {
    const d = baseDigest([{ tutorialId: 1, repoOwner: 'repo@sap.com' }], 3);
    const { to, cc } = determineRecipientsForDigest(d, ['admin@sap.com']);
    expect(to).toEqual(['admin@sap.com']);
    expect(cc).toEqual([]);
  });

  it('dedupes repo owner across multiple tutorials', () => {
    const d = baseDigest([
      { tutorialId: 1, repoOwner: 'repo@sap.com' },
      { tutorialId: 2, repoOwner: 'repo@sap.com' },
      { tutorialId: 3, repoOwner: 'other-repo@sap.com' },
    ], 1);
    const { cc } = determineRecipientsForDigest(d, []);
    expect(cc).toEqual(['repo@sap.com', 'other-repo@sap.com']);
  });

  it('drops cc entry that duplicates to (author also in admin list)', () => {
    const d = baseDigest([{ tutorialId: 1, repoOwner: 'repo@sap.com' }], 2, 'alice@sap.com');
    const { to, cc } = determineRecipientsForDigest(d, ['alice@sap.com', 'admin@sap.com']);
    expect(to).toEqual(['alice@sap.com']);
    expect(cc).not.toContain('alice@sap.com');
    expect(cc).toContain('admin@sap.com');
  });

  it('case-insensitive cc dedupe vs to', () => {
    const d = baseDigest([{ tutorialId: 1, repoOwner: 'REPO@sap.com' }], 1, 'alice@sap.com');
    const { cc } = determineRecipientsForDigest(d, ['Repo@SAP.com']);
    expect(cc).toHaveLength(1);
  });

  it('null repoOwner is skipped', () => {
    const d = baseDigest([
      { tutorialId: 1, repoOwner: null },
      { tutorialId: 2, repoOwner: 'repo@sap.com' },
    ], 1);
    const { cc } = determineRecipientsForDigest(d, []);
    expect(cc).toEqual(['repo@sap.com']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --project unit test/unit/determine-recipients-for-digest.test.js`
Expected: FAIL.

- [ ] **Step 3: Implement**

Append to `srv/lib/contributor-notifications.js`:

```javascript
/**
 * Build to/cc recipient lists for a digest email.
 * Synthesizes a notification-shaped record and delegates to determineRecipients
 * so the level→audience mapping stays single-sourced. Unions repoOwner emails
 * across all tutorials in the digest, dedupes CC, drops CC entries that
 * duplicate the to list (case-insensitive).
 */
export function determineRecipientsForDigest(digest, adminEmails = []) {
  const synthetic = {
    notificationLevel: digest.worstLevel,
    contributors: [{ email: digest.authorEmail, role: 'OWNER' }],
    repoOwner: digest.tutorials.find(t => t.repoOwner)?.repoOwner ?? null,
  };
  const { to, cc } = determineRecipients(synthetic, adminEmails);

  // Union additional repo owners (multi-tutorial digests may span repos).
  const extraRepoOwners = [
    ...new Set(digest.tutorials.map(t => t.repoOwner).filter(Boolean))
  ];
  const ccCaseFolded = new Set(cc.map(e => e.toLowerCase()));
  for (const owner of extraRepoOwners) {
    if (!ccCaseFolded.has(owner.toLowerCase())) {
      cc.push(owner);
      ccCaseFolded.add(owner.toLowerCase());
    }
  }

  // Drop CC entries duplicating to (case-insensitive).
  const toCaseFolded = new Set(to.map(e => e.toLowerCase()));
  const dedupedCc = cc.filter(e => !toCaseFolded.has(e.toLowerCase()));
  return { to, cc: dedupedCc };
}
```

- [ ] **Step 4: Run tests to verify pass**

Run: `npx vitest run --project unit test/unit/determine-recipients-for-digest.test.js`
Expected: PASS (all 8 cases).

- [ ] **Step 5: Commit**

```bash
git add srv/lib/contributor-notifications.js test/unit/determine-recipients-for-digest.test.js
git commit -m "feat(#622): determineRecipientsForDigest wrapper

Delegates to existing determineRecipients() with a synthetic record
(level=worstLevel, contributors=[{author OWNER}]) so the level→audience
mapping stays single-sourced. Unions repo owners across all tutorials,
dedupes CC, drops CC entries duplicating TO (case-insensitive).

Refs #622"
```

---

## Task 9: Create 5 new templates (digest-level-0..3 + last-chance) and extend template-rot tests

**Files:**
- Create: `srv/templates/notification/digest-level-0.html`
- Create: `srv/templates/notification/digest-level-1.html`
- Create: `srv/templates/notification/digest-level-2.html`
- Create: `srv/templates/notification/digest-level-3.html`
- Create: `srv/templates/notification/last-chance.html`
- Modify: `test/unit/templates-notification.test.js`

- [ ] **Step 1: Extend the existing template-rot test FIRST**

Edit `test/unit/templates-notification.test.js`. Change the `FILES` constant and `REQUIRED_PLACEHOLDERS_PER_FILE` to include the new templates:

```javascript
const FILES = [
  'first.html', 'second.html', 'third.html', 'final.html',
  'digest-level-0.html', 'digest-level-1.html', 'digest-level-2.html', 'digest-level-3.html',
  'last-chance.html',
];

const REQUIRED_PLACEHOLDERS_PER_FILE = {
  'first.html':  ['${dashboardUrl}', '${tutorialTitle}', '${staleDaysThreshold}', '${lastReviewedDate}'],
  'second.html': ['${dashboardUrl}', '${tutorialTitle}', '${staleDaysThreshold}', '${lastReviewedDate}'],
  'third.html':  ['${dashboardUrl}', '${tutorialTitle}', '${staleDaysThreshold}', '${lastReviewedDate}'],
  'final.html':  ['${tutorialTitle}'],
  // Digest templates take a pre-rendered <ul> instead of per-tutorial title/date.
  'digest-level-0.html': ['${authorName}', '${tutorialCount}', '${tutorialListHtml}', '${dashboardUrl}', '${staleDaysThreshold}'],
  'digest-level-1.html': ['${authorName}', '${tutorialCount}', '${tutorialListHtml}', '${dashboardUrl}', '${staleDaysThreshold}'],
  'digest-level-2.html': ['${authorName}', '${tutorialCount}', '${tutorialListHtml}', '${dashboardUrl}', '${staleDaysThreshold}'],
  'digest-level-3.html': ['${authorName}', '${tutorialCount}', '${tutorialListHtml}'],
  'last-chance.html':    ['${authorName}', '${tutorialCount}', '${tutorialListHtml}', '${dashboardUrl}', '${staleDaysThreshold}'],
};
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run --project unit test/unit/templates-notification.test.js`
Expected: FAIL with ENOENT on the 5 missing template files.

- [ ] **Step 3: Create `digest-level-0.html`** (friendly first reminder)

```html
<html>
<head><meta http-equiv="content-type" content="text/html; charset=UTF-8"></head>
<body>
<p>Dear ${authorName},</p>
<p>This is a reminder that the following ${tutorialCount} tutorial(s) you author
   have not been reviewed in over ${staleDaysThreshold} days.
   If no action is taken, they will be retired from production.</p>

${tutorialListHtml}

<p><strong>What action do you need to take?</strong></p>
<ol>
    <li><strong>Review each tutorial.</strong> If changes are needed, update the
        tutorial in its source GitHub repository. If no changes are needed,
        mark it as Reviewed in the <a href="${dashboardUrl}">Tutorial Dashboard</a>.</li>
    <li><strong>Mark tutorials as needing changes.</strong> If you know a tutorial is
        out of date but can't fix it now, flag it in the Tutorial Dashboard.</li>
    <li><strong>Defer the review.</strong> If you need more time, mark a tutorial as
        deferred. You won't be reminded again for 30 days.</li>
</ol>
<p>If you perform a review every 3-4 months you won't receive these reminders.</p>

<p>Thanks for your support,<br/>
SAP Developers Tutorials Team</p>
</body>
</html>
```

- [ ] **Step 4: Create `digest-level-1.html`** (second reminder, repo owner CC'd)

```html
<html>
<head><meta http-equiv="content-type" content="text/html; charset=UTF-8"></head>
<body>
<p>Dear ${authorName},</p>
<p>This is the <strong>second reminder</strong> that the following ${tutorialCount} tutorial(s)
   you author have not been reviewed in over ${staleDaysThreshold} days.
   If no action is taken, they will be retired from production.</p>

${tutorialListHtml}

<p>The repository owner has been copied on this message so they can help coordinate the review.</p>

<p><strong>Action options:</strong></p>
<ol>
    <li>Review and update each tutorial in its source GitHub repository.</li>
    <li>Mark each tutorial as Reviewed in the <a href="${dashboardUrl}">Tutorial Dashboard</a>.</li>
    <li>Mark tutorials as needing changes if you can't update them now.</li>
    <li>Defer the review for 30 days via the Tutorial Dashboard.</li>
</ol>

<p>Thanks for your support,<br/>
SAP Developers Tutorials Team</p>
</body>
</html>
```

- [ ] **Step 5: Create `digest-level-2.html`** (third reminder, admins CC'd)

```html
<html>
<head><meta http-equiv="content-type" content="text/html; charset=UTF-8"></head>
<body>
<p>Dear ${authorName},</p>
<p>This is the <strong>third and final reminder</strong> before retirement. The
   following ${tutorialCount} tutorial(s) you author have not been reviewed in over
   ${staleDaysThreshold} days:</p>

${tutorialListHtml}

<p>The repository owner and the Tutorials Curation team have been copied on this
   message. We are escalating because the previous two reminders went unanswered.</p>

<p><strong>Please take action now via the <a href="${dashboardUrl}">Tutorial Dashboard</a>:</strong></p>
<ol>
    <li>Review and update each tutorial in its source GitHub repository.</li>
    <li>Mark each tutorial as Reviewed.</li>
    <li>Mark tutorials as needing changes if you can't update them now.</li>
</ol>

<p>If we don't hear from you, the next message about these tutorials will go to the
   Tutorials Curation team for retirement processing.</p>

<p>Thanks for your support,<br/>
SAP Developers Tutorials Team</p>
</body>
</html>
```

- [ ] **Step 6: Create `digest-level-3.html`** (admins-only)

```html
<html>
<head><meta http-equiv="content-type" content="text/html; charset=UTF-8"></head>
<body>
<p>Dear Team,</p>
<p>The deadline for reviewing the following ${tutorialCount} tutorial(s) by
   ${authorName} has passed. The author did not respond to the three escalating
   reminders. Please make arrangements to have these removed from the productive
   system:</p>

${tutorialListHtml}

<p>If you received this message by mistake, please let us know by replying to this email.</p>

<p>Thanks for your support,<br/>
SAP Developers Tutorials Team</p>
</body>
</html>
```

- [ ] **Step 7: Create `last-chance.html`** (admin-triggered final notice)

```html
<html>
<head><meta http-equiv="content-type" content="text/html; charset=UTF-8"></head>
<body>
<p>Dear ${authorName},</p>
<p>This is a <strong>final notice</strong> from the SAP Developers Tutorials Team.
   The following ${tutorialCount} tutorial(s) you author have been flagged for retirement
   because they have been stale for more than ${staleDaysThreshold} days and have not
   responded to multiple reminders:</p>

${tutorialListHtml}

<p>We would prefer not to retire these tutorials — they have value to our developer
   community. If you intend to keep authoring them, please take action within the next
   2 weeks via the <a href="${dashboardUrl}">Tutorial Dashboard</a>:</p>

<ol>
    <li><strong>Review and update</strong> each tutorial in its source GitHub repository,
        then mark it as Reviewed.</li>
    <li><strong>Hand off authorship</strong> to a colleague by updating the
        <code>author</code> in the tutorial's frontmatter.</li>
    <li><strong>Reply to this email</strong> if you need more time or want to discuss.</li>
</ol>

<p>If we don't hear from you, these tutorials will be retired.</p>

<p>Thanks for your support,<br/>
SAP Developers Tutorials Team</p>
</body>
</html>
```

- [ ] **Step 8: Run the templates test to verify pass**

Run: `npx vitest run --project unit test/unit/templates-notification.test.js`
Expected: PASS — 9 files × 3 describe-blocks = 27 cases (rot, placeholders, signature).

- [ ] **Step 9: Commit**

```bash
git add srv/templates/notification/ test/unit/templates-notification.test.js
git commit -m "feat(#622): add 4 digest templates + last-chance template

digest-level-{0,1,2,3}.html mirror the existing per-tutorial templates'
tone but consume a pre-rendered \${tutorialListHtml} <ul>. Level 3
addresses admins (no \${dashboardUrl} or \${staleDaysThreshold}).

last-chance.html is a human-tone final notice used by the admin
sendLastChanceEmail action. Distinct from the cron's automated L3 so
Riley/Tom can edit copy without disturbing automation.

Extends template-rot test to cover the 5 new files.

Refs #622"
```

---

## Task 10: Refactor weekly cron to branch on `useDigest`

**Files:**
- Modify: `srv/jobs/scheduler.js:142-199` (cron body)
- Test: `test/unit/cron-digest-mode.test.js` (new)

This is the cron's behavioral change. Branch on `knobs.useDigest`; digest path uses the new helpers; legacy path is preserved verbatim.

- [ ] **Step 1: Write the failing test**

Create `test/unit/cron-digest-mode.test.js`. This test stubs out `sendNotificationEmail`, `markNotificationSent`, `computeStaleNotifications`, `resolveTimingKnobs`, `getAdminEmailList`, `isNotificationsEnabled`, and `resolveDisplaySettings`, then exercises the **extracted cron body**. The actual cron body must be extracted to a named exported function `runContributorNotificationsCycle(logId)` so it's testable; that's part of Step 3.

```javascript
import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock the modules used by the cron body. Test exercises the extracted body.
vi.mock('../../srv/lib/contributor-notifications.js', async (orig) => {
  const actual = await orig();
  return {
    ...actual,
    resolveTimingKnobs: vi.fn(),
    computeStaleNotifications: vi.fn(),
    getAdminEmailList: vi.fn(),
    isNotificationsEnabled: vi.fn(),
    markNotificationSent: vi.fn().mockResolvedValue(undefined),
  };
});

vi.mock('../../srv/lib/mail-client.js', () => ({
  sendNotificationEmail: vi.fn(),
}));

vi.mock('../../srv/lib/display-settings.js', () => ({
  resolveDisplaySettings: vi.fn().mockResolvedValue({ dashboardUrl: 'https://dash' }),
}));

vi.mock('../../srv/jobs/job-log.js', () => ({
  logJobItem: vi.fn().mockResolvedValue(undefined),
}));

const {
  resolveTimingKnobs, computeStaleNotifications, getAdminEmailList,
  isNotificationsEnabled, markNotificationSent
} = await import('../../srv/lib/contributor-notifications.js');
const { sendNotificationEmail } = await import('../../srv/lib/mail-client.js');
const { runContributorNotificationsCycle } = await import('../../srv/jobs/scheduler.js');

const stubKnobs = (extra = {}) => ({
  staleDays: 90, resendIntervalDays: 30, maxLevel: 3,
  useDigest: true, lastChanceMinLevel: 3, lastChanceDormancyDays: 60,
  ...extra,
});

const stubNotifications = () => [
  { tutorialId: 't1', slug: 't1', title: 'T1', reviewedDate: '2025-01-01T00:00:00.000Z',
    notificationLevel: 0, lastNotificationDate: null,
    contributors: [], repoOwner: null,
    authorUserEmail: 'alice@sap.com', authorUserName: 'Alice' },
  { tutorialId: 't2', slug: 't2', title: 'T2', reviewedDate: '2025-01-01T00:00:00.000Z',
    notificationLevel: 1, lastNotificationDate: null,
    contributors: [], repoOwner: null,
    authorUserEmail: 'alice@sap.com', authorUserName: 'Alice' },
  { tutorialId: 't3', slug: 't3', title: 'T3', reviewedDate: '2025-01-01T00:00:00.000Z',
    notificationLevel: 0, lastNotificationDate: null,
    contributors: [], repoOwner: null,
    authorUserEmail: 'bob@sap.com', authorUserName: 'Bob' },
];

describe('runContributorNotificationsCycle — digest mode', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    isNotificationsEnabled.mockResolvedValue(true);
    getAdminEmailList.mockResolvedValue(['admin@sap.com']);
    sendNotificationEmail.mockResolvedValue({ success: true });
  });

  it('useDigest=true: 3 tutorials/2 authors → 2 sends, 3 markNotificationSent', async () => {
    resolveTimingKnobs.mockResolvedValue(stubKnobs());
    computeStaleNotifications.mockResolvedValue(stubNotifications());

    await runContributorNotificationsCycle('test-log-id');

    expect(sendNotificationEmail).toHaveBeenCalledTimes(2);
    expect(markNotificationSent).toHaveBeenCalledTimes(3);
    // Verify digest payload shape.
    const firstCall = sendNotificationEmail.mock.calls[0][0];
    expect(firstCall).toHaveProperty('template');
    expect(firstCall.template).toMatch(/^digest-level-/);
    expect(firstCall.variables).toHaveProperty('tutorialListHtml');
  });

  it('useDigest=false: 3 tutorials → 3 sends with level (no template), 3 markNotificationSent', async () => {
    resolveTimingKnobs.mockResolvedValue(stubKnobs({ useDigest: false }));
    computeStaleNotifications.mockResolvedValue(stubNotifications().map(n => ({
      ...n, contributors: [{ name: 'X', email: n.authorUserEmail, role: 'OWNER' }],
    })));

    await runContributorNotificationsCycle('test-log-id');

    expect(sendNotificationEmail).toHaveBeenCalledTimes(3);
    expect(markNotificationSent).toHaveBeenCalledTimes(3);
    const firstCall = sendNotificationEmail.mock.calls[0][0];
    expect(firstCall).toHaveProperty('level');
    expect(firstCall).not.toHaveProperty('template');
  });

  it('digest send failure → zero markNotificationSent for THAT digest, others process normally', async () => {
    resolveTimingKnobs.mockResolvedValue(stubKnobs());
    computeStaleNotifications.mockResolvedValue(stubNotifications());
    // First send (alice) fails; second (bob) succeeds.
    sendNotificationEmail
      .mockResolvedValueOnce({ success: false, error: 'smtp down' })
      .mockResolvedValueOnce({ success: true });

    await runContributorNotificationsCycle('test-log-id');

    // Only bob's single tutorial (t3) got marked. Alice's 2 (t1, t2) did NOT.
    expect(markNotificationSent).toHaveBeenCalledTimes(1);
    expect(markNotificationSent).toHaveBeenCalledWith('t3');
  });

  it('notifications disabled → returns enabled:false, no sends', async () => {
    isNotificationsEnabled.mockResolvedValue(false);
    const result = await runContributorNotificationsCycle('test-log-id');
    expect(result).toEqual({ enabled: false });
    expect(sendNotificationEmail).not.toHaveBeenCalled();
  });

  it('digest with no resolvable author → SKIPPED, no send', async () => {
    resolveTimingKnobs.mockResolvedValue(stubKnobs());
    computeStaleNotifications.mockResolvedValue([{
      tutorialId: 't1', slug: 't1', title: 'T', reviewedDate: '2025-01-01',
      notificationLevel: 0, lastNotificationDate: null,
      contributors: [], repoOwner: null,
      authorUserEmail: null, authorUserName: null,
    }]);

    await runContributorNotificationsCycle('test-log-id');

    expect(sendNotificationEmail).not.toHaveBeenCalled();
    expect(markNotificationSent).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --project unit test/unit/cron-digest-mode.test.js`
Expected: FAIL — `runContributorNotificationsCycle` is not exported.

- [ ] **Step 3: Extract + branch the cron body**

In `srv/jobs/scheduler.js`, locate `cron.schedule('0 9 * * 1', ...)`. Extract its body to a named exported function and add the digest branch.

Add imports at top (if not already present):

```javascript
import {
  computeStaleNotifications, determineRecipients, determineRecipientsForDigest,
  markNotificationSent, getAdminEmailList, isNotificationsEnabled,
  resolveTimingKnobs, groupNotificationsByAuthor, digestSubject, renderTutorialList,
} from '../lib/contributor-notifications.js';
import { sendNotificationEmail } from '../lib/mail-client.js';
import { resolveDisplaySettings } from '../lib/display-settings.js';
import { logJobItem } from './job-log.js';
```

(Adjust to match existing imports — don't duplicate; merge into the existing import lines.)

Then add the exported function above the `cron.schedule` call (or near the top of the file):

```javascript
/**
 * Cron body for weekly contributor notifications. Extracted so unit tests
 * can exercise it without booting the scheduler. Branches on
 * knobs.useDigest:
 *   - true (default): per-author digest emails (one per author per cycle)
 *   - false: legacy per-tutorial loop (one email per stale tutorial)
 */
export async function runContributorNotificationsCycle(logId) {
  const LOG = cds.log('jobs');
  if (!(await isNotificationsEnabled())) {
    LOG.info('Contributor notifications disabled via config');
    return { enabled: false };
  }
  const knobs = await resolveTimingKnobs();
  const adminEmails = await getAdminEmailList();
  const notifications = await computeStaleNotifications(knobs);
  const dashboardUrl = (await resolveDisplaySettings()).dashboardUrl;

  LOG.info(`[contributor-notifications] digest mode: ${knobs.useDigest ? 'ON' : 'OFF'}, lastChanceMinLevel=${knobs.lastChanceMinLevel}, lastChanceDormancyDays=${knobs.lastChanceDormancyDays}`);

  if (knobs.useDigest) {
    return runDigestCycle(logId, notifications, adminEmails, knobs, dashboardUrl);
  }
  return runLegacyCycle(logId, notifications, adminEmails, knobs, dashboardUrl);
}

async function runDigestCycle(logId, notifications, adminEmails, knobs, dashboardUrl) {
  const digests = groupNotificationsByAuthor(notifications);
  let sent = 0, skipped = 0, failed = 0;
  for (const d of digests) {
    if (d.authorEmail == null) {
      for (const t of d.tutorials) {
        skipped++;
        await logJobItem(logId, {
          itemKey: t.slug || t.tutorialId,
          itemKind: 'NOTIFICATION',
          status: 'SKIPPED',
          message: 'no recipient resolvable (no author FK, no OWNER/AUTHOR contributor)',
        });
      }
      continue;
    }
    const { to, cc } = determineRecipientsForDigest(d, adminEmails);
    const result = await sendNotificationEmail({
      to, cc,
      subject: digestSubject(d),
      template: `digest-level-${d.worstLevel}`,
      variables: {
        authorName: d.authorName || 'Tutorial Owner',
        tutorialCount: d.tutorials.length,
        tutorialPlural: d.tutorials.length === 1 ? 'tutorial' : 'tutorials',
        tutorialListHtml: renderTutorialList(d.tutorials, dashboardUrl),
        staleDaysThreshold: knobs.staleDays,
        dashboardUrl,
      },
    });
    if (result.success) {
      for (const t of d.tutorials) await markNotificationSent(t.tutorialId);
      sent++;
      await logJobItem(logId, {
        itemKey: d.authorEmail,
        itemKind: 'NOTIFICATION',
        status: 'SUCCESS',
        message: `Digest sent to ${to.join(', ')} (${d.tutorials.length} tutorials)`,
      });
    } else {
      failed++;
      await logJobItem(logId, {
        itemKey: d.authorEmail,
        itemKind: 'NOTIFICATION',
        status: 'ERROR',
        message: result.error || 'sendNotificationEmail returned failure',
      });
    }
  }
  return { digests: digests.length, sent, skipped, failed };
}

async function runLegacyCycle(logId, notifications, adminEmails, knobs, dashboardUrl) {
  // Verbatim from the pre-#622 cron body.
  let sent = 0, skipped = 0, failed = 0;
  for (const n of notifications) {
    const { to, cc } = determineRecipients(n, adminEmails);
    if (to.length === 0) {
      skipped++;
      await logJobItem(logId, {
        itemKey: n.tutorialSlug || n.tutorialId,
        itemKind: 'NOTIFICATION',
        status: 'SKIPPED',
        message: 'No recipients resolved',
      });
      continue;
    }
    const result = await sendNotificationEmail({
      to, cc,
      subject: n.title,
      level: n.notificationLevel,
      variables: {
        dashboardUrl,
        tutorialTitle: n.title,
        staleDaysThreshold: knobs.staleDays,
        lastReviewedDate: n.reviewedDate,
      },
    });
    if (result.success) {
      await markNotificationSent(n.tutorialId);
      sent++;
      await logJobItem(logId, {
        itemKey: n.tutorialSlug || n.tutorialId,
        itemKind: 'NOTIFICATION',
        status: 'SUCCESS',
        message: `Sent to ${to.join(', ')}`,
      });
    } else {
      failed++;
      await logJobItem(logId, {
        itemKey: n.tutorialSlug || n.tutorialId,
        itemKind: 'NOTIFICATION',
        status: 'ERROR',
        message: result.error || 'sendNotificationEmail returned failure',
      });
    }
  }
  return { stale: notifications.length, sent, skipped, failed };
}
```

Then replace the existing cron body to invoke the new function:

```javascript
cron.schedule('0 9 * * 1', () =>
  runWithLock('contributor-notifications', 1800000, (logId) => runContributorNotificationsCycle(logId))
);
```

**Implementer note — beware of `runLegacyCycle` drift:** the plan's `runLegacyCycle` reproduces today's cron body in prose, but it may have drifted by the time of implementation. **Diff against the actual `srv/jobs/scheduler.js:142-199` first** and copy that body literally — especially the `itemKey:` field name (currently `n.tutorialSlug || n.tutorialId`; confirm the actual field on the notification record).

**Implementer note — `cron.schedule` side-effect during tests:** the scheduler module currently calls `cron.schedule(...)` at top-level import, which means importing it from a test attaches a real cron handler. The hybrid test in Task 14 imports `runContributorNotificationsCycle` from this module — if you observe stray cron jobs in test runs, gate the `cron.schedule` calls with `if (!process.env.VITEST) { ... }` (or extract the cron registration to an exported `registerCrons()` function called only from the production bootstrap path). Either fix lives in Task 10; the hybrid test imports stay the same.

- [ ] **Step 4: Run unit tests for the cron**

Run: `npx vitest run --project unit test/unit/cron-digest-mode.test.js`
Expected: PASS (all 5 cases).

- [ ] **Step 5: Run all unit tests**

Run: `npx vitest run --project unit`
Expected: All tests pass — no regression in other suites.

- [ ] **Step 6: Commit**

```bash
git add srv/jobs/scheduler.js test/unit/cron-digest-mode.test.js
git commit -m "feat(#622): weekly cron branches on knobs.useDigest

Extracts the weekly contributor-notifications cron body to
runContributorNotificationsCycle() (now exported for tests) and
splits into runDigestCycle + runLegacyCycle. Digest path groups
by author, picks template by worstLevel, renders pre-built
<ul>; legacy path is verbatim from pre-#622 code.

Per-author digest: 5 tutorials for one author → 1 email + 5
markNotificationSent calls. Send failure → zero advances for
that digest; FailedEmails queue + 4-hour retry cron picks up.

Refs #622"
```

---

## Task 11: Add `sendLastChanceEmail` admin action (CDS + JS)

**Files:**
- Modify: `srv/admin-service.cds` (action declaration near existing notification actions, ~line 326)
- Modify: `srv/admin-service.js` (handler in the action-handlers block starting ~line 1069)
- Test: `test/unit/admin-last-chance-action.test.js` (new)

- [ ] **Step 1: Add CDS declaration**

In `srv/admin-service.cds`, near the existing notification actions (the block that has `sendContributorNotifications`, `toggleNotifications`, `testNotificationEmail`), add:

```cds
action sendLastChanceEmail(
  authorEmail : String,
  dryRun      : Boolean
) returns {
  success           : Boolean;
  recipientTo       : String;
  recipientCc       : array of String;
  tutorialsIncluded : Integer;
  tutorialSlugs     : array of String;
  error             : String;
};
```

- [ ] **Step 2: Write the failing test**

Create `test/unit/admin-last-chance-action.test.js`. Read an existing admin-action test in the repo first (e.g. `test/admin-crud.test.js` or `test/unit/385-pr3-authorservice.test.js`) to match the `cds.test()` pattern that already works in this codebase.

```javascript
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import cds from '@sap/cds';

const sendSpy = vi.fn();
vi.mock('../../srv/lib/mail-client.js', () => ({
  sendNotificationEmail: (opts) => sendSpy(opts),
  loadTemplate: () => '<html>${tutorialListHtml}</html>',
  resolveTemplate: (h, vars) => h.replace(/\$\{(\w+)\}/g, (_, k) => vars[k] ?? ''),
}));

const TEST = cds.test('serve', 'AdminService').in(import.meta.dirname, '..', '..');

async function seedFixture() {
  const { Tutorials, TutorialMeta, Users, ImsConfig } = cds.entities('com.sap.developers.ims');
  await DELETE.from(Tutorials);
  await DELETE.from(TutorialMeta);
  await DELETE.from(Users);
  await DELETE.from(ImsConfig);

  await INSERT.into(ImsConfig).entries([
    { ID: cds.utils.uuid(), key: 'staleDaysThreshold', value: '90' },
    { ID: cds.utils.uuid(), key: 'resendIntervalDays', value: '0' },
    { ID: cds.utils.uuid(), key: 'maxNotificationLevel', value: '3' },
    { ID: cds.utils.uuid(), key: 'isNotificationSendingAllowed', value: 'true' },
    { ID: cds.utils.uuid(), key: 'useDigestNotifications', value: 'true' },
  ]);

  const aliceId = cds.utils.uuid();
  await INSERT.into(Users).entries([{
    ID: aliceId, uuid: aliceId, email: 'alice@sap.com',
    displayName: 'Alice', sapId: 'I012345',
  }]);
  const t1Id = cds.utils.uuid();
  const t2Id = cds.utils.uuid();
  const oldDate = new Date(Date.now() - 200 * 86400000).toISOString();
  await INSERT.into(Tutorials).entries([
    { ID: t1Id, slug: 't1', title: 'Tutorial 1', status: 'ACTIVE', author_ID: aliceId },
    { ID: t2Id, slug: 't2', title: 'Tutorial 2', status: 'ACTIVE', author_ID: aliceId },
  ]);
  await INSERT.into(TutorialMeta).entries([
    { ID: cds.utils.uuid(), tutorial_ID: t1Id, monitoredStatus: 'ACTIVE',
      reviewedDate: oldDate, notificationNumber: 1, lastNotificationDate: oldDate },
    { ID: cds.utils.uuid(), tutorial_ID: t2Id, monitoredStatus: 'ACTIVE',
      reviewedDate: oldDate, notificationNumber: 2, lastNotificationDate: oldDate },
  ]);
}

describe('AdminService.sendLastChanceEmail', () => {
  beforeEach(async () => {
    sendSpy.mockReset();
    sendSpy.mockResolvedValue({ success: true });
    await seedFixture();
  });

  it('dryRun=true returns payload without sending', async () => {
    const { data } = await TEST.POST('/admin/sendLastChanceEmail', {
      authorEmail: 'alice@sap.com', dryRun: true,
    });
    expect(data.success).toBe(true);
    expect(data.recipientTo).toBe('alice@sap.com');
    expect(data.tutorialsIncluded).toBe(2);
    expect(data.tutorialSlugs).toEqual(expect.arrayContaining(['t1', 't2']));
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it('dryRun=false sends email with last-chance template', async () => {
    const { data } = await TEST.POST('/admin/sendLastChanceEmail', {
      authorEmail: 'alice@sap.com', dryRun: false,
    });
    expect(data.success).toBe(true);
    expect(sendSpy).toHaveBeenCalledTimes(1);
    expect(sendSpy.mock.calls[0][0].template).toBe('last-chance');
    expect(sendSpy.mock.calls[0][0].variables.authorName).toBe('Alice');
  });

  it('author with no stale tutorials → success=false', async () => {
    const { data } = await TEST.POST('/admin/sendLastChanceEmail', {
      authorEmail: 'nobody@sap.com', dryRun: true,
    });
    expect(data.success).toBe(false);
    expect(data.error).toMatch(/no stale tutorials/i);
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it('case-insensitive author match', async () => {
    const { data } = await TEST.POST('/admin/sendLastChanceEmail', {
      authorEmail: 'ALICE@sap.com', dryRun: true,
    });
    expect(data.success).toBe(true);
    expect(data.tutorialsIncluded).toBe(2);
  });
});
```

If `cds.test()` setup in this codebase differs, mirror the working pattern from an existing admin-service test. The point: in-memory CDS, real `AdminService` mounted, mocked mail-client, asserted side effects.

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run --project unit test/unit/admin-last-chance-action.test.js`
Expected: FAIL — action handler not registered.

- [ ] **Step 4: Implement handler in `srv/admin-service.js`**

After the `testNotificationEmail` handler (~line 1120), insert:

```javascript
this.on('sendLastChanceEmail', async (req) => {
  const { authorEmail, dryRun = false } = req.data;
  if (!authorEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(authorEmail)) {
    return { success: false, error: 'Invalid authorEmail',
             recipientTo: '', recipientCc: [], tutorialsIncluded: 0, tutorialSlugs: [] };
  }
  const {
    computeStaleNotifications, groupNotificationsByAuthor, determineRecipientsForDigest,
    renderTutorialList, resolveTimingKnobs, getAdminEmailList, markNotificationSent,
  } = await import('./lib/contributor-notifications.js');
  const { sendNotificationEmail } = await import('./lib/mail-client.js');

  const knobs = await resolveTimingKnobs();
  const adminEmails = await getAdminEmailList();
  const notifications = await computeStaleNotifications(knobs);
  const digests = groupNotificationsByAuthor(notifications);
  const target = digests.find(d => d.authorEmail?.toLowerCase() === authorEmail.toLowerCase());

  if (!target) {
    return { success: false, error: 'No stale tutorials found for that author',
             recipientTo: '', recipientCc: [], tutorialsIncluded: 0, tutorialSlugs: [] };
  }

  const { to, cc } = determineRecipientsForDigest(target, adminEmails);
  const dashboardUrl = (await resolveDisplaySettings()).dashboardUrl;
  const count = target.tutorials.length;
  const plural = count === 1 ? 'tutorial' : 'tutorials';
  const payload = {
    to, cc,
    subject: `Final notice: ${count} ${plural} pending retirement`,
    template: 'last-chance',
    variables: {
      authorName: target.authorName || 'Tutorial Owner',
      tutorialCount: count,
      tutorialPlural: plural,
      tutorialListHtml: renderTutorialList(target.tutorials, dashboardUrl),
      staleDaysThreshold: knobs.staleDays,
      dashboardUrl,
    },
  };

  if (dryRun) {
    return {
      success: true,
      recipientTo: to[0] ?? '',
      recipientCc: cc,
      tutorialsIncluded: count,
      tutorialSlugs: target.tutorials.map(t => t.slug),
      error: '',
    };
  }

  const result = await sendNotificationEmail(payload);
  if (result.success) {
    for (const t of target.tutorials) await markNotificationSent(t.tutorialId);
  }
  return {
    success: result.success,
    recipientTo: to[0] ?? '',
    recipientCc: cc,
    tutorialsIncluded: count,
    tutorialSlugs: target.tutorials.map(t => t.slug),
    error: result.error ?? '',
  };
});
```

- [ ] **Step 5: Run tests to verify pass**

Run: `npx vitest run --project unit test/unit/admin-last-chance-action.test.js`
Expected: PASS (all 4 cases).

- [ ] **Step 6: Commit**

```bash
git add srv/admin-service.cds srv/admin-service.js test/unit/admin-last-chance-action.test.js
git commit -m "feat(#622): sendLastChanceEmail admin action

Per-author surgical send. Reuses groupNotificationsByAuthor +
determineRecipientsForDigest to assemble the recipient list and
fires the dedicated last-chance template. Increments
notificationNumber on success. dryRun=true returns payload without
sending.

Refs #622"
```

---

## Task 12: Add `sendLastChanceEmailsAllDormant` bulk-sweep action

**Files:**
- Modify: `srv/admin-service.cds` (action declaration)
- Modify: `srv/admin-service.js` (handler)
- Test: `test/unit/admin-bulk-last-chance.test.js` (new)

- [ ] **Step 1: Add CDS declaration**

After `sendLastChanceEmail` in `srv/admin-service.cds`:

```cds
action sendLastChanceEmailsAllDormant(
  dryRun : Boolean
) returns {
  authorsProcessed : Integer;
  emailsSent       : Integer;
  emailsFailed     : Integer;
  authorsSkipped   : Integer;
  errors           : array of String;
  preview          : array of {
    authorEmail   : String;
    tutorialCount : Integer;
    worstLevel    : Integer;
  };
};
```

- [ ] **Step 2: Write the failing test**

Create `test/unit/admin-bulk-last-chance.test.js`:

```javascript
import { describe, it, expect, beforeEach, vi } from 'vitest';
import cds from '@sap/cds';

const sendSpy = vi.fn();
vi.mock('../../srv/lib/mail-client.js', () => ({
  sendNotificationEmail: (opts) => sendSpy(opts),
  loadTemplate: () => '<html>${tutorialListHtml}</html>',
  resolveTemplate: (h, vars) => h.replace(/\$\{(\w+)\}/g, (_, k) => vars[k] ?? ''),
}));

const TEST = cds.test('serve', 'AdminService').in(import.meta.dirname, '..', '..');

async function seedFixture({
  aliceLevel = 3, aliceLastNotifDate = 'old',
  bobLevel = 3, bobLastNotifDate = 'old',
  minLevel = '3', dormancyDays = '60',
} = {}) {
  const { Tutorials, TutorialMeta, Users, ImsConfig } = cds.entities('com.sap.developers.ims');
  await DELETE.from(Tutorials);
  await DELETE.from(TutorialMeta);
  await DELETE.from(Users);
  await DELETE.from(ImsConfig);

  await INSERT.into(ImsConfig).entries([
    { ID: cds.utils.uuid(), key: 'staleDaysThreshold', value: '90' },
    { ID: cds.utils.uuid(), key: 'resendIntervalDays', value: '0' },
    { ID: cds.utils.uuid(), key: 'maxNotificationLevel', value: '3' },
    { ID: cds.utils.uuid(), key: 'isNotificationSendingAllowed', value: 'true' },
    { ID: cds.utils.uuid(), key: 'useDigestNotifications', value: 'true' },
    { ID: cds.utils.uuid(), key: 'lastChanceMinLevel', value: minLevel },
    { ID: cds.utils.uuid(), key: 'lastChanceDormancyDays', value: dormancyDays },
  ]);

  const aliceId = cds.utils.uuid();
  const bobId = cds.utils.uuid();
  await INSERT.into(Users).entries([
    { ID: aliceId, uuid: aliceId, email: 'alice@sap.com', displayName: 'Alice' },
    { ID: bobId, uuid: bobId, email: 'bob@sap.com', displayName: 'Bob' },
  ]);

  const oldReview = new Date(Date.now() - 200 * 86400000).toISOString();
  const oldNotif = new Date(Date.now() - 80 * 86400000).toISOString();
  const recentNotif = new Date(Date.now() - 1 * 86400000).toISOString();
  const aliceLN = aliceLastNotifDate === 'old' ? oldNotif : recentNotif;
  const bobLN = bobLastNotifDate === 'old' ? oldNotif : recentNotif;

  const t1 = cds.utils.uuid(), t2 = cds.utils.uuid();
  await INSERT.into(Tutorials).entries([
    { ID: t1, slug: 't1', title: 'T1', status: 'ACTIVE', author_ID: aliceId },
    { ID: t2, slug: 't2', title: 'T2', status: 'ACTIVE', author_ID: bobId },
  ]);
  await INSERT.into(TutorialMeta).entries([
    { ID: cds.utils.uuid(), tutorial_ID: t1, monitoredStatus: 'ACTIVE',
      reviewedDate: oldReview, notificationNumber: aliceLevel, lastNotificationDate: aliceLN },
    { ID: cds.utils.uuid(), tutorial_ID: t2, monitoredStatus: 'ACTIVE',
      reviewedDate: oldReview, notificationNumber: bobLevel, lastNotificationDate: bobLN },
  ]);
}

describe('AdminService.sendLastChanceEmailsAllDormant', () => {
  beforeEach(() => { sendSpy.mockReset(); sendSpy.mockResolvedValue({ success: true }); });

  it('dryRun=true: both authors qualify', async () => {
    await seedFixture();
    const { data } = await TEST.POST('/admin/sendLastChanceEmailsAllDormant', { dryRun: true });
    expect(data.authorsProcessed).toBe(2);
    expect(data.preview).toHaveLength(2);
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it('dryRun=true: bob recent notif → only alice qualifies', async () => {
    await seedFixture({ bobLastNotifDate: 'recent' });
    const { data } = await TEST.POST('/admin/sendLastChanceEmailsAllDormant', { dryRun: true });
    expect(data.authorsProcessed).toBe(1);
    expect(data.preview[0].authorEmail).toBe('alice@sap.com');
  });

  it('dryRun=true: bob level 2 → only alice qualifies', async () => {
    await seedFixture({ bobLevel: 2 });
    const { data } = await TEST.POST('/admin/sendLastChanceEmailsAllDormant', { dryRun: true });
    expect(data.authorsProcessed).toBe(1);
  });

  it('dryRun=false: fires one email per qualifying author', async () => {
    await seedFixture();
    const { data } = await TEST.POST('/admin/sendLastChanceEmailsAllDormant', { dryRun: false });
    expect(data.authorsProcessed).toBe(2);
    expect(data.emailsSent).toBe(2);
    expect(sendSpy).toHaveBeenCalledTimes(2);
  });

  it('lastChanceMinLevel=99 → nobody qualifies', async () => {
    await seedFixture({ minLevel: '99' });
    const { data } = await TEST.POST('/admin/sendLastChanceEmailsAllDormant', { dryRun: false });
    expect(data.authorsProcessed).toBe(0);
    expect(sendSpy).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run --project unit test/unit/admin-bulk-last-chance.test.js`
Expected: FAIL — handler not registered.

- [ ] **Step 4: Implement handler**

Before the per-author handler, extract its body into a private helper to keep the bulk action DRY. Replace the entire `this.on('sendLastChanceEmail', ...)` from Task 11 with this refactor + add the bulk handler:

```javascript
// Private helper — shared between per-author and bulk actions.
async function sendLastChanceForAuthor(authorEmail, dryRun, ctx) {
  if (!authorEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(authorEmail)) {
    return { success: false, error: 'Invalid authorEmail',
             recipientTo: '', recipientCc: [], tutorialsIncluded: 0, tutorialSlugs: [] };
  }
  const knobs = await ctx.resolveTimingKnobs();
  const adminEmails = await ctx.getAdminEmailList();
  const notifications = await ctx.computeStaleNotifications(knobs);
  const digests = ctx.groupNotificationsByAuthor(notifications);
  const target = digests.find(d => d.authorEmail?.toLowerCase() === authorEmail.toLowerCase());

  if (!target) {
    return { success: false, error: 'No stale tutorials found for that author',
             recipientTo: '', recipientCc: [], tutorialsIncluded: 0, tutorialSlugs: [] };
  }

  const { to, cc } = ctx.determineRecipientsForDigest(target, adminEmails);
  const dashboardUrl = (await resolveDisplaySettings()).dashboardUrl;
  const count = target.tutorials.length;
  const plural = count === 1 ? 'tutorial' : 'tutorials';
  const payload = {
    to, cc,
    subject: `Final notice: ${count} ${plural} pending retirement`,
    template: 'last-chance',
    variables: {
      authorName: target.authorName || 'Tutorial Owner',
      tutorialCount: count, tutorialPlural: plural,
      tutorialListHtml: ctx.renderTutorialList(target.tutorials, dashboardUrl),
      staleDaysThreshold: knobs.staleDays,
      dashboardUrl,
    },
  };

  const baseReturn = {
    recipientTo: to[0] ?? '',
    recipientCc: cc,
    tutorialsIncluded: count,
    tutorialSlugs: target.tutorials.map(t => t.slug),
  };

  if (dryRun) return { success: true, ...baseReturn, error: '' };

  const result = await ctx.sendNotificationEmail(payload);
  if (result.success) {
    for (const t of target.tutorials) await ctx.markNotificationSent(t.tutorialId);
  }
  return { success: result.success, ...baseReturn, error: result.error ?? '' };
}

// Refactored per-author handler — delegates to helper.
this.on('sendLastChanceEmail', async (req) => {
  const cn = await import('./lib/contributor-notifications.js');
  const mc = await import('./lib/mail-client.js');
  return sendLastChanceForAuthor(req.data.authorEmail, req.data.dryRun ?? false, { ...cn, ...mc });
});

// New bulk-sweep handler.
this.on('sendLastChanceEmailsAllDormant', async (req) => {
  const { dryRun = false } = req.data;
  const cn = await import('./lib/contributor-notifications.js');
  const mc = await import('./lib/mail-client.js');
  const ctx = { ...cn, ...mc };

  const knobs = await cn.resolveTimingKnobs();
  const notifications = await cn.computeStaleNotifications(knobs);
  const digests = cn.groupNotificationsByAuthor(notifications);
  const dormancyCutoff = new Date(Date.now() - knobs.lastChanceDormancyDays * 86400000).toISOString();

  const qualifying = digests.filter(d =>
    d.authorEmail != null
    && d.tutorials.some(t =>
      t.notificationLevel >= knobs.lastChanceMinLevel
      && t.lastNotificationDate
      && t.lastNotificationDate < dormancyCutoff
    )
  );

  if (dryRun) {
    return {
      authorsProcessed: qualifying.length,
      emailsSent: 0, emailsFailed: 0, authorsSkipped: 0, errors: [],
      preview: qualifying.map(d => ({
        authorEmail: d.authorEmail,
        tutorialCount: d.tutorials.length,
        worstLevel: d.worstLevel,
      })),
    };
  }

  let sent = 0, failed = 0;
  const errors = [];
  for (const d of qualifying) {
    try {
      const result = await sendLastChanceForAuthor(d.authorEmail, false, ctx);
      if (result.success) sent++;
      else { failed++; errors.push(`${d.authorEmail}: ${result.error}`); }
    } catch (err) {
      failed++;
      errors.push(`${d.authorEmail}: ${err.message}`);
    }
  }
  return {
    authorsProcessed: qualifying.length,
    emailsSent: sent, emailsFailed: failed, authorsSkipped: 0, errors,
    preview: [],
  };
});
```

(`sendLastChanceForAuthor` is defined in the same `init()` scope as the `this.on()` handlers so it closes over the same `cds` import. If your code-style elsewhere prefers module-level helpers, hoist it — both shapes work.)

**Implementer note — dynamic vs static imports:** the handlers use `await import('./lib/contributor-notifications.js')` and `await import('./lib/mail-client.js')`. This is the pattern used elsewhere in this admin-service file (see existing `sendContributorNotifications` at ~line 1070). Vitest hoists `vi.mock()` calls, so the test mocks should resolve correctly. If you observe mock-resolution flakes, switch the admin-service imports to top-of-file statics — the tests should keep passing either way.

- [ ] **Step 5: Run all tests to verify pass + no regression**

```
npx vitest run --project unit test/unit/admin-bulk-last-chance.test.js test/unit/admin-last-chance-action.test.js
```

Expected: PASS for both files.

- [ ] **Step 6: Commit**

```bash
git add srv/admin-service.cds srv/admin-service.js test/unit/admin-bulk-last-chance.test.js
git commit -m "feat(#622): sendLastChanceEmailsAllDormant bulk-sweep action

Resolves lastChanceMinLevel + lastChanceDormancyDays from ImsConfig.
Author qualifies when at least one tutorial has notificationLevel
above the floor AND lastNotificationDate older than the dormancy
cutoff. dryRun=true returns preview[]; dryRun=false fires per-author
sends serially.

Refactors sendLastChanceEmail to use a shared sendLastChanceForAuthor
helper so the bulk path reuses identical send logic + state advance.

Refs #622"
```

---

## Task 13: `DormantAuthors` view + Operations admin UI tile

**Files:**
- Modify: `db/views.cds` (or the file `srv/admin-service.cds` imports as `'../db/views'`)
- Modify: `srv/admin-service.cds`
- Modify: `app/admin-annotations.cds`
- Modify: `app/admin/operations/` (Fiori OP — exact files depend on the existing app shape)

**Pre-step — survey existing patterns:**

```bash
fd views.cds db/ -a
cat $(fd views.cds db/ -a | head -1) | head -80
ls app/admin/operations/webapp/
cat app/admin/operations/webapp/manifest.json | jq '.["sap.ui5"]'
# Specifically, look at how testNotificationEmail is wired as a
# DataFieldForAction or similar in the operations Fiori app annotations
# — mirror that exact pattern for the new actions.
grep -rn "testNotificationEmail" app/admin/operations/ app/admin-annotations.cds
```

- [ ] **Step 1: Define `DormantAuthors` view**

In the views file (`db/views.cds` or equivalent — match the existing namespace + style):

```cds
@cds.persistence.exists: false
define view com.sap.developers.ims.DormantAuthors as
  select from com.sap.developers.ims.TutorialMeta as m
    inner join com.sap.developers.ims.Tutorials as t on m.tutorial.ID = t.ID
    inner join com.sap.developers.ims.Users as u on t.author.ID = u.ID
  where m.monitoredStatus = 'ACTIVE'
    and t.status = 'ACTIVE'
    and u.email is not null
  {
    key u.email                   as authorEmail        : String(255),
        u.displayName             as authorName         : String(255),
        count(*)                  as tutorialCount      : Integer,
        max(m.notificationNumber) as worstLevel         : Integer,
        min(m.reviewedDate)       as oldestReviewedDate : Timestamp,
  } group by u.email, u.displayName;
```

**Caveat:** the view only enumerates FK-resolved authors (Q2 primary path). Contributors-only authors are reachable via the bulk-sweep action at runtime but won't appear in the admin dropdown for surgical send. Acceptable for v1 — admin can still POST `sendLastChanceEmail` directly with any email.

- [ ] **Step 2: Expose view on `AdminService`**

In `srv/admin-service.cds`, near other read-only projections:

```cds
@readonly
entity DormantAuthors as projection on ims.DormantAuthors;
```

- [ ] **Step 3: Run `cds build --production`**

```bash
npx cds build --production
```

Expected: clean. Per memory `feedback_cds_build_production_not_cds_compile_for_last_dev`, stage any `db/last-dev/` and `db/src/` changes if produced.

- [ ] **Step 4: Annotate the view + actions for Fiori**

In `app/admin-annotations.cds`:

```cds
annotate AdminService.DormantAuthors with @UI : {
  HeaderInfo : { TypeName : 'Dormant Author', TypeNamePlural : 'Dormant Authors',
                 Title : { Value : authorName }, Description : { Value : authorEmail } },
  Identification : [
    { Value : authorEmail },
  ],
  LineItem : [
    { Value : authorName,         Label : 'Author' },
    { Value : authorEmail,        Label : 'Email' },
    { Value : tutorialCount,      Label : 'Stale Tutorials' },
    { Value : worstLevel,         Label : 'Worst Level' },
    { Value : oldestReviewedDate, Label : 'Oldest Reviewed' },
  ],
};
```

Wire the per-author action by adding to the same block:

```cds
annotate AdminService.DormantAuthors with actions {
  // The action is unbound on the service, but we expose it as a row-level
  // press by passing authorEmail from the row context.
};
```

(Exact UI-action plumbing for unbound actions in Fiori Elements V4 varies; pattern in this repo: look at how `testNotificationEmail` is wired in the Operations OP. Mirror that shape.)

- [ ] **Step 5: Operations OP UI wiring**

Read `app/admin/operations/webapp/manifest.json` first. Then add a "Last Chance Emails" section. Concrete deliverables:

1. A table bound to `DormantAuthors` with the columns from Step 4.
2. A "Send Last Chance Email" row-level action (calls `sendLastChanceEmail({ authorEmail: <row email>, dryRun: false })` — with a confirm dialog showing the dry-run result first).
3. A "Bulk Sweep" tile with two buttons: "Preview qualifying authors" (`sendLastChanceEmailsAllDormant({ dryRun: true })`) and "Send to all" (`{ dryRun: false }` after a confirm dialog).

Per memory `feedback_ui5_dialog_open_property`: use `.open = true` (not `.show()`) for UI5 v2 dialogs.

- [ ] **Step 6: Smoke-check locally**

```bash
npm run dev:hybrid
```

Visit `http://localhost:5000/admin-ui/#operations-display`. Verify the new section renders, "Preview" returns a count, "Send" opens a confirm dialog.

- [ ] **Step 7: Commit**

```bash
git add db/views.cds srv/admin-service.cds app/admin-annotations.cds app/admin/operations/ db/last-dev/ db/src/ 2>/dev/null || true
git commit -m "feat(#622): DormantAuthors view + Operations admin UI tile

Read-only view exposes one row per FK-resolved author with ≥1 stale
tutorial. Operations Fiori OP gains a 'Last Chance Emails' section
with per-author send (row action) + bulk sweep (preview + confirm).

Contributors-only authors not in the dropdown — admin can still
POST sendLastChanceEmail with any email directly.

Refs #622"
```

---

## Task 14: Hybrid test against real HANA

**Files:**

- Test: `test/hybrid/digest-cron.test.js` (new)

- [ ] **Step 1: Write the hybrid test**

Create `test/hybrid/digest-cron.test.js`. Pattern: follow `test/hybrid/_guard.js` + existing tests for the `ALLOW_HYBRID_WRITES` + `__TEST__` prefix conventions.

```javascript
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import cds from '@sap/cds';
import './_guard.js';

const sentMessages = [];
vi.mock('../../srv/lib/mail-client.js', async (orig) => {
  const actual = await orig();
  return {
    ...actual,
    sendNotificationEmail: async (opts) => {
      sentMessages.push(opts);
      return { success: true };
    },
  };
});

const TEST_PREFIX = '__TEST_622__';
const created = { users: [], tutorials: [], meta: [], imsConfig: [] };

beforeAll(async () => {
  await cds.connect.to('db');
  const { Tutorials, TutorialMeta, Users, ImsConfig } = cds.entities('com.sap.developers.ims');

  const aliceId = cds.utils.uuid();
  created.users.push(aliceId);
  await INSERT.into(Users).entries([{
    ID: aliceId, uuid: aliceId,
    email: `${TEST_PREFIX}alice@example.com`,
    displayName: `${TEST_PREFIX}Alice`,
  }]);

  const oldDate = new Date(Date.now() - 200 * 86400000).toISOString();
  for (let i = 1; i <= 3; i++) {
    const tId = cds.utils.uuid();
    const mId = cds.utils.uuid();
    created.tutorials.push(tId);
    created.meta.push(mId);
    await INSERT.into(Tutorials).entries({
      ID: tId, slug: `${TEST_PREFIX}slug-${i}`,
      title: `${TEST_PREFIX}Tutorial ${i}`,
      status: 'ACTIVE', author_ID: aliceId,
    });
    await INSERT.into(TutorialMeta).entries({
      ID: mId, tutorial_ID: tId, monitoredStatus: 'ACTIVE',
      reviewedDate: oldDate, notificationNumber: 1, lastNotificationDate: null,
    });
  }

  for (const [key, value] of [
    ['useDigestNotifications', 'true'],
    ['isNotificationSendingAllowed', 'true'],
  ]) {
    const existing = await SELECT.one.from(ImsConfig).where({ key });
    if (existing) await UPDATE(ImsConfig, existing.ID).set({ value });
    else {
      const id = cds.utils.uuid();
      created.imsConfig.push(id);
      await INSERT.into(ImsConfig).entries({ ID: id, key, value });
    }
  }
});

afterAll(async () => {
  const { Tutorials, TutorialMeta, Users, ImsConfig } = cds.entities('com.sap.developers.ims');
  for (const id of created.meta) await DELETE.from(TutorialMeta).where({ ID: id });
  for (const id of created.tutorials) await DELETE.from(Tutorials).where({ ID: id });
  for (const id of created.users) await DELETE.from(Users).where({ ID: id });
  for (const id of created.imsConfig) await DELETE.from(ImsConfig).where({ ID: id });
});

describe('Digest cron against real HANA', () => {
  it('3 tutorials for one author → exactly 1 digest queued', async () => {
    const { runContributorNotificationsCycle } = await import('../../srv/jobs/scheduler.js');
    sentMessages.length = 0;
    await runContributorNotificationsCycle('hybrid-test-log-id');
    const ours = sentMessages.filter(m => m.to?.[0]?.includes(`${TEST_PREFIX}alice`));
    expect(ours).toHaveLength(1);
    expect(ours[0].template).toMatch(/^digest-level-/);
    expect(ours[0].variables.tutorialCount).toBe(3);
  });
});
```

- [ ] **Step 2: Run hybrid test**

Requires `cf login` to DEV space:

```bash
export ALLOW_HYBRID_WRITES=true
npm run test:hybrid -- test/hybrid/digest-cron.test.js
```

Expected: PASS. Cleanup removes seeded rows.

- [ ] **Step 3: Commit**

```bash
git add test/hybrid/digest-cron.test.js
git commit -m "test(#622): hybrid digest-cron test

Seeds 3 __TEST_622__ tutorials for one synthetic author against real
HANA. Verifies runContributorNotificationsCycle queues exactly one
digest email. Cleans up via __TEST__ prefix + afterAll.

Refs #622"
```

---

## Task 15: Smoke test + docs update

**Files:**

- Test: `test/smoke/admin-last-chance.smoke.test.js` (new)
- Modify: `docs/developers/operations/smtp-credentials-rotation.md`

- [ ] **Step 1: Write the smoke test**

Create `test/smoke/admin-last-chance.smoke.test.js`. Pattern: follow `test/smoke/auth-enforcement.test.js`.

```javascript
import { describe, it, expect } from 'vitest';

const SRV_URL = process.env.SMOKE_SRV_URL;
const TOKEN = process.env.SMOKE_ADMIN_TOKEN;

describe.skipIf(!SRV_URL || !TOKEN)('admin sendLastChanceEmail smoke', () => {
  it('returns 200 success=false for nonexistent author (dryRun)', async () => {
    const res = await fetch(`${SRV_URL}/admin/sendLastChanceEmail`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${TOKEN}`,
      },
      body: JSON.stringify({ authorEmail: 'nonexistent-smoke-test@example.com', dryRun: true }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.error).toMatch(/no stale tutorials/i);
  });

  it('requires admin auth (401/403 without token)', async () => {
    const res = await fetch(`${SRV_URL}/admin/sendLastChanceEmail`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ authorEmail: 'x@y.com', dryRun: true }),
    });
    expect([401, 403]).toContain(res.status);
  });
});
```

- [ ] **Step 2: Run smoke test (post-deploy — see Task 16)**

```bash
SMOKE_SRV_URL=https://tutorial-system-dev-tutorials-srv.cfapps.eu10-005.hana.ondemand.com \
  SMOKE_ADMIN_TOKEN=<your-xsuaa-token> \
  npm run test:smoke -- test/smoke/admin-last-chance.smoke.test.js
```

Expected: PASS (both cases). Skipped if env vars unset.

- [ ] **Step 3: Update the SMTP rotation runbook**

In `docs/developers/operations/smtp-credentials-rotation.md`, append:

```markdown
### Per-author "Last Chance" emails (#622)

In addition to `testNotificationEmail` (single-recipient SMTP check),
`/admin-ui/#operations-display` now exposes:

- **Per-author send** — surgical "last chance" email to one author covering
  all their stale tutorials. Use Preview (dryRun) first to verify the
  recipient list, then Send Now.
- **Bulk sweep** — fires per-author last-chance emails to every author
  whose worst tutorial is at `lastChanceMinLevel` (default 3) AND whose
  last notification is older than `lastChanceDormancyDays`
  (default 60) ago. Both knobs admin-tunable via `ImsConfig`.

Both actions use a dedicated `last-chance.html` template distinct from
the cron's automated L3 — Riley/Tom can edit the human-tone copy
without disturbing the weekly cron. Same SMTP path; same
`FailedEmails` retry queue.
```

- [ ] **Step 4: Commit**

```bash
git add test/smoke/admin-last-chance.smoke.test.js docs/developers/operations/smtp-credentials-rotation.md
git commit -m "test(#622): smoke test for sendLastChanceEmail + runbook update

Smoke: nonexistent author (dryRun) returns 200 + success=false;
unauthenticated request returns 401/403.

Runbook: appends a section describing the two new admin actions
and the dedicated last-chance.html template.

Refs #622"
```

---

## Task 16: Full validation + push + PR

- [ ] **Step 1: Run the full unit suite**

```bash
npm test
```

Expected: All tests pass. If any test fails that looks unrelated, check memory `feedback_check_scripts_pool_flake_on_windows` for known flakes and re-run in isolation.

- [ ] **Step 2: Run `cds build --production`**

```bash
npx cds build --production
```

Expected: clean. Stage any `db/last-dev/` and `db/src/` changes:

```bash
git status db/last-dev/ db/src/ 2>/dev/null
git add db/last-dev/ db/src/ 2>/dev/null
git commit --amend --no-edit 2>/dev/null || true
```

(If amend isn't appropriate, make a separate "chore: refresh cds build artifacts" commit.)

- [ ] **Step 3: Verify branch + push**

```bash
git branch --show-current
# Expected: feat/622-author-digest-last-chance
git push -u origin feat/622-author-digest-last-chance
```

- [ ] **Step 4: Open the PR**

```bash
gh pr create --title "feat(#622): per-author digest cron + last-chance admin actions" --body "Closes #622.

Refactors the weekly author-nudge cron to send one digest email per author
(grouping all of that author's stale tutorials) instead of one email per
stale tutorial. Adds two admin-triggered 'Last Chance' actions
(\`sendLastChanceEmail\` per-author + \`sendLastChanceEmailsAllDormant\`
bulk sweep) driven by a dedicated \`last-chance.html\` template.

## What

- New helpers in srv/lib/contributor-notifications.js:
  groupNotificationsByAuthor, digestSubject, renderTutorialList,
  determineRecipientsForDigest, escapeHtml.
- sendNotificationEmail gains an optional template parameter (additive;
  legacy level path untouched).
- Weekly cron branches on ImsConfig.useDigestNotifications (default true).
  Legacy per-tutorial loop reachable for one-flag rollback.
- 4 new templates digest-level-{0,1,2,3}.html + last-chance.html.
- 3 new knobs (useDigestNotifications, lastChanceMinLevel, lastChanceDormancyDays).
- New DormantAuthors view + Operations admin UI tile.

## How to test

- Unit: \`npm test\` — all new tests pass.
- Hybrid: \`ALLOW_HYBRID_WRITES=true npm run test:hybrid\` — digest-cron test exercises real HANA.
- Smoke (post-deploy): \`npm run test:smoke -- test/smoke/admin-last-chance.smoke.test.js\`.

## Rollback

1. Flip ImsConfig.useDigestNotifications=false via /admin-ui/#operations-display (1 min, no deploy).
2. Or flip ImsConfig.isNotificationSendingAllowed=false.
3. Or git revert this PR.

Spec: docs/superpowers/specs/2026-06-27-622-author-digest-last-chance-design.md
Plan: docs/superpowers/plans/2026-06-27-622-author-digest-last-chance.md
Builds on #545."
```

- [ ] **Step 5: Confirm deploy scope with Tom before any MTA deploy**

Per memory `feedback_confirm_deploy_scope`: ask which scope (backend-only / +content / +QA) before kicking off `mbt build` + `cf deploy`. Don't auto-deploy.

---

## Task dependencies

- Tasks **1, 2, 3** are independent (new helpers, no cross-refs). Safe to parallelize.
- Task **4** independent.
- Task **5** depends on Task 4 (key names).
- Task **6** must precede Task **7** (groupNotificationsByAuthor reads `authorUserEmail`/`authorUserName`).
- Task **7** must precede Task **8** (determineRecipientsForDigest consumes `AuthorDigest`).
- Tasks **1, 7, 8, 9** must precede Task **10** (cron refactor uses all of them).
- Task **10** must precede Tasks **11, 12** (admin actions reuse the same helpers).
- Task **13** (UI) depends on Tasks 11+12 (actions must exist on `AdminService.cds`).
- Tasks **14, 15** require the prior tasks complete; smoke also needs a deploy.

**Recommended order:** 1, 2, 3 (parallel) → 4 → 5 → 6 → 7 → 8 → 9 → 10 → 11 → 12 → 13 → 14 → 15 → 16.

