# U17 — Profile Timeline (Recent Activity) Design Spec

**Date:** 2026-05-22
**Branch:** `ui-pilot/u17-profile-timeline`
**Pilot series:** U17 of the UI5-pilot pattern (presentational ui5-* component on existing surface)

## Goal

Add a `<ui5-timeline>` "Recent Activity" section to the existing `/me/` profile page (`apps/src/me/MyCompletions.vue`) that shows the user's most recent tutorial completions in chronological order. The existing sortable/filterable completions table remains below the timeline, unchanged.

## Why

The `/me/` page is currently a single dense table. Tom asked for `ui5-timeline` on the user profile to surface "learning history" in a more skimmable, narrative way. The U-series presentational rule restricts the data source to the existing `getMyCompletions()` endpoint — no new backend functions, no schema changes. The timeline and the table are intentionally complementary: the timeline says "here's what you did recently," the table says "here's everything, searchable."

## Scope

**In scope:**
- New `<ui5-timeline>` "Recent Activity" section above the existing table
- Sourced from the same `getMyCompletions()` payload the page already fetches
- Cap at the **10 most recent** completions; if there are fewer than 10, show all
- Each item: tutorial title (clickable → `/tutorials/<slug>/`), topic tag as subtitle, relative time ("2 days ago") in subtitle, level badge in slotted body
- Empty state when zero completions: `<ui5-illustrated-message name="NoActivities">` (consistent with U7 illustrated-message pattern)
- Page header copy: keep "My Completions" — the timeline is a section within it, not a rebrand

**Out of scope:**
- New backend functions (`getMyAccomplishments`, `getMyPrizes`) — explicitly cut per Tom's scoping decision; presentational-only
- Showing accomplishments or prizes in the timeline (no data source on DeveloperService today)
- Pagination / infinite scroll on the timeline (`growing="None"` — fixed cap of 10)
- Any change to the existing completions table behavior, columns, sorting, or filtering
- Dark-mode-specific styling (UI5 components inherit `data-theme` automatically)
- Schema migrations
- New tests beyond a manual browser-verification checklist

## Architecture

### Surface

Single Vue 3 SFC: `apps/src/me/MyCompletions.vue`. The component is mounted on `#me-completions` from `hugo/layouts/me/list.html` via `apps/src/me/main.ts`. No new mount, no new Vite entry.

### Layout

```
┌─ My Completions ─────────────────────────────────┐
│   Tutorials you've finished, most recent first.  │
├──────────────────────────────────────────────────┤
│   Recent Activity                                │
│   ┌─ ui5-timeline (Vertical) ──────────────────┐ │
│   │  ◯ Build a CAP service · 2 days ago       │ │
│   │  ◯ Deploy to BTP · 5 days ago             │ │
│   │  ◯ Set up SAP HANA Cloud · 1 week ago     │ │
│   │  … up to 10 items …                        │ │
│   └────────────────────────────────────────────┘ │
├──────────────────────────────────────────────────┤
│   All Completions                                │
│   [filter row]   [sortable table]                │
└──────────────────────────────────────────────────┘
```

When `rows.length === 0`: timeline section is hidden; existing illustrated-message empty state below remains the sole "you haven't done anything yet" affordance. (No double-empty-state.)

When `rows.length >= 1`: timeline shows; existing table also shows. Both render from the same fetched payload.

### Data flow

1. `onMounted` → `fetch('/auth/user')` — unchanged
2. `fetch('/api/getMyCompletions()')` — unchanged
3. The existing reactive `rows` ref drives **both** the timeline and the table
4. New computed `recentRows = computed(() => rows.value.slice().sort(byDateDesc).slice(0, 10))`
5. Timeline iterates `recentRows`; table iterates the existing `sorted` (filter + sort applied)

No new fetch calls. No new endpoints. No client state beyond the new computed.

### UI5 component usage

Verified against UI5 MCP at design time:
- `<ui5-timeline layout="Vertical" growing="None">` — vertical orientation, no More button
- `<ui5-timeline-item name="<title>" subtitle-text="<topic> · <time-ago>" icon="accept" state="Positive" name-clickable>` — `name-click` event navigates to `/tutorials/<slug>/`
- Body slot holds the level badge (e.g., "Beginner") as a small text node so we don't ship more components than necessary

`name-clickable` + `name-click` event is the right primitive for the navigation interaction (verified in MCP); no surrounding `<a>` tag needed.

### Time formatting

Inline helper `formatRelative(iso)`:
- < 1 hour → "Just now"
- < 24 hours → "<n>h ago"
- < 30 days → "<n>d ago"
- < 12 months → "<n>mo ago"
- else → existing `formatDate(iso)` ("May 22, 2026")

Pure function, no library.

### Error handling

- Failure of `/api/getMyCompletions()`: existing `errorMsg` flow handles both timeline and table (timeline section hidden, error message shown).
- Failure of `/auth/user`: existing not-signed-in path — no timeline.
- Malformed `completionDate` in a row: that one row is dropped from `recentRows` (timeline) but still appears in the table with em-dash.

## Testing

**Manual browser verification (required before PR):**
- [ ] Logged-out: not-signed-in prompt appears, no timeline rendered
- [ ] Logged-in with 0 completions: existing illustrated-message empty state appears, no timeline section
- [ ] Logged-in with 1–9 completions: timeline shows that exact count, sorted newest first
- [ ] Logged-in with ≥10 completions: timeline shows exactly 10, table shows all
- [ ] Click on item name navigates to `/tutorials/<slug>/`
- [ ] Light theme renders OK
- [ ] Dark theme (`data-theme="dark"`) renders OK
- [ ] Mobile breakpoint (`max-width: 600px`) — timeline stays readable, no horizontal scroll
- [ ] Relative-time format reads correctly across the date ranges
- [ ] `npm test` shows no NEW failures vs main baseline (pre-existing 29-test failure baseline documented in memory)

**Automated tests:** None added. The U-series pilots are presentation-only; the existing API surface is unchanged. Following the U6/U7/U8/U9/U10/U11/U12/U13/U14/U15/U16 precedent.

## Risks

- **Timeline + table on the same page may feel duplicative.** Mitigated by: timeline is fixed-10-recent narrative; table is searchable/sortable archive. Different jobs.
- **`name-clickable` + slotted body interaction:** UI5 v2.x docs are clear that `name-click` fires only when `name-clickable` is set. Any keyboard accessibility for the level badge in the body slot needs visual verification.
- **Relative-time strings can become misleading at boundaries** (e.g., "30d ago" vs "1mo ago"). Acceptable for a narrative surface; the table shows precise dates.

## File touch list (preview — final list locked in plan)

- **Modify:** `apps/src/me/MyCompletions.vue` — add `recentRows` computed, `formatRelative` helper, `<ui5-timeline>` section above the existing toolbar/table

No new files. No backend changes. No CSS file changes (scoped styles within the SFC).

## Out-of-scope follow-ups (do NOT do in U17)

- A future U-series pilot could add `getMyAccomplishments` / `getMyPrizes` to DeveloperService and extend the timeline to mix activity types
- Sticky timeline / scroll-to-top affordance
- "Share my progress" CTA
