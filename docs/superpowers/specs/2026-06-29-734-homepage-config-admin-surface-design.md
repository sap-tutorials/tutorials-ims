# Issue #734 — Surface `HomepageConfig` (+ Redirects) in the admin shell

- **Status:** Approved (2026-06-29), spec-reviewer pass complete
- **Issue:** [#734](https://github.com/sap-tutorials/tutorials-ims/issues/734)
- **Predecessor specs:** [`2026-06-27-639-developer-homepage-design.md`](./2026-06-27-639-developer-homepage-design.md) (Phase 4 cutover that introduced `HomepageConfig` + `LegacyRedirects` but only surfaced `HomepageShelves`)
- **Predecessor PRs:** [#701](https://github.com/sap-tutorials/tutorials-ims/pull/701) (YouTube config — exposed the gap by forcing a `cds bind --exec` workaround to set `developerNewsPlaylistId`)

## Summary

Navigating to `/admin-ui/#homepage` today lands on the Homepage Shelves list page. Two related admin surfaces are wired in the Fiori Elements manifest but **unreachable**:

1. **`HomepageConfig` singleton** — holds `developerNewsPlaylistId` plus three feature flags (`videoBandEnabled`, `eventsBandEnabled`, `communityLaneEnabled`). The entity is exposed at `AdminService.HomepageConfig`, has `@UI.FieldGroup#Main` annotations, has an auto-init `before('READ')` hook, and has a `ConfigOP` route in the homepage component's inner manifest. There is no admin nav entry to land you on it.

2. **`LegacyRedirects` list** — same status. Routes `RedirectsList` + `RedirectOP` exist in the component manifest, but no admin nav entry.

This spec adds three nav entries — Shelves, Redirects, Config — under a new top-level "Homepage" group, all targeting the existing `homepageTarget` Component. The work is purely declarative routing + a few nav-key handler entries; no new Fiori app, no new view, no Component restructuring.

## Scope

### In scope

- Add a top-level "Homepage" nav group to `navigation.json` with three children: Shelves, Redirects, Config.
- Add three shell routes in `manifest.json`, all targeting the existing `homepageTarget`.
- Update `Shell.controller.js`'s `NAV_KEY_TO_ROUTE` + `NAV_KEY_TO_TITLE` maps; add `setHash` calls for the inner Component's `Redirects` and `Config` routes (following the `pipelinelog/joblog` precedent on `Shell.controller.js:119-124`).
- Add a unit test that pins the structural invariants across all three modified files.
- Add a smoke test that confirms `/admin/HomepageConfig` returns the singleton and `/admin-ui/` still loads.

### Out of scope

- A separate Fiori app at `app/admin/homepage-config/`. The Config entity is one row with four fields; building a sibling app is over-engineered. The existing component already has the route — we only need to make it reachable.
- Tabbed entry point (sap.m.IconTabBar etc.). Would require a custom shell view; three side-nav entries are equally discoverable and zero-code.
- Header-bar buttons on the Shelves list. Discoverability is worse than a side-nav entry and the buttons need handlers anyway.
- Live cache-bust button on save (called out as out-of-scope in the issue body).
- Validation on `developerNewsPlaylistId` format. Today's acceptance is "settable" — no format check. If we want one, it belongs as a `@assert.format` annotation on the CDS side and is a separable concern.

## Approach

The decisive observation: `operationsTarget` (the Featured Tasks / Pipeline Log / Job Log Component) is already a one-Component-three-routes pattern in this codebase. `manifest.json:294-296` declares three shell routes (`operations`, `pipelinelog`, `joblog`) all pointing at `operationsTarget`. `Shell.controller.js:119-124` distinguishes them by calling `HashChanger.setHash()` with the inner-Component's path after `router.navTo()`:

```js
if (sKey === "pipelinelog") {
  HashChanger.getInstance().setHash("pipelinelog&/op/PipelineLog");
}
if (sKey === "joblog") {
  HashChanger.getInstance().setHash("joblog&/op/JobExecutionLog");
}
```

We replicate exactly this pattern for the homepage component:

```js
if (sKey === "homepageRedirects") {
  HashChanger.getInstance().setHash("homepageRedirects&/hp/Redirects");
}
if (sKey === "homepageConfig") {
  HashChanger.getInstance().setHash("homepageConfig&/hp/Config");
}
```

The `&/hp/<inner-route>` syntax is UI5's prefixed-Component routing: `hp` is the homepage Component's prefix (declared on `manifest.json:501-505`); `Redirects` and `Config` are pattern names from the inner manifest at `app/admin/homepage/webapp/manifest.json:62-79`.

`homepageShelves` needs no `setHash` — when the user lands on `#homepageShelves`, the homepage Component's empty-pattern inner route (`:?query:` mapping to `ShelvesList`) is the default.

## 1. Architecture

### 1.1 Navigation flow

```
User clicks "Homepage > Config" in side nav
  → Shell.controller.js#onNavItemSelect (sKey = "homepageConfig")
  → NAV_KEY_TO_ROUTE["homepageConfig"] = "homepageConfig"
  → router.navTo("homepageConfig")            sets shell hash to "homepageConfig"
  → matching shell route → target homepageTarget (Component, prefix "hp")
  → controller calls setHash("homepageConfig&/hp/Config")
  → homepage Component's inner router matches "Config:?query:"
  → instantiates ConfigOP target (Fiori Elements ObjectPage over /HomepageConfig)
  → Fiori Elements GET /admin/HomepageConfig
    → before('READ') auto-inits singleton if absent
  → ObjectPage renders @UI.FieldGroup#Main (4 fields)
```

### 1.2 Group placement in nav

A new top-level group sits between "Content" and "Rewards":

```
Dashboard
Content                ← existing 11 entries (homepage removed from here)
  ...
Homepage               ← NEW
  Shelves
  Redirects
  Config
Rewards
  ...
```

Icon: `sap-icon://home`. Symmetric with other group icons (`folder-blank` for Content, `present` for Rewards, etc.). No `requiredScope` on the group — visible to all admins (matches the current homepage entry's behavior).

## 2. Components

### 2.1 Modified

| File | Change |
|---|---|
| `app/admin-shell/webapp/model/navigation.json` | Remove `{ "key": "homepage", "title": "Homepage" }` from the "Content" group's `items`. Insert a new top-level group at index 2 (between Content and Rewards): `key: "homepageGroup"`, `title: "Homepage"`, `icon: "sap-icon://home"`, `items: [homepageShelves, homepageRedirects, homepageConfig]`. |
| `app/admin-shell/webapp/manifest.json` | Replace the single `{ "name": "homepage", "pattern": "homepage", "target": [{"name": "homepageTarget", "prefix": "hp"}] }` route with three: `homepageShelves` (pattern `homepage` — keeps the existing `#homepage` URL working), `homepageRedirects` (pattern `homepageRedirects`), `homepageConfig` (pattern `homepageConfig`). All three target `homepageTarget` with the same `prefix: "hp"`. |
| `app/admin-shell/webapp/controller/Shell.controller.js` | In `NAV_KEY_TO_ROUTE`: drop the `homepage` entry, add `homepageShelves`, `homepageRedirects`, `homepageConfig`. In `NAV_KEY_TO_TITLE`: drop the `homepage` entry, add three with titles `"Homepage Shelves"`, `"Homepage Redirects"`, `"Homepage Config"`. In `onNavItemSelect`: add two `setHash` calls following the `pipelinelog/joblog` precedent on lines 119-124. |

### 2.2 Added

| File | Purpose |
|---|---|
| `test/unit/admin-shell-homepage-nav.test.ts` | Text-grep test on the three modified files. Asserts `navigation.json` has `homepageGroup` with three children; the legacy single `homepage` nav-key is gone. Asserts `manifest.json` has three routes all targeting `homepageTarget`. Asserts `Shell.controller.js` has the three nav-key entries in both maps plus the two `setHash` calls. |
| `test/smoke/admin-homepage-config.smoke.test.js` | Three smoke assertions: `GET /admin-ui/` returns 200; `GET /admin/HomepageConfig` returns 200 with the four-field singleton; navigation to the route doesn't 404. Reuses the existing smoke-test admin-auth bootstrap. |

### 2.3 NOT modified

| File | Why |
|---|---|
| `app/admin/homepage/webapp/manifest.json` | Already has all three inner routes (`ShelvesList`, `RedirectsList`, `ConfigOP`) wired correctly. |
| `srv/admin-service.cds` | `HomepageConfig` already exposed as `@odata.singleton`. |
| `srv/admin-service.js` | Singleton auto-init `before('READ')` handler already in place (line 409-422). |
| `app/admin-annotations.cds` | `HomepageConfig` already has `@UI.FieldGroup#Main` + `@UI.HeaderInfo` annotations (line 2940-2952). |
| `app/admin-shell/webapp/i18n/i18n.properties` | No change. The side-nav binds `{nav>title}` directly to the JSON model values (`app/admin-shell/webapp/view/Shell.view.xml:75,82`) — titles are literal strings, not i18n keys. |

## 3. Data flow

### 3.1 Build time

None beyond the admin-shell's normal build:

```
npm run build:admin
  → webpack/vite copies webapp/ → dist/
  → mta.yaml step: cp -r app/admin-shell/dist/. approuter/static/admin-ui/
```

No CDS rebuild, no Vue/Vite rebuild, no Hugo rebuild. Pure static-asset change.

### 3.2 Request time

See Section 1.1 — full flow from side-nav click to ObjectPage render.

### 3.3 Cache propagation (admin save → homepage update)

Already wired by the existing fetcher caches. No code change needed for this:

- `developerNewsPlaylistId` reaches the homepage YouTube band via the existing 15-min `srv/lib/youtube-fetcher.js` cache TTL. Admin saves → first homepage fetch after TTL expires picks up the new playlist.
- `videoBandEnabled` / `eventsBandEnabled` / `communityLaneEnabled` reach the homepage via the 60-second fetcher caches for those bands.

The issue's acceptance bullet "change propagates within existing cache TTLs (15 min YouTube, 60s for the rest) — no redeploy required" is already true; we're only adding the surface that lets the change be made.

## 4. Error handling

### 4.1 Inner-hash race after `navTo`

`router.navTo()` and `HashChanger.setHash()` fire on the same tick. If the inner hash arrives before the Component mounts, UI5 buffers it; if after, it's a same-tick mutation. The `pipelinelog/joblog` precedent uses exactly this order in production today and works — we match it.

### 4.2 Singleton row missing on first read

Already handled by `admin-service.js:409-422`. The `before('READ', 'HomepageConfig')` handler INSERTs the default row with all four fields populated:

```js
{
  ID: HOMEPAGE_CONFIG_SINGLETON_ID,  // 00000000-0000-0000-0000-00000000c8ae
  developerNewsPlaylistId: null,
  videoBandEnabled: true,
  eventsBandEnabled: true,
  communityLaneEnabled: true
}
```

No new code needed.

### 4.3 Unknown nav-key arrives in `onNavItemSelect`

`Shell.controller.js:117` is `if (sRoute) { ... }` — undefined route names fall through silently. If `navigation.json` and `NAV_KEY_TO_ROUTE` drift (e.g. a future contributor adds a nav entry without the controller mapping), the click is a no-op. Implementation step: confirm an `else` branch with `console.warn` exists, or add one — surfaces drift instead of failing silently.

### 4.4 `_onRouteMatched` hash-sniffing asymmetry (no symmetric branch needed)

The existing `_onRouteMatched` (lines 381-394) has a hash-sniffing branch for `sRouteName === "operations"` that re-maps `sNavKey` to `pipelinelog` / `joblog` based on the inner hash. That's needed there because operations/pipelinelog/joblog share ONE shell route name with three URL patterns dispatched by inner hash. **The new homepage routes don't need a symmetric branch**: each surface has its OWN outer route name (`homepageShelves`, `homepageRedirects`, `homepageConfig`), so `_onRouteMatched` sets `sNavKey` correctly from the matched route name without sniffing. No change to `_onRouteMatched` required.

### 4.5 PATCH /admin/HomepageConfig fails

Standard Fiori Elements behavior shows the framework error toast. No custom handling needed. CSRF, authentication, server errors — all already covered by the admin-shell's auth wiring.

## 5. Testing

### 5.1 Unit tests

**Added:** `test/unit/admin-shell-homepage-nav.test.ts` — text-grep test pinning the structural invariants across the three modified files:

```ts
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'

const SHELL_DIR = path.resolve(import.meta.dirname, '../../app/admin-shell/webapp')

describe('admin-shell homepage nav surfaces Shelves + Redirects + Config (#734)', () => {
  describe('navigation.json', () => {
    const nav = JSON.parse(readFileSync(path.join(SHELL_DIR, 'model/navigation.json'), 'utf8'))

    it('has a top-level Homepage group with three children', () => {
      const group = nav.groups.find((g: any) => g.key === 'homepageGroup')
      expect(group).toBeTruthy()
      expect(group.items.map((i: any) => i.key)).toEqual([
        'homepageShelves', 'homepageRedirects', 'homepageConfig',
      ])
    })

    it('no longer has the legacy single "homepage" nav-key', () => {
      const allKeys = nav.groups.flatMap((g: any) => [g.key, ...(g.items || []).map((i: any) => i.key)])
      expect(allKeys).not.toContain('homepage')
    })
  })

  describe('manifest.json', () => {
    const manifest = JSON.parse(readFileSync(path.join(SHELL_DIR, 'manifest.json'), 'utf8'))
    const routes = manifest['sap.ui5'].routing.routes

    it('has three homepage* routes, all targeting homepageTarget', () => {
      const homepageRoutes = routes.filter((r: any) => r.name.startsWith('homepage'))
      expect(homepageRoutes.map((r: any) => r.name).sort()).toEqual([
        'homepageConfig', 'homepageRedirects', 'homepageShelves',
      ])
      for (const r of homepageRoutes) {
        const targets = Array.isArray(r.target) ? r.target : [r.target]
        const targetName = typeof targets[0] === 'string' ? targets[0] : targets[0].name
        expect(targetName).toBe('homepageTarget')
      }
    })
  })

  describe('Shell.controller.js', () => {
    const ctrl = readFileSync(path.join(SHELL_DIR, 'controller/Shell.controller.js'), 'utf8')

    it('maps the three new nav-keys in NAV_KEY_TO_ROUTE', () => {
      expect(ctrl).toMatch(/homepageShelves:\s*"homepageShelves"/)
      expect(ctrl).toMatch(/homepageRedirects:\s*"homepageRedirects"/)
      expect(ctrl).toMatch(/homepageConfig:\s*"homepageConfig"/)
    })

    it('has titles for the three new nav-keys', () => {
      expect(ctrl).toMatch(/homepageShelves:\s*"Homepage Shelves"/)
      expect(ctrl).toMatch(/homepageRedirects:\s*"Homepage Redirects"/)
      expect(ctrl).toMatch(/homepageConfig:\s*"Homepage Config"/)
    })

    it('pushes the inner hash for Redirects and Config (pipelinelog/joblog precedent)', () => {
      expect(ctrl).toMatch(/setHash\("homepageRedirects&\/hp\/Redirects"\)/)
      expect(ctrl).toMatch(/setHash\("homepageConfig&\/hp\/Config"\)/)
    })

    it('drops the legacy single "homepage" nav-key mapping', () => {
      expect(ctrl).not.toMatch(/^\s*homepage:\s*"homepage"/m)
    })
  })
})
```

### 5.2 Smoke tests

**Added:** `test/smoke/admin-homepage-config.smoke.test.js`:

```js
import { describe, it, expect } from 'vitest';
import { BASE_URL, SRV_URL, fetchWithRetry } from './smoke.config.js';
// Plus admin-auth bootstrap from existing smoke harness.

describe('/admin/HomepageConfig — singleton accessible via admin shell (#734)', () => {
  it('admin-shell loads', async () => {
    const r = await fetchWithRetry(`${BASE_URL}/admin-ui/`);
    expect(r.status).toBe(200);
  });

  it('GET /admin/HomepageConfig returns the singleton with all four fields', async () => {
    // Admin auth bootstrap — reuse the pattern in test/smoke/admin-*.smoke.test.js
    const r = await adminFetch(`${SRV_URL}/admin/HomepageConfig`);
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body).toHaveProperty('developerNewsPlaylistId');
    expect(body).toHaveProperty('videoBandEnabled');
    expect(body).toHaveProperty('eventsBandEnabled');
    expect(body).toHaveProperty('communityLaneEnabled');
  });
});
```

(Exact admin-auth boilerplate copied from the existing admin-* smoke tests during implementation.)

### 5.3 Hybrid tests

No change. `HomepageConfig` already has hybrid coverage from #639 work.

### 5.4 Manual smoke after deploy

1. Load `/admin-ui/` — observe new "Homepage" group in the side nav with three child entries.
2. Click "Homepage > Shelves" — lands on the existing shelf list (no regression).
3. Click "Homepage > Redirects" — lands on the legacy-redirects list.
4. Click "Homepage > Config" — singleton ObjectPage with the four fields.
5. Edit `developerNewsPlaylistId`, save — refresh, verify persistence.
6. Wait ~15 min, reload the homepage `/` — verify the new playlist drives the YouTube band.
7. Toggle `videoBandEnabled` off, save — wait ~60s, reload `/`, verify the band disappears. Toggle back on, verify restoration.

## 6. Migration / rollout

Single PR. No data migration. No feature flag. Worst-case rollback is `git revert` + redeploy.

The old `#homepage` URL still resolves: in the new manifest, the `homepageShelves` shell route has `pattern: "homepage"` (matching the old URL), so any bookmark or external link pointing at `/admin-ui/#homepage` continues to land on the Shelves list.

## 7. References

- Issue [#734](https://github.com/sap-tutorials/tutorials-ims/issues/734)
- Phase 4 spec [`2026-06-27-639-developer-homepage-design.md`](./2026-06-27-639-developer-homepage-design.md) — the spec that introduced `HomepageConfig` without an admin surface
- PR [#701](https://github.com/sap-tutorials/tutorials-ims/pull/701) — YouTube playlist config (exposed the gap)
- Existing precedent: `Shell.controller.js:119-124` (`operations` / `pipelinelog` / `joblog`) — one Component, three nav entries, two `setHash` calls
- Existing precedent: `feedbackList` / `feedbackDashboard` under the "Feedback" nav group — multiple nav entries serving related concerns
