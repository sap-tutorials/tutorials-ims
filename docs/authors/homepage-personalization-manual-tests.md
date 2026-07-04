# Homepage Personalization — Manual Test Plan

These 8 scenarios cover the critical paths for issue #763. Run against a deployed environment with `HomepageConfig.personalizationEnabled = true` and at least 15 active `HomepageForYouCandidates` with persona tags.

---

## Scenario 1 — Anonymous visitor

**Setup:** Open a private/incognito browser window (no XSUAA session).

**Steps:**

1. Navigate to `/`.
2. Observe the homepage.

**Expected:**

- Verb spine appears in the default order (`Learn · Build · Integrate · Operate · AI · Connect`).
- No personalized badge strip is visible.
- No "For you" row is visible.
- No network request to `/api/homepage/personalized` is made (check DevTools Network tab).

---

## Scenario 2 — Signed-in user with no learning preferences set

**Setup:** Sign in with a user account that has no `role`, `deployment`, or `cloud` set in `/me/#learning-preferences`.

**Steps:**

1. Navigate to `/`.
2. Observe the homepage.

**Expected:**

- Verb spine appears in the default order.
- Badge strip appears: "Personalized for you · Adjust · See default" (no role/cloud clause in the badge text because the profile is empty).
- "For you" row is hidden (no candidates match an empty profile).
- Network request to `/api/homepage/personalized` returns 200.
- Response includes `Cache-Control: private, no-store` and `X-Personalization: 1` headers.

---

## Scenario 3 — Signed-in developer on AWS

**Setup:** Sign in and set learning preferences: `role = developer`, `cloud = aws`.

**Steps:**

1. Navigate to `/`.
2. Observe the homepage.

**Expected:**

- Verb spine leads with **Build** (developer tilt: build, learn, integrate, ai, operate, connect).
- Badge strip shows: "Personalized for you · developer, AWS · Adjust · See default".
- "For you" row is visible with at least 3 cards matching `role:developer` or `cloud:aws`.
- Cards tagged `cloud:aws` with higher weights appear before generic `role:developer` cards of equal weight.

---

## Scenario 4 — "See default" bypass

**Setup:** Continue from Scenario 3 (signed in as developer/AWS).

**Steps:**

1. On `/`, click "See default" in the badge strip.
2. Observe the page.
3. Navigate away (e.g. to `/learn/`) and back to `/`.
4. Close the tab. Open a new tab and navigate to `/`.

**Expected:**

- After clicking "See default": static homepage renders, verb spine in default order, no "For you" row. Badge shows: "Viewing the default homepage · Personalize again".
- After navigating away and back within the same tab: default view persists. `sessionStorage['sap-devs-homepage-default']` is set.
- After closing and reopening: personalized view resumes (session flag is cleared on tab close).

---

## Scenario 5 — Cross-tab live re-render

**Setup:** Sign in as a user with `role = developer`.

**Steps:**

1. Open `/` in **Tab A**. Note the current verb order and "For you" cards.
2. Open `/me/#learning-preferences` in **Tab B**.
3. In Tab B, change `role` to `architect`. Save preferences.
4. Switch to Tab A within 2 seconds.

**Expected:**

- Tab A reorders the verb spine without a page reload: Integrate now leads (architect tilt: integrate, build, operate, learn, ai, connect).
- The "For you" row updates to show architect-tagged candidates.
- Badge echoes "architect".
- No full page reload occurs; existing hover/focus states on other elements are preserved.

---

## Scenario 6 — `personaHidden` suppresses shelf entry for a student

**Setup:** In the admin UI (`/admin-ui/#homepage`, Shelves tab), find a shelf entry and set `personaHidden: role:student`. Leave `personaTags` with at least one other tag.

**Steps:**

1. Sign in as a user with `role = student`.
2. Navigate to the verb sub-page that contains the entry (e.g. `/learn/`).
3. Observe the shelf section that contained the entry.

**Expected:**

- The entry is not visible in the sub-page shelf for the student user.

**Steps (control):**

4. Sign in as a user with `role = architect`.
5. Navigate to the same verb sub-page.

**Expected:**

- The entry is visible for the architect user.

---

## Scenario 7 — Kill switch off

**Setup:** In `/admin-ui/#homepage`, Config tab, set `personalizationEnabled = false`.

**Steps:**

1. Sign in as any user with learning preferences set.
2. Navigate to `/`.
3. Observe the homepage.

**Expected:**

- Verb spine appears in the default order.
- No personalized badge strip.
- No "For you" row.
- Network request to `/api/homepage/personalized` returns 204 (no body). Confirm in DevTools Network tab.

**Teardown:** Reset `personalizationEnabled = true` after the test.

---

## Scenario 8 — Slow network / offline

**Setup:** Sign in as a user with learning preferences. In DevTools, throttle network to "Slow 3G" or use the offline toggle.

**Steps:**

1. Navigate to `/`.
2. Observe the page during the slow/failing fetch.

**Expected:**

- Static content renders immediately from the Hugo shell.
- No JavaScript errors appear in the DevTools Console above `debug` level.
- No visible layout shift or broken states.
- If the fetch eventually fails (offline): page remains in the static state; no badge; no "For you" row.
- No user-visible error messages or broken component states.
