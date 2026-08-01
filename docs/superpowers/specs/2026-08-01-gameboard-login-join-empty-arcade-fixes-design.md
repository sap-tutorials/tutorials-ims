# Gameboard fixes — active-event resolution, login-vs-join, empty-state, arcade content — Design

**Date:** 2026-08-01
**Status:** Approved (decisions locked with Tom), pending → plan
**Repos:** `tutorials-ims` (provider view + both islands) + `sap-community-gameboard` (backend + facade).

## 1. Problem (observed on DEV, verified)

Logged in, `/devtoberfest/gameboard/` says "log in" and is mostly empty. Root causes:

1. **`getActiveEvent` derives the active event from the PARTICIPANT view** (`GAMEBOARD_PARTICIPANT_V1`). With 0 `EventRegistrations`, it returns null **for everyone — including logged-in users** → the personalized arm is null → the UI shows "log in." (Verified: 1 DEVTOBERFEST event, 0 registrations, 0 participants.)
2. **The UI conflates three cases into one "log in" message.** `getMyGameboard` returns null for (a) no active event, (b) anonymous, (c) logged-in-but-not-joined. The cabinet always says "Log in…" — wrong for a logged-in user, who should be told to **Join Devtoberfest**.
3. **Board is empty** (`totals:[]`, `tracks:[]`) because there are **no Activities in the Planner** (`DTF_ACTIVITY_V1` empty) → nothing to render, and no empty-state, so it looks broken.
4. **Arcade** (`/devtoberfest/arcade/`): spacing/layout off, and missing the legacy instructional content (How-to-Play, Making-the-Lawyers-Happy, menu icons, points/level banner).

## 2. Decisions (locked with Tom)

| # | Decision |
|---|---|
| 1 | Resolve the active event from `DevtoberfestConfig.isActive=true → currentEvent`, independent of registrations (new provider view). |
| 2 | Backend returns a **status** distinguishing `anonymous` / `not_joined` / `joined`; both islands show Log-in / Join-Devtoberfest / progress accordingly. |
| 3 | Add a friendly empty-state ("activities coming soon") when there are no activities; the missing Activities are a **data task** (team seeds them in the Planner). |
| 4 | Arcade: fix layout to legacy proportions **and** add the missing legacy instructional content. |

## 3. Fix 1 — active-event resolution (independent of participants)

**Authoritative source** (from recon): `DevtoberfestConfig WHERE ISACTIVE=true → CURRENTEVENT_ID → Events`. Exists regardless of registrations.

**Provider (tutorials-ims):** new view `db/src/GAMEBOARD_ACTIVE_EVENT_V1.hdbview`:
```sql
VIEW "GAMEBOARD_ACTIVE_EVENT_V1" AS
  SELECT e."ID"        AS "EVENT_ID",
         e."NAME"      AS "EVENT_NAME",
         e."STARTDATE" AS "EVENT_START",
         e."ENDDATE"   AS "EVENT_END"
  FROM "COM_SAP_DEVELOPERS_IMS_DEVTOBERFESTCONFIG" c
  JOIN "COM_SAP_DEVELOPERS_IMS_EVENTS" e ON e."ID" = c."CURRENTEVENT_ID"
  WHERE c."ISACTIVE" = TRUE
```
Add to the `gameboard_reader` role (+grantable). (0 or 1 row.)

**Consumer (gameboard repo):** facade `external.GameboardActiveEventV1` (UPPERCASE cols) + synonym + `getActiveEvent()` reads THIS view (not the participant view). Returns `{id,start,end}` or null only when there's genuinely no active config.

The participant view keeps `EVENT_START`/`EVENT_END` (still used to list participants for the leaderboard), but event *resolution* no longer depends on it.

## 4. Fix 2 — login-vs-join status

**Backend contract change** — `getMyGameboard()` returns a status instead of bare null:
```
type MyGameboard {
  status : String;   // 'joined' | 'not_joined' | 'no_event'
  userId : String; score : Integer; level : Integer; avatarIndex : Integer;
  breakdown : array of WeekTrackBreakdown;
}
```
- **anonymous** → the endpoint is `@requires:'authenticated-user'`, so an anonymous browser gets 401 (the island already treats a 401 as "anonymous"). No body needed.
- **authenticated + active event + participant row** → `status:'joined'` + the real score/level/avatar/breakdown.
- **authenticated + active event + NO participant row** → `status:'not_joined'` (score/level 0).
- **authenticated + no active config** → `status:'no_event'`.

`getGameboard` (public) likewise gains a top-level `hasActiveEvent` / `activityCount` so the board can show the empty-state.

**Both islands** decide the CTA from (HTTP 401 vs status):
- 401 → **"Log in"** (anonymous).
- `not_joined` → **"Join Devtoberfest"** (→ `/devtoberfest/#join`).
- `no_event` → **"Devtoberfest isn't running right now."**
- `joined` → show avatar/progress (leaderboard cabinet) or the player scene (arcade).

**Leaderboard `CabinetFrame.vue`:** replace the single hardcoded "Log in…" line with the status-driven message + the avatar shown only when `joined`.
**Arcade `Arcade.vue`:** the demo+CTA state already exists; wire its CTA text/behavior to the same status (Log-in vs Join vs no-event).

## 5. Fix 3 — empty-state

When `getGameboard` reports no activities (`totals`/`tracks` empty, or `activityCount:0`): both surfaces show a friendly **"Activities coming soon — check back when Devtoberfest kicks off"** instead of a blank board. Not an error; distinct from the join CTA. (The data gap — authoring Activities in the Planner + registrations — is a **team task**, documented in the README, not code.)

## 6. Fix 4 — arcade layout + missing legacy content

Add the omitted legacy layers to `Scene.vue` (verbatim text from recon `_i18n/messages.properties`):
- **Gameboard header:** "{firstName}, Devtoberfest 2025 has started!" + a link to the user's SAP Community profile (only when `joined`/community-linked; generic when not).
- **HOW TO PLAY** column (left): the register-→-complete-activities instructions + the "Join Group" and rules links.
- **MAKING THE LAWYERS HAPPY** column: the entertainment-purposes-only disclaimer + rules link.
- **Points banner:** "POINTS: {score} LEVEL: {level}" (already partly present — confirm format).
- **Menu icons:** Awards / Points / Rules (→ contest-rules blog) + Sound toggle (already have the toggle).
- **Layout/spacing:** move from the current ad-hoc placement to the legacy proportional coordinate system (the legacy 1347×1612 canvas with the documented per-element x/y), scaled responsively, so columns/banner/menu/avatar sit where they did in the legacy.

## 7. Testing

- **Provider:** hybrid test that `GAMEBOARD_ACTIVE_EVENT_V1` resolves and returns the config-active event (independent of participants).
- **Backend:** unit tests for `getMyGameboard` status branches (joined / not_joined / no_event) with fixtures; `getActiveEvent` reads the active-event view.
- **Islands:** leaderboard cabinet shows Log-in (401) vs Join (`not_joined`) vs progress (`joined`) vs no-event; empty-state when no activities; arcade renders the instructional columns + menu + banner; layout snapshot/positions.
- **Verification-before-done:** on DEV, logged-in, confirm the gameboard now says "Join Devtoberfest" (not "log in") and the arcade shows the instructions; after a test join + an in-window completion, confirm progress renders.

## 8. Rollout / sequencing

1. Provider view (`GAMEBOARD_ACTIVE_EVENT_V1` + role) → tutorials-ims, deploy first.
2. Gameboard backend + facade (event resolution + status) → gameboard repo, deploy second.
3. Both islands (messaging + empty-state + arcade content/layout) → tutorials-ims, deploy last.

## 9. Open questions / risks

- **Community-profile link in the arcade header** — only when the user has linked their community profile (`Users.khorosId`); otherwise show the generic header. Confirm during build.
- **Legacy coordinate → responsive mapping** — the legacy fixed-canvas positions need translating to the responsive scaled scene without regressing the sprite placement already working.
- **Data task ownership** — Activities + registrations must be seeded in the Planner for the board to populate; out of code scope, documented for the team.
