# U17 — Profile Timeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `<ui5-timeline>` "Recent Activity" section to the existing `/me/` profile page showing the user's 10 most recent tutorial completions, sourced from the same `getMyCompletions()` payload that already drives the page's table.

**Architecture:** Single Vue 3 SFC modification (`apps/src/me/MyCompletions.vue`). Add a `recentRows` computed (slice + sort by date desc + slice 10), an inline `formatRelative()` helper, and a `<ui5-timeline>` section above the existing `.me-toolbar`. Empty state and error state already handled by the existing flow — when `rows.length === 0` the timeline section is hidden and the existing illustrated-message empty state remains the sole "you haven't done anything yet" affordance.

**Tech Stack:** Vue 3 SFC + UI5 Web Components (`@ui5/webcomponents-fiori/dist/Timeline.js`, `TimelineItem.js`). No new backend, no new endpoints, no CSS pipeline changes.

**Spec:** [`docs/superpowers/specs/2026-05-22-u17-profile-timeline-design.md`](../specs/2026-05-22-u17-profile-timeline-design.md)

---

## Resolved Open Questions

- **Subtitle mapping:** the `Completion` payload has `primaryTag` (string) and `experienceTag` (string). Subtitle text = `${primaryTag} · ${formatRelative(completionDate)}`. Body slot holds the experienceTag (level) as a small text node.
- **Keyboard accessibility on `name-clickable`:** UI5 v2.x `<ui5-timeline-item>` exposes the title as a focusable element when `name-clickable` is set; Tab moves focus, Enter fires `name-click`. We rely on UI5's built-in keyboard handling — no custom keydown wiring needed. Manual verification in the test checklist.

---

## Pre-flight (already done in prior session)

- Worktree set up at `.worktrees/u17-profile-timeline` on branch `ui-pilot/u17-profile-timeline` from `origin/main` at `91faa04`.
- `npm install` complete; baseline `npm test` matches main (29 pre-existing failures, no new ones).
- UI5 v2.x APIs verified at design time via `mcp__ui5-webcomponents__get_component_api`: `<ui5-timeline layout="Vertical" growing="None">`; `<ui5-timeline-item name name-clickable subtitle-text icon state>`; `name-click` event fires only when `name-clickable` is set.

---

## Task 1: Register UI5 Timeline imports

**Files:**
- Modify: `apps/src/ui5-bootstrap.ts` (or wherever existing UI5 components are registered for the `/me/` entry — verify by inspection)
- Modify: `apps/src/me/main.ts` (if Timeline registration is co-located with the entry)

- [ ] **Step 1: Locate the existing UI5 import block for the `/me/` entry**

```bash
# From worktree root
grep -rn "@ui5/webcomponents" apps/src/me/ apps/src/ui5-bootstrap.ts 2>/dev/null
```

Expected: see existing imports of `@ui5/webcomponents/dist/IllustratedMessage.js` and friends already used by MyCompletions.vue.

- [ ] **Step 2: Add Timeline + TimelineItem imports**

In whichever file the existing UI5 imports for the `/me/` entry live (most likely `apps/src/me/main.ts`), add:

```ts
import "@ui5/webcomponents-fiori/dist/Timeline.js";
import "@ui5/webcomponents-fiori/dist/TimelineItem.js";
```

If `@ui5/webcomponents-fiori` is not in `package.json`, install it: `npm i @ui5/webcomponents-fiori`. (It is already used by U16's mission side-nav so it should be present — verify before installing.)

- [ ] **Step 3: Build the `/me/` Vite entry to confirm imports resolve**

```bash
npm run build:apps
```

Expected: build succeeds, no module-not-found error.

- [ ] **Step 4: Commit**

```bash
git add apps/src/me/main.ts package.json package-lock.json
git commit -m "$(cat <<'EOF'
feat(u17): register ui5-timeline imports for profile entry

Add Timeline + TimelineItem from @ui5/webcomponents-fiori so the
/me/ Vue island can render the upcoming "Recent Activity" section.
EOF
)"
```

---

## Task 2: Add `formatRelative()` helper

**Files:**
- Modify: `apps/src/me/MyCompletions.vue` — `<script setup>` block

- [ ] **Step 1: Add the helper alongside the existing `formatDate`**

In `<script setup lang="ts">`, near `formatDate(iso)`:

```ts
function formatRelative(iso?: string): string {
  if (!iso) return "—";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return formatDate(iso);
  const diffMs = Date.now() - then;
  if (diffMs < 0) return "Just now";
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 60) return "Just now";
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  return formatDate(iso);
}
```

Pure function. No library. Falls back to existing `formatDate(iso)` for >12 months.

- [ ] **Step 2: Commit**

```bash
git add apps/src/me/MyCompletions.vue
git commit -m "$(cat <<'EOF'
feat(u17): add formatRelative helper for timeline subtitles

Returns "Just now" / "Nh ago" / "Nd ago" / "Nmo ago" / fallback to
formatDate for older entries. Pure function, no library.
EOF
)"
```

---

## Task 3: Add `recentRows` computed

**Files:**
- Modify: `apps/src/me/MyCompletions.vue` — `<script setup>` block

- [ ] **Step 1: Add the computed near the existing `sorted` computed**

```ts
const recentRows = computed(() => {
  return rows.value
    .slice()
    .filter((r) => !!r.completionDate && !Number.isNaN(new Date(r.completionDate).getTime()))
    .sort((a, b) => new Date(b.completionDate!).getTime() - new Date(a.completionDate!).getTime())
    .slice(0, 10);
});
```

Drops malformed-date rows (they still appear in the table with em-dash via existing logic).

- [ ] **Step 2: Commit**

```bash
git add apps/src/me/MyCompletions.vue
git commit -m "$(cat <<'EOF'
feat(u17): compute 10 most recent completions for timeline

recentRows slices the existing rows ref into a date-desc top-10 for
the upcoming ui5-timeline section. Drops rows with malformed dates.
EOF
)"
```

---

## Task 4: Add `<ui5-timeline>` section to the template

**Files:**
- Modify: `apps/src/me/MyCompletions.vue` — `<template>` block

- [ ] **Step 1: Insert the timeline section above `.me-toolbar`**

Place this block between the page-header `<header>` and the existing `<div class="me-toolbar">` (rendered only when logged in, has rows, and no error):

```vue
<section
  v-if="isLoggedIn && !errorMsg && recentRows.length > 0"
  class="me-recent"
  aria-labelledby="me-recent-heading"
>
  <h2 id="me-recent-heading" class="me-recent__heading">Recent Activity</h2>
  <ui5-timeline layout="Vertical" growing="None">
    <ui5-timeline-item
      v-for="item in recentRows"
      :key="item.slug"
      :name="item.title"
      :subtitle-text="`${item.primaryTag || 'Tutorial'} · ${formatRelative(item.completionDate)}`"
      icon="accept"
      state="Positive"
      name-clickable
      @name-click="onTimelineNameClick(item.slug)"
    >
      <span class="me-recent__level">{{ formatLevel(item.experienceTag) }}</span>
    </ui5-timeline-item>
  </ui5-timeline>
</section>
```

- [ ] **Step 2: Add the `onTimelineNameClick` handler in `<script setup>`**

```ts
function onTimelineNameClick(slug: string) {
  if (!slug) return;
  window.location.href = `/tutorials/${slug}/`;
}
```

(Plain `window.location.href` matches the rest of the file; no router involved.)

- [ ] **Step 3: Build and run dev server, verify timeline renders**

```bash
npm run build:apps
npm run dev
```

Open `http://localhost:1313/me/` while logged in (or in a hybrid session with a CAP backend that returns completions). Expected: timeline section visible above the existing table; titles are clickable; subtitle reads "<topic> · <time-ago>".

- [ ] **Step 4: Commit**

```bash
git add apps/src/me/MyCompletions.vue
git commit -m "$(cat <<'EOF'
feat(u17): render ui5-timeline of 10 most recent completions

Adds a "Recent Activity" section above the existing toolbar/table.
Sourced from the same getMyCompletions() payload — no new fetch.
Title is name-clickable and navigates to /tutorials/<slug>/.
EOF
)"
```

---

## Task 5: Add scoped styles for the timeline section

**Files:**
- Modify: `apps/src/me/MyCompletions.vue` — `<style scoped>` block

- [ ] **Step 1: Add styles**

```css
.me-recent {
  margin-bottom: 1.5rem;
  padding: 1rem 1.25rem;
  background: var(--sapList_Background);
  border: 1px solid var(--sapList_BorderColor);
  border-radius: 0.5rem;
}

.me-recent__heading {
  font-size: 1rem;
  font-weight: 600;
  margin: 0 0 0.75rem;
  color: var(--sapTextColor);
}

.me-recent__level {
  font-size: 0.75rem;
  color: var(--sapContent_LabelColor);
}

@media (max-width: 600px) {
  .me-recent {
    padding: 0.75rem;
  }
}
```

- [ ] **Step 2: Verify in browser at light + dark themes and at 600px width**

```bash
npm run dev
```

Open `/me/` and:
- Toggle dark theme via the existing site theme toggle — confirm timeline still readable
- Resize to <600px width — confirm no horizontal scroll, padding shrinks

- [ ] **Step 3: Commit**

```bash
git add apps/src/me/MyCompletions.vue
git commit -m "$(cat <<'EOF'
feat(u17): scope styles for Recent Activity timeline section

Uses sap CSS vars so it inherits both light and dark themes. Mobile
padding shrinks at <=600px to match the existing toolbar/table.
EOF
)"
```

---

## Task 6: Manual browser verification checklist

**Files:** none — verification only

- [ ] **Step 1: Run unit tests baseline**

```bash
npm test
```

Expected: same pass/fail count as main (29 pre-existing failures documented in memory).

- [ ] **Step 2: Logged-out path**

In a fresh incognito window, open `/me/`. Expected: existing not-signed-in prompt; no timeline section.

- [ ] **Step 3: Logged-in with 0 completions**

Log in with a fresh account (or stub the response). Expected: existing illustrated-message empty state appears; no timeline section.

- [ ] **Step 4: Logged-in with 1–9 completions**

Expected: timeline shows the exact count, sorted newest first; table shows all rows.

- [ ] **Step 5: Logged-in with ≥10 completions**

Expected: timeline shows exactly 10 most recent; table shows all (filtering/sorting unchanged).

- [ ] **Step 6: Click on item name**

Expected: navigates to `/tutorials/<slug>/`.

- [ ] **Step 7: Tab/Enter keyboard accessibility**

Tab to a timeline item title; press Enter. Expected: navigates to `/tutorials/<slug>/`. Focus ring visible.

- [ ] **Step 8: Light + Dark theme**

Toggle the site theme. Expected: both themes render the timeline correctly (no contrast issues, icon color follows `state="Positive"`).

- [ ] **Step 9: Mobile breakpoint (≤600px)**

Resize or use device emulator. Expected: timeline stays readable, no horizontal scroll.

- [ ] **Step 10: Relative-time format spot-check**

Confirm the format reads correctly across the date ranges: a recent completion shows "Nh ago", an old one falls back to formatted date.

---

## Task 7: Open PR

**Files:** none — git/gh

- [ ] **Step 1: Push branch**

```bash
git push -u origin ui-pilot/u17-profile-timeline
```

- [ ] **Step 2: Create PR**

```bash
gh pr create --title "U17: Profile timeline (recent activity)" --body "$(cat <<'EOF'
## Summary
- Adds a `<ui5-timeline>` "Recent Activity" section above the existing completions table on `/me/`
- Sources from the same `getMyCompletions()` payload — no new backend, no schema change
- Caps at 10 most recent; existing table still shows all rows with sort/filter

## Test plan
- [x] Unit tests baseline matches main (29 pre-existing failures, no new ones)
- [ ] Manual: logged-out, 0 completions, 1–9, ≥10
- [ ] Manual: click navigates to `/tutorials/<slug>/`
- [ ] Manual: Tab + Enter keyboard accessibility
- [ ] Manual: light + dark themes
- [ ] Manual: ≤600px mobile breakpoint

Spec: `docs/superpowers/specs/2026-05-22-u17-profile-timeline-design.md`
EOF
)"
```

- [ ] **Step 3: Capture PR URL for handoff**

Print the PR URL. Done.
