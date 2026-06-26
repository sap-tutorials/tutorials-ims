# Scheduling site-wide alerts

Site-wide alerts surface on the **notification bell** in the page header. Use them
for things like product launches, Devtoberfest kickoff, scheduled outages, or
"please rebuild your tutorial cache" notes for authors.

## Where to author

`/admin-ui/#alerts` (Admin role required).

## Fields

- **Title** — short headline (≤200 chars).
- **Body** — optional one-paragraph context (≤2000 chars; plain text only).
- **Severity** — Information / Success / Warning / Error. Drives the bell badge color.
- **Audience** — `ALL` (everyone), `AUTHENTICATED` (logged-in only), `ADMIN` (admins only).
- **Start (UTC)** / **End (UTC)** — visibility window. Leave **End** blank for ad-hoc
  ("on until I turn it off") alerts.
- **CTA label / URL** — optional. URL suggestions are scoped to in-app routes; free
  text is accepted for external URLs.
- **Dismissible** — when on, visitors can close the notification (stored per-device).
- **On** — kill switch. Set to off to instantly hide without editing the schedule.

## Timing

- Alerts are runtime-served and **do not trigger a Hugo rebuild**.
- Visitors see your change within ~60 seconds of save (server cache TTL).
- For instant testing, hit `/api/alerts` (or `/api/alerts/me` while logged in)
  with `curl` after saving.

## Dismissals

- Per-device only — dismissed in browser A means the visitor still sees it in browser B.
- Dismissals are NOT garbage-collected; if you re-purpose an alert title, give it
  a new row (and let the old one expire) rather than editing in place.
