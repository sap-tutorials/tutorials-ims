# SMTP Credentials Rotation Runbook

The author-nudge cron in `tutorials-srv` sends mail via SMTP. As of the
credstore-runtime-config rollout, the mail client reads ALL 5 SMTP transport
fields — `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_FROM`, `SMTP_PASS` —
through the shared credstore-first resolver. The current credential split
during the transition is:

- **Preferred path:** All 5 fields in BTP Credential Store, written via the admin
  Secrets UI at `/admin-ui/#secrets-display`. The resolver checks credstore first;
  values propagate within 5 minutes (or immediately via the admin handler's
  `invalidateSecret()` hot-flush).
- **Env fallback (transitional):** `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_FROM`
  are still declared in `deploy/<env>.mtaext` and sourced from GitHub Actions
  secrets at deploy time via `envsubst`. These are the fallback if credstore
  returns null for a given alias. A follow-up PR will delete the mtaext entries
  once all environments have populated the credstore values (see "Cutover sequence"
  below).
- **Disaster recovery:** `cf set-env <var> <value>` overrides both, but does NOT
  survive the next MTA redeploy (a known Cloud Foundry behavior for env vars
  declared in the MTA descriptor).

The mail client at [srv/lib/mail-client.js](../../../srv/lib/mail-client.js)
reads all 5 fields via the shared
[secret-resolver](../../../srv/lib/secret-resolver.js): credstore-first,
process-env fallback, 5-min TTL cache, warn-once-per-window logging. A
rotation through the admin UI propagates within 5 minutes — no app
restart needed.

## When to rotate

- After a suspected leak.
- On the schedule the SMTP relay owner sets (today: `smtpauth.mail.net.sap` —
  rotation cadence TBD with SAP IT).
- After an SMTP authentication failure surfaces in `cf logs tutorials-srv --recent`
  or the admin Job Log.

## Steps

### 1. Issue or rotate the SMTP credential at the relay

For `smtpauth.mail.net.sap`: open a ticket with SAP IT. Capture the new password.

### 2. Write the new password to credstore

Open `/admin-ui/#secrets-display` in the deployed environment.

- If `SMTP_PASS` is in the list: select the row → "Update Value" → paste the new
  password → Save.
- If `SMTP_PASS` is NOT in the list: "Add Secret" → key `SMTP_PASS` → value (the
  new password) → description "SMTP password for author-nudge emails" →
  rotation owner (the relay owner contact) → Save.

The admin UI calls `writeSecret('SMTP_PASS', value)` against the credstore
service. The 5-minute TTL cache in `mail-client.js` means propagation is
automatic — no app restart needed.

### 3. Verify SMTP

Open `/admin-ui/#operations-display`. Click the **Test Notification Email**
button (or call the action directly):

```bash
curl -X POST "$BASE_URL/admin/testNotificationEmail" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"to": "your-address@sap.com", "level": 0}'
```

Expected response: `{"success": true, "error": ""}`. Check your inbox.

### 4. If the test send fails

Check `cf logs tutorials-srv --recent` for the SMTP authentication error.

Common causes:

| Symptom | Likely cause | Fix |
|---|---|---|
| `535 Authentication failed` | Wrong password in credstore | Re-paste `SMTP_PASS` in /admin-ui/#secrets-display |
| `535` with the right password | Wrong username | Update `SMTP_USER` row in /admin-ui/#secrets-display (preferred). Env-var fallback alternative: update GitHub Actions secret + redeploy. |
| `ECONNREFUSED` | Wrong relay host or port | Update `SMTP_HOST` / `SMTP_PORT` rows in /admin-ui/#secrets-display (preferred). Env-var fallback alternative: update GitHub Actions secret + redeploy. |
| `550 sender rejected` | Wrong `SMTP_FROM`, not authorized to send as that address | Update `SMTP_FROM` row in /admin-ui/#secrets-display (preferred). Env-var fallback alternative: update GitHub Actions secret + redeploy. |
| `No mail transport configured` log | All 5 fields null in both credstore AND env | Confirm /admin-ui/#secrets-display has values for SMTP_HOST + SMTP_PASS at minimum |

Roll back by writing the OLD value(s) to the same admin-UI row(s).

### 5. Once verified, ensure the cron is enabled

Open `/admin-ui/#operations-display`. Confirm `isNotificationSendingAllowed=true`
in the displayed ImsConfig values. If false, click the **Toggle Notifications**
control to enable. The next Monday-09:00-UTC cron will fire with real recipients.

### 6. Record the rotation

In `/admin-ui/#secrets-display`, edit the `SMTP_PASS` row's `lastRotatedAt` to
today's date.

## Cutover sequence (when SMTP_PASS does not yet exist on a fresh environment)

This is a one-time sequence for enabling author-nudge emails on a fresh deploy.
**Preferred path:** all 5 fields in credstore. **Transitional path:** still
supported via GitHub Actions secrets + mtaext until the mtaext entries are
deleted in a follow-up PR.

### Preferred path — all 5 fields in credstore

1. Confirm the seed-secrets script has populated the 5 metadata rows in the
   Secrets table for this environment. Run
   `npx cds bind --exec -- node scripts/seed-secrets.cjs --commit` if needed —
   the script is idempotent on `key` so re-running is safe.
2. Open `/admin-ui/#secrets-display` and paste real values into each of
   `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_FROM`, `SMTP_PASS`. The
   admin handler hot-flushes the resolver cache, so the next send picks up
   the new values immediately.
3. Verify with the "Test Notification Email" action (Step 3 above).
4. Flip the `isNotificationSendingAllowed` flag in `/admin-ui/#operations-display`.

### Transitional env-var path (still supported until follow-up PR)

1. **GitHub repo settings → Secrets and variables → Actions → New repository secret** —
   add `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_FROM` with real values.
2. Trigger a new MTA deploy so the mtaext placeholders resolve through `envsubst`.
3. Write `SMTP_PASS` to credstore via /admin-ui/#secrets-display.
4. Follow Steps 3-5 above to verify and enable.

Until either path is complete, the deploy will succeed with empty SMTP_* env
vars and the cron will exit cleanly via `getTransporter()` returning null —
emails queue to `FailedEmails` if the cron is somehow enabled before SMTP is
wired.

## Disaster recovery — credstore is down

The mail-client falls through to `process.env.SMTP_*` if credstore throws or
returns null for an alias. If you absolutely must send mail during a credstore
outage:

```bash
cf set-env tutorials-srv SMTP_HOST <value>
cf set-env tutorials-srv SMTP_PORT <value>
cf set-env tutorials-srv SMTP_USER <value>
cf set-env tutorials-srv SMTP_FROM <value>
cf set-env tutorials-srv SMTP_PASS <value>
cf restart tutorials-srv
```

Once credstore is back, remove the overrides:

```bash
cf unset-env tutorials-srv SMTP_HOST
# ... repeat for the other 4 fields
cf restart tutorials-srv
```

The credstore values resume precedence within 5 minutes.

> **Caveat:** `cf set-env` values do NOT survive the next MTA redeploy. Use
> only as a short-term emergency override.

## Related runbooks

- [GitHub Dispatch PAT rotation](github-dispatch-pat-rotation.md) — same credstore-first + env-fallback pattern for the GitHub workflow_dispatch token.
- [Spec: Author-nudge emails design](../../superpowers/specs/2026-06-23-author-nudge-emails-design.md) — full design rationale for #545.
