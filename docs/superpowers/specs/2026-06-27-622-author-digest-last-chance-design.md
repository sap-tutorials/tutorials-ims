# Author-Nudge Digest + "Last Chance" Admin Action

**Status:** Approved (Tom, 2026-06-27). Ready for implementation plan.
**Tracks:** [#622 — Need "one last chance" email blast capability](https://github.com/sap-tutorials/tutorials-ims/issues/622)
**Builds on:** [#545 — Author-nudge emails: investigate IMS legacy behavior + design CAP replacement](https://github.com/sap-tutorials/tutorials-ims/issues/545) (closed; SMTP transport, credstore resolver, `FailedEmails` retry queue, 4 escalating per-tutorial templates, weekly cron at [srv/jobs/scheduler.js:142](../../../srv/jobs/scheduler.js#L142) are all shipped).

## Background

Today, the weekly author-nudge cron sends **one email per stale tutorial**. An author with 5 stale tutorials gets 5 separate emails per cycle, each escalating through levels 0→3 independently. Riley flagged two problems:

1. **High-volume authors get a disproportionate noise level** — 5 emails in a Monday inbox dilutes the urgency of each one.
2. **There is no surgical "last chance" mechanism** for an admin to send a final, human-tone consolidated notice when the cron's escalation has clearly not worked. Riley has been CC'ing Tom on hand-crafted versions of this email.

A third concern — backup contact (team lead) when the author is unreachable — is acknowledged but deferred to a follow-up issue (Q6 below).

## Goal

Two additive changes, both gated for safe rollback:

1. **Per-author digest** — the weekly cron groups stale tutorials by author and sends one email per author per cycle, using a template chosen by the worst-case escalation level present in the bundle.
2. **Admin-triggered "Last Chance"** — two new `@requires: 'Admin'` actions (`sendLastChanceEmail` per-author and `sendLastChanceEmailsAllDormant` bulk sweep), driven by a dedicated `last-chance.html` template so Tom/Riley can write a human-tone final notice distinct from the cron's automated L3 admin notification.

Both changes ride on top of #545's existing infrastructure (SMTP, credstore, retry queue, templates, scheduler, `markNotificationSent`, audit-logging) — nothing in that infra is modified.

## Non-goals

- Replacing the cron's escalation ladder (`STALE_DAYS_DEFAULT=90`, levels 0→3, weekly Mon 09:00 UTC). Stays.
- Replacing or rotating the SMTP transport, credstore resolver, or `FailedEmails` retry queue. Stays.
- Adding `Users.teamLeadEmail` as a backup-contact field (Q6 below). Separate follow-up issue.
- Removing the legacy per-tutorial code path. Stays reachable via `ImsConfig.useDigestNotifications=false` for one-flag rollback. A follow-up issue removes the flag + legacy branch after 2-3 successful PROD digest cycles.
- Per-author opt-out (author requests removal from automated nudges). Not in Riley's ask. Out of scope.

## Decisions

The six brainstorming questions resolved 2026-06-27 with Tom:

| # | Question | Decision |
|---|---|---|
| Q1 | Scope | **B** — digest refactor of the weekly cron, **plus** admin-triggered last-chance action |
| Q2 | Author resolution | **C** — prefer `Tutorials.author → Users.email`, fall back to `TutorialContributors` OWNER-then-AUTHOR |
| Q3 | Mixed-level digests | **A** — use the highest level present; each tutorial's `notificationNumber` still advances independently |
| Q4 | Admin actions | **C₁** — per-author button **AND** bulk sweep, new dedicated `last-chance.html` template |
| Q5 | Bulk sweep gating | **D** — admin-tunable `lastChanceMinLevel` (default 3) **AND** `lastChanceDormancyDays` (default 60) |
| Q6 | Team-lead backup contact | **A** — out of scope; separate follow-up issue |
| — | Architecture (wrap vs. replace) | **A** — wrap, don't replace. Gate via `useDigestNotifications` flag for one-click rollback. |

## Architecture

Three additive pieces; each ships and rolls back independently. Nothing in [srv/lib/contributor-notifications.js](../../../srv/lib/contributor-notifications.js) gets modified — we wrap.

### 1. `groupNotificationsByAuthor(notifications)` — new helper

New export in [srv/lib/contributor-notifications.js](../../../srv/lib/contributor-notifications.js). Takes the existing `computeStaleNotifications()` output (array of per-tutorial notification records) and re-keys by author email.

```
groupNotificationsByAuthor(notifications) -> Array<AuthorDigest>

Where AuthorDigest = {
  authorEmail: string | null,              // group key (case-folded); null bucket for unresolvable
  authorSource: 'Tutorials.author' | 'TutorialContributors' | 'none',
  authorName:  string | null,              // Users.displayName if FK path; else contributor.name
  tutorials:   Array<Notification>,        // 1..N per-tutorial records
  worstLevel:  0 | 1 | 2 | 3,              // max(notificationNumber) across tutorials
  worstReviewedDate: ISOString             // min(reviewedDate) — "oldest unreviewed" headline
}
```

Resolution rule per tutorial (Q2):

1. If `Tutorials.author` FK is set AND `Users.email` is non-empty → use `Users.email`, `authorSource = 'Tutorials.author'`.
2. Else → pick from `contributors[]` using existing `OWNER` → `AUTHOR` priority (mirrors today's `determineRecipients()`), `authorSource = 'TutorialContributors'`.
3. Else → `authorEmail = null`, `authorSource = 'none'`. Tutorial enters the `null`-keyed bucket; cron logs SKIPPED.

Group key is `email.toLowerCase()` so case differences between FK path and contributor path converge. `authorSource` on the resulting digest reflects whichever path resolved first in iteration order — used only for log breadcrumbs, not for behavior.

The function is **pure** — array in, array out. No DB calls. One small upstream change: `computeStaleNotifications()` widens its second SELECT to include `author.email AS authorUserEmail` and `author.displayName AS authorUserName` alongside the existing `repository.repositoryOwner.email`. Per-tutorial records gain those two fields. ~3 lines of touch, no new query.

### 2. Cron refactor at [srv/jobs/scheduler.js:142](../../../srv/jobs/scheduler.js#L142)

New `ImsConfig.useDigestNotifications` knob (default `true`). The cron body branches:

```
WEEKLY MON 09:00
  if !isNotificationsEnabled(): return { enabled: false }
  knobs        = resolveTimingKnobs()                  // existing + 3 new
  adminEmails  = getAdminEmailList()                   // existing
  notifications = computeStaleNotifications(knobs)     // existing (widened SELECT)
  dashboardUrl  = resolveDisplaySettings().dashboardUrl

  if knobs.useDigest:
    digests = groupNotificationsByAuthor(notifications)
    for d in digests:
      if d.authorEmail == null:
        logJobItem(SKIPPED, "no recipient resolvable"); continue
      { to, cc } = determineRecipientsForDigest(d, adminEmails)
      result = sendNotificationEmail({
        to, cc,
        subject:  digestSubject(d),                    // see §4 wording
        template: `digest-level-${d.worstLevel}`,      // base name; loadTemplate adds .html
        variables: {
          authorName:         d.authorName || 'Tutorial Owner',
          tutorialCount:      d.tutorials.length,
          tutorialPlural:     d.tutorials.length === 1 ? 'tutorial' : 'tutorials',
          tutorialListHtml:   renderTutorialList(d.tutorials, dashboardUrl),
          staleDaysThreshold: knobs.staleDays,
          dashboardUrl
        }
      })
      if result.success:
        for t in d.tutorials: markNotificationSent(t.tutorialId)
      logJobItem(SUCCESS | ERROR, ...)
  else:
    [existing per-tutorial loop, verbatim]
```

`determineRecipientsForDigest(digest, adminEmails)` wraps existing `determineRecipients()`: synthesizes a notification record with `notificationLevel = digest.worstLevel`, `contributors = [{ email: digest.authorEmail, role: 'OWNER' }]`, and the union of all per-tutorial `repoOwner` emails. The wrapper dedupes the resulting CC list (multiple tutorials sharing a repo owner → that email appears once) and drops any entry that duplicates `to`.

Cron pattern and the escalation ladder (in `determineRecipients`) stay hardcoded — same rationale as #545: cron strings in DB are operationally fragile, escalation ladder hasn't changed since IMS inception.

### 3. `sendNotificationEmail` — additive `template` parameter

The current signature at [srv/lib/mail-client.js:100](../../../srv/lib/mail-client.js#L100) is:

```js
sendNotificationEmail({ to, cc, subject, level, variables })
  // internally: loadTemplate(level) → TEMPLATE_NAMES[level] → first|second|third|final
```

This spec **extends** the signature additively (Q-architecture: wrap, don't replace) — the new optional `template` parameter takes precedence over `level` when provided:

```js
sendNotificationEmail({ to, cc, subject, level, variables, template })
  // if template is provided: loadTemplate(template) by filename
  // else: existing loadTemplate(level) ladder, unchanged
```

`loadTemplate()` widens to accept either a numeric level (existing behavior) or a template **base name** string without extension (e.g. `'digest-level-2'`, `'last-chance'`). It reads `srv/templates/notification/${name}.html` either way. Call sites pass the bare base name (no `.html` suffix) — `loadTemplate()` owns the extension. Two-line touch.

This keeps the per-tutorial cron's legacy path byte-identical (calls with `level: n`, no `template`) while letting the digest cron and the admin actions pass `template: 'digest-level-${d.worstLevel}'` or `template: 'last-chance'`. Tests #6 + #7 cover the new path; existing #545 tests cover the legacy path unchanged.

### 4. Digest template & rendering

Four new templates: `srv/templates/notification/digest-level-{0,1,2,3}.html`, one per level, mirroring the existing per-tutorial templates' tone:

- `digest-level-0.html` — friendly first reminder.
- `digest-level-1.html` — second reminder, CC adds repo owner.
- `digest-level-2.html` — third reminder, CC adds admins.
- `digest-level-3.html` — admins-only final pass.

Each renders:

- Greeting: `Dear ${authorName}` (falls back to `'Tutorial Owner'` per Q1's data flow).
- A one-paragraph framing matching the level's urgency.
- `${tutorialListHtml}` — a pre-rendered `<ul>` of tutorial titles, last-reviewed dates, and dashboard links.
- The existing "what action do you need to take" guidance, adapted for multi-tutorial wording.
- Standard signature: "SAP Developers Tutorials Team".

**Subject lines** — built by a small helper `digestSubject(d)` colocated in [srv/lib/contributor-notifications.js](../../../srv/lib/contributor-notifications.js):

```js
function digestSubject(digest) {
  const plural = digest.tutorials.length === 1 ? 'tutorial' : 'tutorials';
  if (digest.worstLevel === 3) {
    return `FINAL NOTICE: ${digest.tutorials.length} stale ${plural} pending retirement`;
  }
  return `${digest.tutorials.length} stale ${plural} need review`;
}
```

The last-chance admin action builds its subject inline in [srv/admin-service.js](../../../srv/admin-service.js):

- Last-chance subject: `` `Final notice: ${count} ${plural} pending retirement` ``

`renderTutorialList(tutorials, dashboardUrl)` is a new helper in [srv/lib/contributor-notifications.js](../../../srv/lib/contributor-notifications.js):

```js
function renderTutorialList(tutorials, dashboardUrl) {
  const items = tutorials.map(t => {
    const title = escapeHtml(t.title);
    const slug  = encodeURIComponent(t.slug);
    const date  = t.reviewedDate?.slice(0, 10) ?? '—';
    return `<li><a href="${dashboardUrl}#/tutorial/${slug}">${title}</a> — last reviewed ${date}</li>`;
  });
  return `<ul>${items.join('')}</ul>`;
}
```

`escapeHtml` is defense-in-depth — we don't expect malicious strings in tutorial titles, but it's free.

**Why pre-rendered HTML and not a loop in the template:** today's [srv/lib/mail-client.js:49](../../../srv/lib/mail-client.js#L49) `resolveTemplate()` is straight `${var}` substitution with no iteration support. Pre-rendering keeps the template engine untouched and the new helper trivially testable.

### 5. Admin actions — `sendLastChanceEmail` & `sendLastChanceEmailsAllDormant`

Two new `@requires: 'Admin'` actions in [srv/admin-service.cds](../../../srv/admin-service.cds):

```cds
action sendLastChanceEmail(
  authorEmail : String,
  dryRun      : Boolean
) returns {
  success:           Boolean;
  recipientTo:       String;
  recipientCc:       array of String;
  tutorialsIncluded: Integer;
  tutorialSlugs:     array of String;
  error:             String;
};

action sendLastChanceEmailsAllDormant(
  dryRun : Boolean
) returns {
  authorsProcessed: Integer;
  emailsSent:       Integer;
  emailsFailed:     Integer;
  authorsSkipped:   Integer;
  errors:           array of String;
  preview:          array of {
    authorEmail:   String;
    tutorialCount: Integer;
    worstLevel:    Integer;
  };
};
```

Both implemented in [srv/admin-service.js](../../../srv/admin-service.js):

- **`sendLastChanceEmail(authorEmail, dryRun)`** — runs `computeStaleNotifications(knobs)` + `groupNotificationsByAuthor`, finds the digest matching `authorEmail` (case-insensitive). Returns `{success: false, error: "No stale tutorials found for that author"}` if no match. Otherwise builds the payload with `template: 'last-chance.html'`, calls `sendNotificationEmail` (skipped if `dryRun`), then `markNotificationSent` per tutorial on success. Returns the payload metadata regardless of `dryRun`.
- **`sendLastChanceEmailsAllDormant(dryRun)`** — applies the Q5 dormancy gate. Resolves `lastChanceMinLevel` and `lastChanceDormancyDays` from `ImsConfig`. An author qualifies if they have ≥1 tutorial where `notificationLevel >= lastChanceMinLevel` AND `lastNotificationDate < now() - lastChanceDormancyDays days`. On `dryRun=true`, returns the `preview[]` array of qualifying authors with their tutorial count and worst level — no sends, no state change. On `dryRun=false`, calls `sendLastChanceEmail(authorEmail, false)` per qualifying author serially (existing `FailedEmails` queue + 4-hour retry cron handle transport backpressure). Returns aggregate counts + per-author error strings.

New template: `srv/templates/notification/last-chance.html` (one file, no level variants — last-chance is a human-tone final notice). Variables: `${authorName}`, `${tutorialCount}`, `${tutorialPlural}`, `${tutorialListHtml}`, `${staleDaysThreshold}`, `${dashboardUrl}`.

### 6. Admin UI surface

Extend the existing Operations Fiori app at [app/admin/operations/](../../../app/admin/operations/) to add a "Last Chance Emails" section near the "Test Notification Email" tile:

- **Per-author send:**
  - Author dropdown populated from a new read-only `DormantAuthors` view exposing one row per author with ≥1 stale tutorial (`authorEmail`, `authorName`, `tutorialCount`, `worstLevel`, `oldestReviewedDate`).
  - "Preview (Dry Run)" button → invokes `sendLastChanceEmail(email, dryRun: true)` and renders the response payload (`recipientTo`, `recipientCc`, `tutorialSlugs`).
  - "Send Now" button → confirm dialog with the dry-run summary → invokes `sendLastChanceEmail(email, dryRun: false)`.
- **Bulk sweep:**
  - "Preview all qualifying authors" → invokes `sendLastChanceEmailsAllDormant(dryRun: true)`, renders the `preview[]` table.
  - "Send to all (N authors, M tutorials)" button (label includes counts from the preview) → confirm dialog with explicit text "*This will send to N authors, covering M tutorials. Continue?*" → invokes `sendLastChanceEmailsAllDormant(dryRun: false)`.

Audit-logged via existing `@cap-js/audit-logging` plumbing on `AdminService`. Each invocation writes a `SecurityEvent` capturing the admin's identity, the action name, the recipient(s), and dry-run flag.

### 7. New knobs in `resolveTimingKnobs()`

Three additions to the `TIMING_KNOBS` table in [srv/lib/contributor-notifications.js:7](../../../srv/lib/contributor-notifications.js#L7):

| `ImsConfig.key` | Type | Default | Purpose |
|---|---|---|---|
| `useDigestNotifications` | bool | `true` | Gates digest vs. legacy per-tutorial path |
| `lastChanceMinLevel` | int | `3` | Min `notificationNumber` for bulk-sweep inclusion |
| `lastChanceDormancyDays` | int | `60` | Days since `lastNotificationDate` for bulk-sweep inclusion |

The existing parser does `parseInt + Number.isFinite + > 0` — works for the existing 3 integer knobs. Adding a `type: 'int' | 'bool'` field on the table descriptors and branching the parser keeps it simple. Bool rows accept only `"true"`/`"false"` (case-insensitive); anything else WARNs and falls back to the default.

Three new rows in [db/data/com.sap.developers.ims-ImsConfig.csv](../../../db/data/com.sap.developers.ims-ImsConfig.csv) seed the defaults so PROD has predictable behavior on first boot. Existing IMS migration imports may overwrite these — that's fine, the values match what the code uses if the rows are absent.

## Data flow

```
WEEKLY MON 09:00 UTC  (existing cron; refactored body)
  scheduler.js cron fires
    runWithLock('contributor-notifications', 1800000, async (logId) => {
      if (!isNotificationsEnabled()) return { enabled: false }
      knobs        = resolveTimingKnobs()              // staleDays, resendIntervalDays, maxLevel
                                                       // + useDigest, lastChanceMinLevel, lastChanceDormancyDays
      adminEmails  = getAdminEmailList()
      notifications = computeStaleNotifications(knobs) // widened to include authorUserEmail + authorUserName
      dashboardUrl  = (await resolveDisplaySettings()).dashboardUrl

      if knobs.useDigest:
        digests = groupNotificationsByAuthor(notifications)
        for d in digests:
          if d.authorEmail == null:
            skipped++
            logJobItem(logId, SKIPPED, "no recipient resolvable")
            continue
          { to, cc } = determineRecipientsForDigest(d, adminEmails)
          result = sendNotificationEmail({
            to, cc,
            subject:  digestSubject(d),
            template: `digest-level-${d.worstLevel}`,    // base name; loadTemplate adds .html
            variables: { authorName, tutorialCount, tutorialPlural,
                         tutorialListHtml, staleDaysThreshold, dashboardUrl }
          })
            // resolveSmtpConfig() — credstore + env (#545)
            // on failure: queue to FailedEmails, 4-hour retry cron picks up
          if result.success:
            for t in d.tutorials: markNotificationSent(t.tutorialId)
            sent++
            logJobItem(logId, SUCCESS, `Digest sent to ${to.join(', ')} (${d.tutorials.length} tutorials)`)
          else:
            failed++
            logJobItem(logId, ERROR, result.error)
      else:
        // LEGACY per-tutorial path — verbatim from today's code
        for n in notifications: ...

EVERY 4 HOURS  (existing retry cron — unchanged)
  scheduler.js retry cron fires
    runWithLock('email-retry', 900000, retryFailedEmails)

ON DEMAND — per-author surgical send
  POST /admin/sendLastChanceEmail({authorEmail, dryRun})
    @requires: 'Admin'
    audit-log: { admin, action: 'sendLastChanceEmail', authorEmail, dryRun }

    knobs = resolveTimingKnobs()
    notifications = computeStaleNotifications(knobs)
    digests = groupNotificationsByAuthor(notifications)
    target = digests.find(d => d.authorEmail?.toLowerCase() === authorEmail.toLowerCase())

    if !target: return { success: false, error: 'No stale tutorials found for that author' }

    { to, cc } = determineRecipientsForDigest(target, adminEmails)
    payload = {
      to, cc,
      subject:  `Final notice: ${target.tutorials.length} ${plural} pending retirement`,
      template: 'last-chance',                          // base name; loadTemplate adds .html
      variables: { authorName, tutorialCount, tutorialPlural,
                   tutorialListHtml, staleDaysThreshold, dashboardUrl }
    }
    if dryRun:
      return { success: true, recipientTo: to[0], recipientCc: cc,
               tutorialsIncluded: target.tutorials.length,
               tutorialSlugs: target.tutorials.map(t => t.slug) }
    result = sendNotificationEmail(payload)
    if result.success:
      for t in target.tutorials: markNotificationSent(t.tutorialId)
    return { success, recipientTo, recipientCc, tutorialsIncluded, tutorialSlugs, error? }

ON DEMAND — bulk sweep
  POST /admin/sendLastChanceEmailsAllDormant({dryRun})
    @requires: 'Admin'
    audit-log: { admin, action: 'sendLastChanceEmailsAllDormant', dryRun }

    knobs = resolveTimingKnobs()
    notifications = computeStaleNotifications(knobs)
    digests = groupNotificationsByAuthor(notifications)
    dormancyCutoff = new Date(Date.now() - knobs.lastChanceDormancyDays * 86400000).toISOString()

    qualifying = digests.filter(d =>
      d.authorEmail != null
      && d.tutorials.some(t =>
           t.notificationLevel >= knobs.lastChanceMinLevel
           && t.lastNotificationDate
           && t.lastNotificationDate < dormancyCutoff
         )
    )

    if dryRun:
      return {
        authorsProcessed: qualifying.length,
        emailsSent: 0, emailsFailed: 0, authorsSkipped: 0,
        preview: qualifying.map(d => ({
          authorEmail:   d.authorEmail,
          tutorialCount: d.tutorials.length,
          worstLevel:    d.worstLevel
        }))
      }

    let sent=0, failed=0, errors=[]
    for d in qualifying:
      result = await sendLastChanceEmail(d.authorEmail, false)
      if result.success: sent++
      else: failed++; errors.push(`${d.authorEmail}: ${result.error}`)
    return { authorsProcessed: qualifying.length, emailsSent: sent,
             emailsFailed: failed, authorsSkipped: 0, errors, preview: undefined }
```

The `notificationLevel` in the digest's per-tutorial records reflects the **pre-cron** number. `markNotificationSent()` advances each tutorial's counter independently after the digest sends, so next cycle's grouping picks up the new levels.

## Error handling & edge cases

| # | Case | Behavior |
|---|---|---|
| 1 | Author has 1 tutorial in their digest (single-tutorial author) | Digest still sends. Template handles `${tutorialPlural}`. No fallback to per-tutorial template — single path, single behavior. |
| 2 | `Tutorials.author` FK points at `Users` row with null/empty `email` | `groupNotificationsByAuthor` treats empty email as FK miss, falls through to `TutorialContributors` (Q2 fallback). `authorSource = 'TutorialContributors'`. |
| 3 | Same author resolves via FK path for one tutorial AND via contributors for another, with different email casing | Group key is `email.toLowerCase()` — both converge to one digest. `authorSource` reflects whichever path resolved first in iteration order (used only for log breadcrumbs). |
| 4 | Tutorial has `author = null` AND no resolvable `TutorialContributors` row | Goes into `{ authorEmail: null }` bucket. Cron logs `SKIPPED` with `itemKey = tutorial.slug`, message `"no recipient resolvable (no author FK, no OWNER/AUTHOR contributor)"`. Re-evaluated next cycle. |
| 5 | `ImsConfig.useDigestNotifications = "yes"` (admin typo) | Bool parser: accepts only `"true"`/`"false"` (case-insensitive); anything else WARNs and falls back to default `true`. Typo doesn't kick back to legacy. |
| 6 | `markNotificationSent` UPDATE fails partway through a digest (3 of 5 advanced, then DB hiccup) | Each call is its own UPDATE — partial success recorded. Email already sent, user-facing state correct. Next cycle: 2 un-advanced tutorials re-included in new digest. Idempotent — worst case is a slightly-redundant email. |
| 7 | Digest send fails (SMTP error) after `computeStaleNotifications` succeeded | `sendNotificationEmail` returns `{success: false, error}`. **No `markNotificationSent` calls** — all tutorials in the digest stay at same level for next cycle. `FailedEmails` queue + 4-hour retry cron picks up. Retry path does NOT call `markNotificationSent` (existing behavior). |
| 8 | Two cron instances fire concurrently (CF horizontal scale) | Solved by existing `runWithLock('contributor-notifications', 1800000, ...)`. One instance runs body, other no-ops. |
| 9 | Admin presses "Send to all (47 authors)" by accident | Admin UI mandates: dry-run preview shown BEFORE confirm dialog. Confirm dialog quotes author count + tutorial count from dry-run result. Audit-log entry captures admin identity. No undo, but audit trail tells us who fired and when. |
| 10 | `sendLastChanceEmail(authorEmail)` for an author with no stale tutorials | Returns `{success: false, error: 'No stale tutorials found for that author'}`. No email, no state change. |
| 11 | Bulk sweep with `lastChanceMinLevel = 5` (admin typo, beyond max level of 3) | Filter `t.notificationLevel >= 5` matches nothing. `qualifying` empty. Returns `{authorsProcessed: 0}`. Self-correcting once admin fixes the knob. |
| 12 | Bulk sweep with `lastChanceDormancyDays = -10` (negative) | `resolveTimingKnobs` int parser guards `parsed > 0`. Negative → WARN + fallback to default 60. |
| 13 | Template references variable not in payload (e.g. missing `${tutorialPlural}`) | Existing `resolveTemplate()` substitutes empty string. Email renders with gap, goes out. Caught by Tests #6 + #7 below. |
| 14 | Author's email matches an admin email (Alice is also a sysadmin) | `determineRecipientsForDigest` dedupes — if `to` and `cc` both contain Alice after normalization, `cc` drops Alice. Mirrors today's `determineRecipients()`. |
| 15 | Author with 50+ stale tutorials in one digest | No hard cap. `<ul>` renders 50+ list items; SMTP/nodemailer/HTML rendering have no objection. Revisit if PROD surfaces an author with 100+ — out of scope until observed. |
| 16 | HDI redeploy wipes new `ImsConfig` rows | All 3 new knobs have hardcoded defaults in `TIMING_KNOBS`. Wipe → cron uses defaults (digest ON, minLevel=3, dormancy=60). CSV seed re-populates on next deploy. **No outage.** Per memory entry `feedback_hdi_deploys_can_wipe_data`. |
| 17 | Boot-time logging | `[contributor-notifications] digest mode: ON, lastChanceMinLevel=3, lastChanceDormancyDays=60` logged once on first cron fire of each cycle (not on boot — `resolveTimingKnobs()` is per-cycle). |
| 18 | Legacy `useDigestNotifications=false` path rots over time | Follow-up PR removes the flag + legacy branch after 2-3 successful PROD digest cycles. Intentional: digest becomes the new normal. |

## Testing

| # | Layer | File | What |
|---|---|---|---|
| 1 | Unit | `test/unit/group-notifications-by-author.test.js` (new) | 5 tutorials across 3 authors (one via FK, one via contributors, one unresolvable) → 3 digests + 1 `null`-keyed bucket. `worstLevel` = `max(notificationNumber)`. `worstReviewedDate` = `min(reviewedDate)`. |
| 2 | Unit | same | Case-insensitive grouping: FK email `Alice@Sap.com` and contributor email `alice@sap.com` → single digest with 2 tutorials. |
| 3 | Unit | same | FK path with empty/null `Users.email` falls through to `TutorialContributors`. |
| 4 | Unit | same | Tutorial with no FK and no OWNER/AUTHOR contributor → `null`-keyed bucket. |
| 5 | Unit | `test/unit/render-tutorial-list.test.js` (new) | `renderTutorialList(tutorials, dashboardUrl)` returns `<ul>` with one `<li>` per tutorial. HTML-escapes `<script>` and `&` in titles. URL-encodes slug in anchor `href`. Preserves dashboardUrl. |
| 6 | Unit | `test/unit/templates-notification.test.js` (existing — extend) | 4 new `digest-level-{0,1,2,3}.html` templates exist. Each contains at least one `${...}` placeholder. None contain literal "IMS Tutorial Dashboard", "Riley", "ninety days", or AEM-era docs URL. |
| 7 | Unit | same | New `last-chance.html` exists. Contains `${authorName}`, `${tutorialListHtml}`, `${tutorialCount}`, `${dashboardUrl}`, `${staleDaysThreshold}` placeholders. Same negative-string asserts. |
| 8 | Unit | `test/unit/resolve-timing-knobs-bool.test.js` (new) | `useDigestNotifications`: `"true"` → `true`, `"false"` → `false`, `"yes"` → default + WARN, missing row → default + no WARN. |
| 9 | Unit | `test/unit/determine-recipients-for-digest.test.js` (new) | Digest at `worstLevel=2`: `to` is owner only, `cc` is repo owner + admin emails (deduped). Multiple tutorials sharing same repo owner → single CC entry. Owner-email-also-in-admin-list → admin entry dropped from `cc`. |
| 10 | Unit | `test/unit/cron-digest-mode.test.js` (new) | `useDigest=true` with stubbed `sendNotificationEmail`: 3 tutorials for 2 authors → `sendNotificationEmail` called 2× with digest payloads; `markNotificationSent` called 3× (per tutorial). |
| 11 | Unit | same | `useDigest=false` with same fixture: `sendNotificationEmail` called 3× per-tutorial; `markNotificationSent` 3×. Legacy path unchanged. |
| 12 | Unit | same | Digest send failure → **zero** `markNotificationSent` calls for that digest. Other digests in same cycle process normally. |
| 13 | Unit | `test/unit/admin-last-chance-action.test.js` (new) | `sendLastChanceEmail(authorEmail, dryRun=true)`: returns shape with `recipientTo`, `recipientCc`, `tutorialsIncluded`, `tutorialSlugs`. Does NOT call `sendNotificationEmail` or `markNotificationSent`. |
| 14 | Unit | same | `sendLastChanceEmail(authorEmail, dryRun=false)`: calls `sendNotificationEmail` with `template: 'last-chance'`; calls `markNotificationSent` per tutorial on success. |
| 15 | Unit | same | `sendLastChanceEmail` for author with zero stale tutorials → `{success: false, error: 'No stale tutorials found for that author'}`. No side effects. |
| 16 | Unit | `test/unit/admin-bulk-last-chance.test.js` (new) | `sendLastChanceEmailsAllDormant(dryRun=true)`: filter applies BOTH `lastChanceMinLevel` AND `lastChanceDormancyDays`. Author with one L3-but-recent tutorial → not included. Author with one L3-and-old tutorial → included. Returns `preview[]`. |
| 17 | Unit | same | `sendLastChanceEmailsAllDormant(dryRun=false)`: calls `sendLastChanceEmail(authorEmail, false)` once per qualifying author. Aggregates `emailsSent`, `emailsFailed`, `errors[]`. |
| 18 | Unit | same | Bulk sweep with `lastChanceMinLevel=99`: returns `{authorsProcessed: 0}`, no calls. |
| 19 | Hybrid | `test/hybrid/digest-cron.test.js` (new) | Against real HANA via `cds bind --exec`: seed 3 `__TEST__` tutorials for one synthetic author; set `useDigestNotifications=true`; invoke `sendContributorNotifications` admin action; assert exactly 1 email queued (fake nodemailer transport that records sends). Cleanup in `afterAll`. Honors `ALLOW_HYBRID_WRITES=true` guard. |
| 20 | Hybrid | same | `sendLastChanceEmailsAllDormant(dryRun=true)` against real HANA: returns expected `preview[]`. Verifies the boolean-CASE-WHEN gotcha (per `hana-hdi-gotchas.md`) doesn't trip the dormancy filter. |
| 21 | Smoke | `test/smoke/admin-last-chance.smoke.test.js` (new) | Against deployed DEV srv: `POST /admin/sendLastChanceEmail({authorEmail: "nonexistent@sap.com", dryRun: true})` returns 200 with `{success: false, error: 'No stale tutorials found ...'}`. Verifies auth enforcement + action wiring without sending real email. |
| 22 | Manual | rotation runbook update | Update [docs/developers/operations/smtp-credentials-rotation.md](../../../docs/developers/operations/smtp-credentials-rotation.md) to mention the new admin actions exist. No procedural change — existing "Test Notification Email" verification step still validates SMTP for both per-tutorial and digest modes. |

**No real SMTP integration in CI.** Tests #19 + #20 inject a fake nodemailer transport via the existing `getTransporter()` injection point — no SMTP credentials needed.

## Risks & rollback

### Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Digest cron sends malformed email on first PROD run | Low | Medium | Pre-flight via existing `testNotificationEmail` action (#545). First Monday cycle after deploy: admin reads job log Tuesday morning. Roll back via `useDigestNotifications=false` if needed. |
| Author receives both digest AND per-tutorial in same cycle | Low | Low (cosmetic dup, no data corruption) | Knob is read once per cron body. Mid-week flip takes effect next Monday. Can't happen within a cycle. |
| `Tutorials.author` FK still null for chunk of legacy tutorials → grouping fragmentation | Medium | Low | Q2 fallback to `TutorialContributors` covers it. Per `feedback_tutorial_author_backfill_runs_after_user_migration`, `npm run migrate:authors` populates the FK. Recommend running it before deploy; not a hard dependency. |
| Bulk sweep against 100+ qualifying authors hits SMTP throttle | Low | Medium | Bulk sweep is serial. Per-send `FailedEmails` queue + 4-hour retry cron absorbs transport backpressure. Same backpressure model as weekly cron. |
| Dropping legacy code path in follow-up PR reintroduces noise if digest later disabled | Low | Low | Intentional. Follow-up PR removes flag + legacy branch — digest becomes the new normal. Rollback after that requires `git revert`. |
| Audit-log volume from bulk sweep | Low | Low | `@cap-js/audit-logging` is sized for admin volume already. 47 authors = 47 entries. Negligible. |

### Rollback

Three levels, cheapest first:

1. **Disable digest mode** (~1 min, no deploy): flip `ImsConfig.useDigestNotifications=false` via `/admin-ui/#operations-display`. Cron reverts to per-tutorial loop on next cycle.
2. **Disable all author-nudge mail** (existing #545 control): flip `ImsConfig.isNotificationSendingAllowed=false`. Cron exits cleanly on entry.
3. **`git revert` the PR**: removes all new code paths, templates, and admin actions. Returns to today's per-tutorial-only state. SMTP/credstore/retry queue all unaffected.

The new admin actions become non-functional if rolled back at any layer, but they are admin-only and explicit-action — no automation fires them.

## Open questions

None. All design questions resolved in Q1-Q6 + architectural wrap-vs-replace pick. Implementation-discretion items:

- **Tutorial-list rendering**: pre-rendered `${tutorialListHtml}` (recommended) vs. extending `resolveTemplate()` with iteration syntax. Implementer may override during build if a cleaner shape emerges, but pre-rendering keeps the diff smaller and the template engine untouched.
- **Subject-line wording**: digest subjects come from `digestSubject(d)` colocated in [srv/lib/contributor-notifications.js](../../../srv/lib/contributor-notifications.js) (§4 above). The last-chance subject is an inline string template in [srv/admin-service.js](../../../srv/admin-service.js). Both adjustable in a follow-up PR with no schema or template touch.

## Out of scope (follow-ups)

- **Team-lead-as-backup-contact** field on `Users` (Q6). File a separate issue, link from this spec.
- **Legacy per-tutorial code path removal** + `useDigestNotifications` knob removal. File after 2-3 successful PROD digest cycles.
- **Per-author opt-out** (author requests removal from automated nudges). Not in #622's ask.

## References

- [#622 — Need "one last chance" email blast capability](https://github.com/sap-tutorials/tutorials-ims/issues/622)
- [#545 — Author-nudge emails: investigate IMS legacy behavior + design CAP replacement](https://github.com/sap-tutorials/tutorials-ims/issues/545)
- [#385 — Tutorial author FK introduction](https://github.com/sap-tutorials/tutorials-ims/issues/385) — `Tutorials.author → Users` association used by Q2
- [#450 — `firstNotificationDate` first-nag-only stamping](https://github.com/sap-tutorials/tutorials-ims/pull/450)
- Prior spec: [docs/superpowers/specs/2026-06-23-author-nudge-emails-design.md](2026-06-23-author-nudge-emails-design.md) — credstore-fronted SMTP, knobs, templates (already shipped)
