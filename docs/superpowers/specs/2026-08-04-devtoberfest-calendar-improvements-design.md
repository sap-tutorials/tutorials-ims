# Devtoberfest Calendar Improvements — Design

**Date:** 2026-08-04
**Route:** `/devtoberfest/calendar/`
**Status:** Approved design; awaiting spec review before writing implementation plan.

## Summary

Four improvements to the Devtoberfest session calendar (a Vue island served by
Hugo, fed by a custom Express route over cross-container HANA facades of the
Devtoberfest Planner):

1. **Track colors from the planner** — the calendar's track colors currently come
   from a client-side alphabetical-hash palette. They should instead honor the
   admin-configured `color` (and `emoji`) on each planner Track.
2. **YouTube thumbnails in the day view** — day-view session rows should show the
   video thumbnail.
3. **Richer session detail panel** — YouTube thumbnail, speaker info (photo, name,
   role/company), session LinkedIn link, an inline embedded player (keeping the
   "Watch on YouTube" link), an enlarge/expand toggle, and a transcript.
4. **Transcript** — pull captions from YouTube (uploaded first, auto-generated as
   fallback), cache in HANA, render as a clickable, seekable transcript in the
   enlarged panel.

All three **slices land on one branch and are verified locally before any DEV
deploy** (per Tom).

## Current architecture (as-is)

```
/devtoberfest/calendar/ (hugo/content/devtoberfest/calendar/_index.md)
  → hugo/layouts/devtoberfest/calendar.html   (mounts #devtoberfest-sessions-calendar-mount,
                                                loads /js/devtoberfest-sessions-calendar.js)
    → hugo-apps/src/devtoberfest-sessions-calendar/main.ts → App.vue
        views: MonthGrid.vue, WeekAgenda.vue, DayAgenda.vue
        detail: devtoberfest-schedule-shared/DetailPanel.vue
        helpers: calendar-core.ts, track-colors.ts,
                 devtoberfest-schedule-shared/{feed.ts,types.ts,completion.ts,
                 youtube.ts,format-session-time.ts}
      → GET /api/devtoberfest/schedule?edition=<id>   (feed.ts → fetchFeed)
      → GET /api/devtoberfest/my-completions?edition=<id>
        → srv/routes/devtoberfest-schedule.js (registered srv/server.js:390)
          reads external.devtoberfest facades: Edition, Track, Session, Activity
          → srv/lib/devtoberfest-feed.js assembleFeed() shapes camelCase JSON
```

Facades (`db/external/devtoberfest.cds`, namespace `external.devtoberfest`) are
read-only `@cds.persistence.exists` proxies over the planner's `DTF_*_V1` HANA
views (`devtoberfest-planner-db`), wired by `db/src/EXTERNAL_DEVTOBERFEST_*.hdbsynonym`
+ `devtoberfest-grants.hdbgrants`.

### Key gaps found in the as-is model

- **Track facade has no `COLOR`/`EMOJI`** — planner `Track.color`/`Track.emoji`
  exist in `db/schema.cds` (enums `TrackColor`: Green/Orange/Yellow/Blue/Red/Purple;
  `TrackEmoji`: matching glyphs) but are **not exposed** in `DTF_TRACK_V1.hdbview`.
- **`assembleFeed` never joins speakers** and never maps `Session.LINKEDINURL`.
- **Speaker photo is a BLOB** (`PHOTO` + `PHOTOTYPE` on planner Speaker; exposed in
  `DTF_SPEAKER_V1.hdbview` and the tutorials-ims Speaker facade). Not a URL.
- **LinkedIn is on the Session, not the Speaker** — `Session.linkedinURL`
  (`@Core.IsURL`), already present in the facade Session entity, dropped in the feed.
- `track-colors.ts` assigns `PALETTE[i % 8]` by alphabetical track order — no data input.
- `youtube.ts` has only `youtubeId(url)`. `youtubeThumb(url)` lives in `completion.ts`.
  **No embed-URL helper exists.**

## Decisions (locked)

| Topic | Decision |
|---|---|
| Transcript source | Uploaded captions first; **fall back to auto-generated** (timedtext `kind=asr`) when none — livestreams have only auto. |
| Transcript fetch timing | **On-demand (lazy) + cache** in HANA. First viewer triggers fetch; negative results cached with short TTL. |
| Transcript interactivity | **Clickable timestamps** seek the embedded player (YouTube IFrame Player API). |
| Speaker photo serving | **Dedicated streaming endpoint**; feed carries only `photoUrl`. |
| LinkedIn | **Use `Session.linkedinURL` as-is** — no schema change. |
| Thumbnail scope | **Day view only.** Week/month stay as colored chips. |
| Enlarged panel layout | **Single-column, just wider** (not two-column). |
| Emoji | Pull `emoji` through alongside `color`. |
| Deploy gating | **All three slices complete + locally verified before DEV deploy.** |

## Slice 1 — Session detail + day thumbnails (no planner dependency; ships first)

### Backend

`srv/lib/devtoberfest-feed.js` — extend `assembleFeed({...})`:
- Accept `sessionSpeakers` + `speakers` inputs; build `speakerById` and
  `speakersBySession` maps. Per session, attach `speakers: [{ id, name, role,
  company, photoUrl }]` sorted by `speakerOrder`. `name` = `FIRSTNAME + ' ' +
  LASTNAME` (trimmed). `photoUrl` = `/api/devtoberfest/speaker/<id>/photo`.
- Map `Session.LINKEDINURL` → `linkedinUrl`.

`srv/routes/devtoberfest-schedule.js`:
- In `scheduleHandler`, after loading tracks/sessions/activities, also query
  `ext.Sessionspeaker` (for the edition's session IDs) and `ext.Speaker` (for the
  referenced speaker IDs). Pass both to `assembleFeed`. Fail-soft consistent with
  the existing `503 EVENT_NOT_CONFIGURED` path.
- **New route** `GET /api/devtoberfest/speaker/:id/photo` (anonymous):
  - Raw `db.run()` to read `PHOTO`, `PHOTOTYPE` for the id (per the "never SELECT a
    HANA BLOB alongside metadata via CDS QL" gotcha — use raw SQL, BLOB isolated).
  - Respond with the BLOB, `Content-Type: <PHOTOTYPE or image/jpeg>`,
    `Cache-Control: public, max-age=86400`. 404 when absent/empty.

### Types

`devtoberfest-schedule-shared/types.ts`:
- New `Speaker` interface: `{ id: string; name: string; role?: string;
  company?: string; photoUrl?: string }`.
- `Session` gains `speakers?: Speaker[]`, `linkedinUrl?: string`,
  `trackColor?: string`, `trackEmoji?: string` (color/emoji populated by slice 2).

### YouTube helpers

`devtoberfest-schedule-shared/youtube.ts` — add `youtubeEmbedUrl(url)` →
`https://www.youtube-nocookie.com/embed/<id>` (returns `''` when no id). Keep
`youtubeId`. `youtubeThumb` stays in `completion.ts` (already consumed).

### DetailPanel.vue

- **Speaker block** (new): for each `row.speakers`, a row with a circular photo
  (`<img :src="photoUrl" loading="lazy">`, `onerror` → collapse to initials
  avatar), name, and `role @ company` when present. No speakers → block hidden.
- **Inline embed** (replaces static thumbnail-as-link when `youtubeUrl` present):
  responsive 16:9 `<iframe :src="youtubeEmbedUrl(row.youtubeUrl)"
  allow="...; encrypted-media" allowfullscreen>`. Keep "Watch on YouTube" link
  below. No `youtubeUrl` → no player (thumbnail may still show for context).
- **LinkedIn link**: in the links section when `row.linkedinUrl` present, via
  existing `safeHref`.
- **Enlarge toggle**: header button toggles `expanded`. Default width ~380px ⇄
  wide (~70vw). Single-column stacked at both sizes; wide just enlarges the video
  and gives the transcript room. `expanded` persisted in component state for the
  session (sessionStorage).

### DayAgenda.vue

- Each session row with `youtubeUrl` shows a small ~16:9 thumbnail
  (`youtubeThumb`) left of the title, `loading="lazy"`, `onerror` collapse.
  No `youtubeUrl` → unchanged. Week/month unchanged.

### CSP

Verify approuter CSP `frame-src` allows `https://www.youtube-nocookie.com`
(outbound embed direction — distinct from the recent `frame-ancestors` work). Add
if missing. Sync both `xs-security.json` copies if the change touches them.

## Slice 2 — Track colors + emoji from the planner (planner-repo lockstep)

**Ordering is load-bearing:** planner view republish + deploy MUST precede the
tutorials-ims facade change, or the facade references a column that doesn't exist
and srv boot crashes at MTA deploy.

1. **Planner repo** (`D:\projects\devtoberfest-planner`):
   - `db/src/DTF_TRACK_V1.hdbview` — add `COLOR` and `EMOJI` columns from
     `DEVTOBERFEST_TRACK` (hand-authored view; SQLite tests + `cds build` won't
     catch a mismatch — per the planner hdbview gotcha). Identifiers UPPERCASE.
   - Deploy planner DB so the cross-container view updates.
2. **tutorials-ims facade** (`db/external/devtoberfest.cds`): add `COLOR : String(16)`
   and `EMOJI : String(8)` to the `Track` entity (mirror the view exactly).
3. **Feed** (`assembleFeed`): track mapping carries `color`/`emoji`; each session
   gets `trackColor` (enum name e.g. `'Blue'`) + `trackEmoji`. Also expose in any
   tracks list used for the legend.
4. **Island** (`track-colors.ts`): add a **name→palette map** (`Blue`→blue swatch,
   `Green`→green, `Orange`→orange, `Yellow`→gold, `Red`→red, `Purple`→purple).
   `buildTrackColorMap` prefers the per-track `color` enum when present; **falls
   back to the existing alphabetical-hash palette** for tracks with no color set.
   Legend reflects resolved colors.
5. `npx cds deploy --to sqlite::memory:` before committing the facade `.cds` change.

## Slice 3 — Transcript (self-contained; new table + endpoint)

### New table

`DevtoberfestTranscript` (tutorials-ims db — derived data we own, NOT the planner):
- `videoId : String(20)` (key)
- `source : String(10)` — `uploaded` | `auto` | `none`
- `lang : String(10)`
- `segments : LargeBinary` — gzip of `[{ start: number, text: string }]`
  (follows the existing content-store gzip-BLOB pattern)
- `fetchedAt : Timestamp`

Run `npx cds deploy --to sqlite::memory:` before committing the `.cds`.
`cds build --production` for `db/last-dev/` after the schema change.

### Endpoint

`GET /api/devtoberfest/transcript?video=<id>` (anonymous):
1. Cache lookup by `videoId`. Fresh + `source !== 'none'` → return segments. Fresh
   `none` (short TTL) → return empty. This cache is the resilience mechanism: a
   timedtext break stops *new* fetches, not existing transcripts.
2. Fetch behind a small adapter module (`srv/lib/devtoberfest-transcript.js`) so
   the fragile timedtext strategy can be swapped without touching route/table:
   - Try **uploaded** track (timedtext list, non-`asr`).
   - Fall back to **auto** (`kind=asr`).
   - Parse XML/JSON3 timedtext → normalized `[{ start, text }]`.
3. Store gzip BLOB + `source`; cache negative (`none`) result too.
4. Return `{ videoId, source, lang, segments }`.

Uses Node native `fetch`. Undocumented endpoint acknowledged; adapter + cache
contain the risk.

### Frontend

- In the **enlarged** DetailPanel, a collapsible "Transcript" section below the
  video. Lazy fetch on expand (separate call, not in the main feed).
- Render segments as a scrollable list; each line shows `mm:ss` + text.
- **Clickable timestamps** seek the embedded player via the YouTube IFrame Player
  API (load the iframe with `enablejsapi=1`; `postMessage` `seekTo`). The iframe
  must be the API-enabled player instance from slice 1.
- `source === 'auto'` → small "auto-generated" tag.
- No transcript / fetch fails → quiet "Transcript not available" note.

## Testing

- **Unit** (`srv/lib`): `assembleFeed` — speaker join + ordering, `linkedinUrl`,
  `trackColor`/`trackEmoji`; transcript parser — timedtext→segments, uploaded-vs-auto
  selection, malformed input.
- **hugo-apps component**: DayAgenda thumbnail render (present/absent/onerror);
  DetailPanel speaker block, embed presence, enlarge toggle, transcript expand.
- **Hybrid** (real HANA, `cds bind --exec`): speaker photo endpoint streams a real
  BLOB with correct content-type; transcript endpoint caches; schedule feed carries
  speakers + colors after planner deploy.
- **Real thing (Tom's #1 rule):** exercise the live calendar in a browser through
  the approuter — open a session, watch the embed, enlarge, load a transcript,
  click a timestamp — before calling any of it done.

## Sequencing & deploy

1. Build all three slices on one feature branch.
2. Slice 2 requires the planner `DTF_TRACK_V1` republish + planner DB deploy first;
   coordinate that, then land the facade mirror.
3. Local verification of every slice (unit + component + hybrid where applicable).
4. **Only then** deploy to DEV — full `npm run deploy -- --env dev` (island +
   approuter changes need a full `mbt build`; no `--skip-build`, no `-m` scoping).
   `git fetch origin` immediately before deploy; deploy from primary tree on main;
   Hugo finishes before `mbt build`; re-assert `cf target -s dev`.
5. PR for review (never direct-merge to main).

## Out of scope

- Per-speaker LinkedIn (LinkedIn stays session-level).
- Thumbnails in week/month views.
- Two-column enlarged layout.
- Nightly transcript pre-fetch job (on-demand only for now).
- Any change to the separate `DevtoberfestService` OData surface (the calendar
  uses the custom Express routes, not that service).
```

