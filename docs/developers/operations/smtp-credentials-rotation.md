# SMTP Credentials Rotation Runbook

The author-nudge cron in `tutorials-srv` sends mail via SMTP. Credentials follow
this split:

- **Non-secret:** `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_FROM` — env vars in
  the deploy mtaext, sourced from GitHub Actions secrets at deploy time via
  `envsubst`.
- **Secret:** `SMTP_PASS` — lives in BTP Credential Store, written via the
  admin Secrets UI, NEVER in mtaext or `cf set-env`.

The mail client at [srv/lib/mail-client.js](../../../srv/lib/mail-client.js)
reads `SMTP_PASS` from credstore via [srv/lib/credstore.js](../../../srv/lib/credstore.js)
on first send, caches the resolved password for 5 minutes, and falls through to
`process.env.SMTP_PASS` if credstore is unavailable. Pattern mirrors the
[GITHUB_DISPATCH_TOKEN rotation runbook](github-dispatch-pat-rotation.md).

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
| `535 Authentication failed` | Wrong password in credstore | Re-paste, ensure no trailing whitespace |
| `535` with the right password | Wrong username in `SMTP_USER` env | Update GitHub Actions secret + redeploy |
| `ECONNREFUSED` | Wrong relay host or port | Update `SMTP_HOST` / `SMTP_PORT` secret + redeploy |
| `550 sender rejected` | Wrong `SMTP_FROM`, not authorized to send as that address | Update `SMTP_FROM` secret + redeploy |
| `No mail transport configured` log | Credstore returned null AND env has no `SMTP_PASS` | Re-check step 2 |

Roll back by writing the OLD password to credstore via the same UI.

### 5. Once verified, ensure the cron is enabled

Open `/admin-ui/#operations-display`. Confirm `isNotificationSendingAllowed=true`
in the displayed ImsConfig values. If false, click the **Toggle Notifications**
control to enable. The next Monday-09:00-UTC cron will fire with real recipients.

### 6. Record the rotation

In `/admin-ui/#secrets-display`, edit the `SMTP_PASS` row's `lastRotatedAt` to
today's date.

## First-time cutover (when SMTP_PASS does not yet exist)

This is a one-time sequence for enabling author-nudge emails on a fresh deploy:

1. **GitHub repo settings → Secrets and variables → Actions → New repository secret** —
   add `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_FROM` with real values.
2. Trigger a new MTA deploy so the mtaext placeholders resolve through `envsubst`.
3. Follow Steps 2-5 above to write `SMTP_PASS` to credstore, verify with a test
   send, and flip the notification flag.

Until Step 1 is complete, the deploy will succeed with empty SMTP_* env vars
and the cron will exit cleanly via `getTransporter()` returning null — emails
queue to `FailedEmails` if the cron is somehow enabled before SMTP is wired.

## Disaster recovery — credstore is down

The mail-client falls through to `process.env.SMTP_PASS` if credstore throws.
If you absolutely must send mail during a credstore outage, `cf set-env
tutorials-srv SMTP_PASS <value> && cf restart tutorials-srv`. Remove the env var
once credstore is back: `cf unset-env tutorials-srv SMTP_PASS && cf restart`.
The credstore value resumes precedence within 5 minutes.

> **Caveat:** `cf set-env` values do NOT survive the next MTA redeploy. Use this only as a short-term emergency override.

## Related runbooks

- [GitHub Dispatch PAT rotation](github-dispatch-pat-rotation.md) — same credstore-first + env-fallback pattern for the GitHub workflow_dispatch token.
- [Spec: Author-nudge emails design](../../superpowers/specs/2026-06-23-author-nudge-emails-design.md) — full design rationale for #545.
