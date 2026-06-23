# Author-Nudge Emails — Credstore-Fronted SMTP for CAP tutorials-srv

**Status:** Approved (Tom, 2026-06-23). Ready for implementation plan.
**Tracks:** [#545 — Author-nudge emails: investigate IMS legacy behavior + design CAP replacement](https://github.com/sap-tutorials/tutorials-ims/issues/545)
**Companion (out of scope here):** rotation of the legacy IMS SMTP credentials per the security finding in #545 comment 2. Separate ticket.

## Background

IMS Java shipped a daily author-nudge cron (4 escalating emails over ~6 months for tutorials not reviewed in 180+ days). Investigation in #545:

- IMS PROD wires SMTP via `cf set-env` (`SPRING_MAIL_*`) — plaintext, visible to any SpaceDeveloper.
- The new CAP `tutorials-srv` has the code path **already migrated**: [srv/lib/mail-client.js](../../../srv/lib/mail-client.js), [srv/lib/contributor-notifications.js](../../../srv/lib/contributor-notifications.js), the cron at [srv/jobs/scheduler.js:142](../../../srv/jobs/scheduler.js#L142), 4 HTML templates, a `FailedEmails` retry queue, and a 4-hour retry cron at [srv/jobs/scheduler.js:196](../../../srv/jobs/scheduler.js#L196) (the `900000` value at line 197 is the lock TTL — 15 min — not the cron interval). All dormant — no SMTP transport configured.
- The new platform shipped Phase 2-C credstore (#465) in [srv/lib/credstore.js](../../../srv/lib/credstore.js) with admin Secrets UI at `/admin-ui/#secrets-display`. The established pattern for secret resolution is in [srv/lib/rebuild-trigger.js:60-86](../../../srv/lib/rebuild-trigger.js#L60-L86): credstore-first → env fallback → 5-min TTL cache → WARN-on-miss → log-status-on-boot.

This design uses that established pattern verbatim for SMTP.

## Goal

Make the author-nudge cron deliver mail in PROD, with the SMTP password sourced from credstore (not plain `cf env`), the timing knobs admin-tunable via `ImsConfig` rather than hardcoded, and the templates free of the IMS-era rot (Riley's signature, "ninety days" hardcoded in prose, AEM-era docs URLs).

The deploy ships with `isNotificationSendingAllowed=false`. The cron runs but exits cleanly until manually flipped via the admin UI after a verified test send.

## Non-goals

- Replacing the cron or the escalation ladder (level 0 → owner; 1 → +repoOwner cc; 2 → +adminEmails cc; 3 → admins-only). Behavior continues as already coded.
- Per-author personalization (`${authorName}` greetings, etc.). Template variables stay generic.
- A dry-run mode that routes all emails to a test address. The new `POST /admin/testNotificationEmail` action below covers the "is SMTP working?" check.
- Rotating the legacy IMS SMTP credentials. Separate ticket (security finding from #545).
- GitHub-issue-based nudges (Option C in #545). Email path stays; GitHub alternative is a future-work decision.

## Architecture

Three independent pieces; each can ship and roll back independently:

### 1. Credstore-fronted SMTP transport

Add a private `resolveSmtpConfig()` helper to [srv/lib/mail-client.js](../../../srv/lib/mail-client.js). It implements the same shape as [srv/lib/rebuild-trigger.js:60-86](../../../srv/lib/rebuild-trigger.js#L60-L86):

```
resolveSmtpConfig():
  if cache fresh (within 5 min): return cached config
  password = null
  try: password = await credstore.readSecret('SMTP_PASS')
  catch (err): WARN-once-per-window
  if !password: password = process.env.SMTP_PASS ?? null
  config = {
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT) || 1025,
    user: process.env.SMTP_USER,
    pass: password,
    from: process.env.SMTP_FROM ?? 'developers@sap.com'
  }
  if config.host && config.pass: cache config, return
  return null  // caller queues to FailedEmails
```

`getTransporter()` calls `resolveSmtpConfig()`, builds the nodemailer transport from its return shape, and caches the transporter alongside the config (same TTL window — 5 minutes). The existing Tier-2 path (xsenv `mail`-tagged binding) stays as a final fallback when both credstore and direct env lookups miss; we don't expect to use it but it's an escape hatch if a managed mail service ever appears.

Non-secret knobs (`SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_FROM`) ship as plain env vars via mtaext, same path as `${CONTENT_API_KEY}`. The secret (`SMTP_PASS`) lives only in credstore, written via `/admin-ui/#secrets-display`.

> **Why one resolver, not three tiers:** the only credential that varies between "production" and "local dev" is where the password comes from. Host/port/user/from are env vars in every environment. Modeling it as "credstore-first password resolution + env-driven config" matches reality with less indirection.

### 2. Config-driven cron tuning

Three hardcoded constants in [srv/lib/contributor-notifications.js](../../../srv/lib/contributor-notifications.js) become `ImsConfig` reads:

| Constant | Default | `ImsConfig.key` |
|---|---|---|
| `STALE_DAYS_DEFAULT` | 90 | `staleDaysThreshold` |
| `RESEND_INTERVAL_DAYS` | 30 | `resendIntervalDays` |
| `MAX_NOTIFICATION_LEVEL` | 3 | `maxNotificationLevel` |

A new `getNotificationConfig()` helper does `SELECT.one.from(ImsConfig).where({ key: ... })` for each, runs `parseInt(value, 10)` + `Number.isFinite` guards, falls back to the hardcoded constant on missing/invalid rows, and logs a WARN with the bad value when it falls back. Returns a `{ staleDays, resendIntervalDays, maxLevel }` object.

`computeStaleNotifications()` accepts the same arguments (deconstructed) instead of the single `staleDaysThreshold` it accepts today. The cron at [scheduler.js:149](../../../srv/jobs/scheduler.js#L149) calls `getNotificationConfig()` once and passes the result.

The cron pattern (`'0 9 * * 1'`) and the escalation ladder (in `determineRecipients`) stay hardcoded. Cron strings stored in DB and parsed at boot are operationally fragile (one typo crashes the scheduler); the escalation ladder has not changed since IMS inception.

Three new rows in [db/data/com.sap.developers.ims-ImsConfig.csv](../../../db/data/com.sap.developers.ims-ImsConfig.csv) seed the defaults so PROD has predictable behavior on first boot. Existing IMS migration imports may overwrite these — that's fine, the values match what code uses if the rows are absent.

### 3. Light-touch template content cleanup

Each of [srv/templates/notification/{first,second,third,final}.html](../../../srv/templates/notification/) gets:

- "**ninety days**" → `${staleDaysThreshold} days`
- "**IMS** Tutorial Dashboard" → "Tutorial Dashboard"
- Riley's signature block → "SAP Developers Tutorials Team"
- AEM-era URL `https://developers.sap.com/tutorials/docs-tutorial-2a-updating-tutorialv2.html` → the current authoring guide URL, or dropped entirely if no clean equivalent (TBD during implementation; the implementer can `gh search code` for the canonical authoring docs and substitute, OR replace the link with prose like "follow the authoring process in your tutorial's GitHub repository").
- Tutorial title in body prose (not just subject): use `${tutorialTitle}`
- Last-reviewed date prose: use `${lastReviewedDate}` so the recipient can see how out-of-date the tutorial is without checking the dashboard

The scheduler's `variables` payload widens accordingly. Existing `resolveTemplate()` at [mail-client.js:49](../../../srv/lib/mail-client.js#L49) returns empty strings for missing variables — safe by construction.

### 4. New admin action: `testNotificationEmail`

A new `@requires: 'Admin'` action in [srv/admin-service.cds](../../../srv/admin-service.cds):

```cds
action testNotificationEmail(to: String, level: Integer) returns {
  success: Boolean;
  error: String;
};
```

Implemented in [srv/admin-service.js](../../../srv/admin-service.js): calls `sendNotificationEmail({ to, cc: [], subject: 'Test from CAP tutorials-srv', level, variables: { dashboardUrl, tutorialTitle: 'Test Tutorial', staleDaysThreshold: 90, lastReviewedDate: new Date().toISOString().slice(0, 10) }})` and returns the result. Surfaced as a button in `/admin-ui/#operations-display` next to the existing Job Log controls.

This is the operational gate before flipping `isNotificationSendingAllowed=true` in PROD.

> **Relation to existing admin actions:** [srv/admin-service.cds](../../../srv/admin-service.cds) already exposes `action sendContributorNotifications()` (fires the full cron body on-demand, processes every stale tutorial) and `action toggleNotifications(enabled: Boolean)` (flips the `isNotificationSendingAllowed` flag in `ImsConfig`). Those stay. The new `testNotificationEmail` action is deliberately narrower — a single-recipient SMTP transport check with a synthetic payload — so we can verify "credstore + nodemailer + relay" work in isolation before letting `sendContributorNotifications` loose on the real tutorial backlog.

## Data flow

```
BOOT (no-op until first cron or admin action)

WEEKLY MON 09:00 UTC
  scheduler.js cron fires
    runWithLock('contributor-notifications', 1800000, ...)
      isNotificationsEnabled()  →  if false: log INFO + return
      getNotificationConfig()
        ImsConfig.staleDaysThreshold | resendIntervalDays | maxNotificationLevel
        parseInt + Number.isFinite guards; hardcoded fallbacks
      getAdminEmailList()  (existing — reads ImsConfig.emailListForOutdated)
      computeStaleNotifications(staleDays, resendIntervalDays, maxLevel)
      for each notification:
        determineRecipients(n, adminEmails)  →  { to, cc }
        sendNotificationEmail({
          to, cc, subject: n.title, level: n.notificationLevel,
          variables: {
            dashboardUrl,                          // existing
            tutorialTitle: n.title,                // new
            staleDaysThreshold: staleDays,         // new
            lastReviewedDate: n.reviewedDate       // new
          }
        })
          getTransporter()
            resolveSmtpConfig()
              cache check (5-min TTL)
              credstore.readSecret('SMTP_PASS')   ← Phase 2-C path
              env fallback if credstore miss
              returns { host, port, user, pass, from }
            createTransport(config), cache transporter
          transport.sendMail(mailOptions)
          on success: log INFO, return { success: true }
          on failure: INSERT into FailedEmails, log ERROR, return { success: false, error }
        markNotificationSent(tutorialId)  (existing)
        logJobItem(... SUCCESS|ERROR ...)  (existing)

EVERY 4 HOURS
  scheduler.js retry cron fires
    runWithLock('email-retry', 900000, retryFailedEmails)
      SELECT pending FROM FailedEmails
      for each: getTransporter().sendMail() with same retry-count + max-retries logic as today

ON DEMAND (admin)
  POST /admin/testNotificationEmail({to: "tom@sap.com", level: 0})
    sendNotificationEmail({...}) with hardcoded test payload
    returns { success, error? }
```

## Error handling & edge cases

| # | Case | Behavior |
|---|---|---|
| 1 | Credstore unreachable at first send | `resolveSmtpConfig()` logs WARN, falls through to `process.env.SMTP_PASS`. If env also unset → `getTransporter()` returns `null` → `sendNotificationEmail` queues to `FailedEmails` → 4-hour retry cron picks it up. No emails lost. |
| 2 | Wrong SMTP password in credstore | `nodemailer.sendMail()` throws 535 auth-failure. Caught by `sendNotificationEmail`'s catch, queued to `FailedEmails`, surfaces in admin's Job Log as ERROR with `errorMessage`. The 5-min TTL cache means a `writeSecret` correction takes effect within 5 min. |
| 3 | `ImsConfig` row missing for a knob | `getNotificationConfig()` `SELECT.one` returns `undefined`; parseInt guard fails; WARN logs the missing key and the fallback used; the hardcoded constant applies. Cron still runs. |
| 4 | `ImsConfig.staleDaysThreshold = "foo"` (admin typo) | Same fallback as #3. WARN includes the bad value for debugging. |
| 5 | Template references variable not in payload (e.g. `${authorName}`) | Existing `resolveTemplate()` renders empty string. Visible-but-not-broken. |
| 6 | Email delivered but `markNotificationSent` UPDATE fails | Tutorial gets re-nagged next week. Idempotency by design — `markNotificationSent` increments `notificationNumber` AND sets `lastNotificationDate`; the `resendCutoff` filter keeps duplicates rare. |
| 7 | Multiple `tutorials-srv` instances fire the cron concurrently (CF horizontal scale) | Already solved: [srv/jobs/scheduler.js:19](../../../srv/jobs/scheduler.js#L19) `runWithLock('contributor-notifications', 1800000, ...)` wraps [srv/jobs/job-lock.js](../../../srv/jobs/job-lock.js)'s `acquireLock`/`releaseLock` primitives. Only one instance ever runs the body. |
| 8 | Boot in a fresh local dev tree (no credstore binding) | `getServices({credstore})` throws inside `credstore.js`'s `getBinding()`. `resolveSmtpConfig()` catches, WARNs once, falls through to env. Local dev still works with `SMTP_HOST=localhost SMTP_PORT=1025` (e.g. MailHog). |
| 9 | Successful test send via `testNotificationEmail` while flag is still false | The admin action calls `sendNotificationEmail` directly, NOT through the cron. The flag gates the **cron**, not the underlying client. So the test send works regardless of the flag. |
| 10 | Boot-time logging | `mail-client.js` logs `[mail] credstore-resolved SMTP password (host=<host>, user=<user>)` on first successful resolve OR `[mail] no SMTP password configured (credstore + env both empty)` on full miss. Mirrors `rebuild-trigger.js`'s boot-time log message. |

## Testing

| # | Layer | File | What |
|---|---|---|---|
| 1 | Unit | `test/mail-client-credstore.test.js` (new) | Credstore returns "from-credstore", env has "from-env" → transport uses "from-credstore" (credstore wins). |
| 2 | Unit | same | Credstore throws → falls through to env, WARN logged. |
| 3 | Unit | same | Both empty → `getTransporter()` returns null, queue path engages. |
| 4 | Unit | same | 5-min TTL cache: two successive `getTransporter()` invoke `readSecret` exactly once. |
| 5 | Unit | `test/notification-config.test.js` (new) | Seed 3 `ImsConfig` rows (valid + invalid + missing); assert returned values + WARN logs for invalid/missing. |
| 6 | Unit | extend existing scheduler test if present; else inline | Cron body invocation with stubbed `sendNotificationEmail` spy; assert `variables` payload includes `tutorialTitle`, `staleDaysThreshold`, `lastReviewedDate`. |
| 7 | Unit | `test/templates-notification.test.js` (new) | Read all 4 HTML templates as source strings; assert each contains at least one `${...}` placeholder; assert NONE contain literal strings "ninety days", "IMS Tutorial Dashboard", "Riley", or the AEM-era docs URL. |
| 8 | Hybrid | `test/hybrid/credstore-smtp.test.js` (new) | Write dummy `SMTP_PASS` to credstore, read back, assert plaintext match, delete. Verifies the secret pipeline end-to-end against real BTP. |
| 9 | Manual smoke | rotation runbook (see below) | `/admin-ui/#secrets-display` write → `POST /admin/testNotificationEmail` → observe delivery → flip `isNotificationSendingAllowed=true`. |

No SMTP integration test against a real relay. Test #8 verifies credstore I/O; test #9 verifies actual SMTP delivery. Combining them in a single CI test would require real SMTP credentials in CI, which we explicitly want to avoid.

## Rotation runbook (new doc: `docs/developers/operations/smtp-credentials-rotation.md`)

Step-by-step:

1. **Issue or rotate the SMTP credential** at the SMTP relay owner (today: SAP IT for `smtpauth.mail.net.sap`). Capture the new password.
2. **Write the new password to credstore** via `/admin-ui/#secrets-display` → "SMTP_PASS" row → "Update Value" → paste new password → Save. The admin UI calls `writeSecret('SMTP_PASS', value)`. 5-minute TTL cache means propagation is automatic.
3. **Verify SMTP** via `/admin-ui/#operations-display` → "Test Notification Email" button → enter your address + level 0 → Send. Check inbox.
4. **If verified:** ensure `isNotificationSendingAllowed=true` in `ImsConfig` (only needs to be done once at first cutover; subsequent rotations don't change the flag).
5. **If failed:** check `cf logs tutorials-srv --recent` for the auth error. Common causes: wrong password (re-paste), wrong username in `SMTP_USER` (`cf set-env`), wrong relay in `SMTP_HOST`. Roll back by writing the OLD password back to credstore via the same UI.
6. **Record the rotation** in the `Secrets` table (admin UI) — update `lastRotatedAt` field.

The runbook is part of this PR; the rotation **action** isn't required for this PR (today's value is whatever Tom writes at cutover; there's no need to rotate immediately).

## Risks & rollback

- **Rollback:** single `git revert` of the merged PR. Code reverts to dormant state (no transport). The flag stays at whatever it was. SMTP_PASS in credstore is harmless when unused.
- **Cron firing with malformed `ImsConfig`** — defensive parsing protects against this (WARN + fallback to default).
- **Credstore outage during cron fire** — `FailedEmails` queue + retry cron absorbs the gap.
- **Test-send action accidentally exposed to non-admins** — `@requires: 'Admin'` on the action; defense-in-depth via approuter scope check. Same security posture as every other admin action.
- **Wrong `from:` address gets the relay's "not authorized" rejection** — admins see the error in Job Log and roll back by setting `SMTP_FROM` back to the previous value (env var, no rotation runbook needed).
- **HDI redeploy wipes `ImsConfig` rows** — see memory entry [`feedback_hdi_deploys_can_wipe_data`](../../../C:\Users\I809764\.claude\projects\d--projects-tutorials-poc\memory\feedback_hdi_deploys_can_wipe_data.md). Mitigation: the three knobs all have hardcoded defaults, so wipe → cron uses defaults. **No outage.** The CSV seed in this PR populates the rows on next HDI deploy, restoring admin-tuned values to defaults — which is correct behavior (admin can re-tune).

## Open questions

None. All five brainstorming questions resolved with Tom on 2026-06-23:

1. Scope: C (wire-up + cron + template content)
2. Cron: C (config-driven via `ImsConfig`)
3. Knobs: A (3 timing knobs only; cron pattern + escalation ladder stay hardcoded)
4. Templates: A (light touch — fix the rot, parameterize numbers, generalize signature)
5. Flag flip: A (manual via admin UI after verified test send)
