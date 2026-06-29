# Issue #734 — Surface HomepageConfig + Redirects in Admin Shell: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `HomepageConfig` (singleton with `developerNewsPlaylistId` + three feature flags) and `LegacyRedirects` reachable from the admin side nav. They're already wired in the Fiori component manifest but have no nav entry.

**Architecture:** Replicate the existing `operations` / `pipelinelog` / `joblog` precedent — three shell-level routes (`homepageShelves`, `homepageRedirects`, `homepageConfig`) all targeting the existing `homepageTarget` Component, distinguished by `HashChanger.setHash()` calls after `router.navTo()` to push the inner Component's hash. New top-level "Homepage" nav group with three children.

**Tech Stack:** UI5 1.136, Fiori Elements V4, vanilla JS controllers (no TypeScript in admin-shell), vitest for unit + smoke tests.

**Spec:** [`docs/superpowers/specs/2026-06-29-734-homepage-config-admin-surface-design.md`](../specs/2026-06-29-734-homepage-config-admin-surface-design.md)

---

## File Structure

### Modified files (3)

- `app/admin-shell/webapp/model/navigation.json` — remove the existing single homepage nav entry from the Content group; insert a new top-level "Homepage" group with three children (Shelves, Redirects, Config) between Content and Rewards.
- `app/admin-shell/webapp/manifest.json` — replace the single `homepage` shell route with three: `homepageShelves`, `homepageRedirects`, `homepageConfig`, all targeting the existing `homepageTarget`.
- `app/admin-shell/webapp/controller/Shell.controller.js` — drop the single `homepage` entry from `NAV_KEY_TO_ROUTE` + `NAV_KEY_TO_TITLE`; add three new entries to each; add two `setHash` calls in `onNavItemSelect` for the two non-default routes.

### Added files (2)

- `test/unit/admin-shell-homepage-nav.test.ts` — text-grep test pinning the structural invariants across all three modified files.
- `test/smoke/admin-homepage-config.smoke.test.js` — smoke test for the deployed approuter + srv: `/admin-ui/` loads (XSUAA-gated, expect 401/302/HTML-redirect), and `/admin/HomepageConfig` is reachable (authentication-shape assertion).

### NOT modified

- `app/admin/homepage/webapp/manifest.json` — already has all three inner routes (`ShelvesList`, `RedirectsList`, `ConfigOP`).
- `srv/admin-service.cds` — `HomepageConfig` already exposed as `@odata.singleton`.
- `srv/admin-service.js` — singleton auto-init `before('READ')` handler already in place.
- `app/admin-annotations.cds` — `HomepageConfig` already has full UI annotations.
- `app/admin-shell/webapp/i18n/i18n.properties` — titles bind `{nav>title}` directly from the JSON model (literals, not i18n keys).

---

## Task 1: Add new "Homepage" nav group to `navigation.json`

**Files:**
- Modify: `app/admin-shell/webapp/model/navigation.json`

The current Content group has 11 items, with `homepage` being the last one (line 24). We remove that single entry and insert a new top-level group between Content and Rewards (insert after the `},` that closes the Content group).

- [ ] **Step 1: Read the file**

```bash
cd D:/projects/tutorials-poc/.claude/worktrees/734-homepage-config-ui
sed -n '10,30p' app/admin-shell/webapp/model/navigation.json
```

Expected: see the Content group with `homepage` as the last item, then the Rewards group starting.

- [ ] **Step 2: Edit the file with two surgical changes**

**(a)** Remove the `homepage` entry from the Content group's items array. Change:

```json
        { "key": "alerts", "title": "Alerts" },
        { "key": "homepage", "title": "Homepage" }
      ]
    },
```

to:

```json
        { "key": "alerts", "title": "Alerts" }
      ]
    },
```

(Note: `Alerts` no longer has a trailing comma after the entry's closing `}`.)

**(b)** Insert a new top-level group immediately AFTER the Content group's closing `},` and BEFORE the Rewards group's opening `{`:

```json
    {
      "key": "homepageGroup",
      "title": "Homepage",
      "icon": "sap-icon://home",
      "items": [
        { "key": "homepageShelves",   "title": "Shelves" },
        { "key": "homepageRedirects", "title": "Redirects" },
        { "key": "homepageConfig",    "title": "Config" }
      ]
    },
```

- [ ] **Step 3: Validate JSON**

Run:
```bash
node -e "JSON.parse(require('fs').readFileSync('app/admin-shell/webapp/model/navigation.json','utf8')); console.log('OK')"
```

Expected: `OK`.

- [ ] **Step 4: Spot-check the resulting structure**

Run:
```bash
node -e "const n=JSON.parse(require('fs').readFileSync('app/admin-shell/webapp/model/navigation.json','utf8')); const g=n.groups.find(x=>x.key==='homepageGroup'); console.log('homepageGroup items:', g && g.items.map(i=>i.key).join(',')); console.log('content has homepage?', n.groups.find(x=>x.key==='content').items.some(i=>i.key==='homepage'));"
```

Expected:
```
homepageGroup items: homepageShelves,homepageRedirects,homepageConfig
content has homepage? false
```

- [ ] **Step 5: Commit**

```bash
git add app/admin-shell/webapp/model/navigation.json
git -c core.autocrlf=false commit -m "feat(#734): add Homepage nav group with Shelves/Redirects/Config

Removes the single 'homepage' entry from the Content group and
introduces a top-level Homepage group between Content and Rewards
with three children mapping to the homepage Fiori component's
existing inner routes (ShelvesList, RedirectsList, ConfigOP)."
```

---

## Task 2: Add three shell routes to `manifest.json`

**Files:**
- Modify: `app/admin-shell/webapp/manifest.json` (line 310 — the existing `homepage` route)

We replace the single `homepage` shell route with three routes, all targeting the existing `homepageTarget` (so the homepage Component is mounted exactly once regardless of which surface the user navigates to). The pattern `homepage` stays on the `homepageShelves` route to preserve backward compatibility with the old `#homepage` URL.

- [ ] **Step 1: Find the existing homepage route line**

Run:
```bash
grep -n '"name": "homepage"' app/admin-shell/webapp/manifest.json
```

Expected: one line showing the current `homepage` route declaration (line ~310).

- [ ] **Step 2: Edit the file**

Locate the line:

```json
        { "name": "homepage", "pattern": "homepage", "target": [{"name": "homepageTarget", "prefix": "hp"}] },
```

Replace with three lines:

```json
        { "name": "homepageShelves", "pattern": "homepage", "target": [{"name": "homepageTarget", "prefix": "hp"}] },
        { "name": "homepageRedirects", "pattern": "homepageRedirects", "target": [{"name": "homepageTarget", "prefix": "hp"}] },
        { "name": "homepageConfig", "pattern": "homepageConfig", "target": [{"name": "homepageTarget", "prefix": "hp"}] },
```

The first route keeps the old URL pattern (`"pattern": "homepage"`) so existing bookmarks land on Shelves. The other two use new pattern names matching their route names.

- [ ] **Step 3: Validate JSON**

Run:
```bash
node -e "JSON.parse(require('fs').readFileSync('app/admin-shell/webapp/manifest.json','utf8')); console.log('OK')"
```

Expected: `OK`.

- [ ] **Step 4: Verify the three routes exist and all target homepageTarget**

Run:
```bash
node -e "const m=JSON.parse(require('fs').readFileSync('app/admin-shell/webapp/manifest.json','utf8')); const rs=m['sap.ui5'].routing.routes.filter(r=>r.name.startsWith('homepage')); for (const r of rs) { const t = Array.isArray(r.target) ? r.target[0] : r.target; console.log(r.name, '->', typeof t === 'string' ? t : t.name); }"
```

Expected:
```
homepageShelves -> homepageTarget
homepageRedirects -> homepageTarget
homepageConfig -> homepageTarget
```

- [ ] **Step 5: Commit**

```bash
git add app/admin-shell/webapp/manifest.json
git -c core.autocrlf=false commit -m "feat(#734): add three shell routes for homepage surfaces

Replaces the single 'homepage' shell route with three siblings —
homepageShelves (keeps the old 'homepage' pattern for bookmark
compatibility), homepageRedirects, and homepageConfig — all
targeting the existing homepageTarget. Mirrors the established
operations/pipelinelog/joblog precedent: one Component, multiple
nav entries."
```

---

## Task 3: Update `Shell.controller.js` nav-key maps and `setHash` calls

**Files:**
- Modify: `app/admin-shell/webapp/controller/Shell.controller.js` (lines ~10-46 for NAV_KEY_TO_ROUTE, lines ~47-90 for NAV_KEY_TO_TITLE, lines 117-124 for onNavItemSelect)

- [ ] **Step 1: Confirm the three location landmarks**

Run:
```bash
grep -n "homepage: \"homepage\"\|homepage: \"Homepage\"\|setHash" app/admin-shell/webapp/controller/Shell.controller.js
```

Expected: at least four hits — the `homepage` entries in both NAV_KEY_TO_ROUTE and NAV_KEY_TO_TITLE, plus the two existing `setHash` calls for `pipelinelog` and `joblog`.

- [ ] **Step 2: Update NAV_KEY_TO_ROUTE**

Locate the line in `Shell.controller.js`:

```js
    homepage: "homepage",
```

Replace with three lines:

```js
    homepageShelves: "homepageShelves",
    homepageRedirects: "homepageRedirects",
    homepageConfig: "homepageConfig",
```

- [ ] **Step 3: Update NAV_KEY_TO_TITLE**

Locate the line:

```js
    homepage: "Homepage",
```

Replace with three lines:

```js
    homepageShelves: "Homepage Shelves",
    homepageRedirects: "Homepage Redirects",
    homepageConfig: "Homepage Config",
```

- [ ] **Step 4: Add the two `setHash` calls in `onNavItemSelect`**

Locate the existing pipelinelog/joblog block (lines 119-124):

```js
      var sRoute = NAV_KEY_TO_ROUTE[sKey];
      if (sRoute) {
        this.getOwnerComponent().getRouter().navTo(sRoute);
        if (sKey === "pipelinelog") {
          HashChanger.getInstance().setHash("pipelinelog&/op/PipelineLog");
        }
        if (sKey === "joblog") {
          HashChanger.getInstance().setHash("joblog&/op/JobExecutionLog");
        }
      }
```

Insert two new `if` blocks immediately after the `joblog` block, BEFORE the closing `}` of the `if (sRoute)` block:

```js
        if (sKey === "homepageRedirects") {
          HashChanger.getInstance().setHash("homepageRedirects&/hp/Redirects");
        }
        if (sKey === "homepageConfig") {
          HashChanger.getInstance().setHash("homepageConfig&/hp/Config");
        }
```

`homepageShelves` does NOT need a setHash — the inner Component's empty pattern (`:?query:`) defaults to `ShelvesList`.

- [ ] **Step 5: Spot-check the file**

Run:
```bash
grep -n "homepage" app/admin-shell/webapp/controller/Shell.controller.js
```

Expected (approximate line numbers):
```
20:    homepageShelves: "homepageShelves",
21:    homepageRedirects: "homepageRedirects",
22:    homepageConfig: "homepageConfig",
58:    homepageShelves: "Homepage Shelves",
59:    homepageRedirects: "Homepage Redirects",
60:    homepageConfig: "Homepage Config",
125:        if (sKey === "homepageRedirects") {
126:          HashChanger.getInstance().setHash("homepageRedirects&/hp/Redirects");
128:        if (sKey === "homepageConfig") {
129:          HashChanger.getInstance().setHash("homepageConfig&/hp/Config");
```

And NO line containing `homepage: "homepage"` or `homepage: "Homepage"` should remain.

Verify with:
```bash
grep -E '^\s+homepage:\s+"' app/admin-shell/webapp/controller/Shell.controller.js
```

Expected: zero results.

- [ ] **Step 6: Commit**

```bash
git add app/admin-shell/webapp/controller/Shell.controller.js
git -c core.autocrlf=false commit -m "feat(#734): wire homepage nav-keys to inner Component routes

Drops the single 'homepage' nav-key from NAV_KEY_TO_ROUTE and
NAV_KEY_TO_TITLE; adds three new entries (homepageShelves,
homepageRedirects, homepageConfig). Adds two setHash calls in
onNavItemSelect for Redirects and Config that push the inner
homepage Component's hash — same pattern as the existing
pipelinelog/joblog handlers (lines 119-124).

homepageShelves needs no setHash: the inner Component's empty
pattern defaults to ShelvesList."
```

---

## Task 4: Add unit test pinning the structural invariants

**Files:**
- Create: `test/unit/admin-shell-homepage-nav.test.ts`

Text-grep test asserting all three modified files have the right shape. Same testing approach as `test/unit/hugo/explore-layout.test.ts` in #744 — text-pin structural invariants when there's no runtime test harness for the framework (UI5 in this case).

- [ ] **Step 1: Write the test file**

Create `test/unit/admin-shell-homepage-nav.test.ts`:

```ts
// Text-grep test for the admin-shell wiring that surfaces Homepage Shelves,
// Redirects, and Config (issue #734). The admin-shell is UI5 and has no
// OPA / unit-test harness in this repo, so we pin structural invariants
// across the three modified files. Same approach as the explore-layout
// text-pin in #744.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'

const SHELL_DIR = path.resolve(import.meta.dirname, '../../app/admin-shell/webapp')

describe('admin-shell homepage nav surfaces Shelves + Redirects + Config (#734)', () => {
  describe('navigation.json', () => {
    const nav = JSON.parse(readFileSync(path.join(SHELL_DIR, 'model/navigation.json'), 'utf8'))

    it('has a top-level "homepageGroup" group with three children in the right order', () => {
      const group = nav.groups.find((g: any) => g.key === 'homepageGroup')
      expect(group, 'homepageGroup must exist at top level').toBeTruthy()
      expect(group.items.map((i: any) => i.key)).toEqual([
        'homepageShelves', 'homepageRedirects', 'homepageConfig',
      ])
    })

    it('homepageGroup has a home icon and the Homepage title', () => {
      const group = nav.groups.find((g: any) => g.key === 'homepageGroup')
      expect(group.icon).toBe('sap-icon://home')
      expect(group.title).toBe('Homepage')
    })

    it('drops the legacy single "homepage" nav-key from anywhere in the tree', () => {
      const allKeys = nav.groups.flatMap(
        (g: any) => [g.key, ...(g.items || []).map((i: any) => i.key)]
      )
      expect(allKeys).not.toContain('homepage')
    })
  })

  describe('manifest.json', () => {
    const manifest = JSON.parse(readFileSync(path.join(SHELL_DIR, 'manifest.json'), 'utf8'))
    const routes = manifest['sap.ui5'].routing.routes

    it('has three homepage* routes — and only three', () => {
      const homepageRoutes = routes.filter((r: any) => r.name.startsWith('homepage'))
      expect(homepageRoutes.map((r: any) => r.name).sort()).toEqual([
        'homepageConfig', 'homepageRedirects', 'homepageShelves',
      ])
    })

    it('all three homepage routes target homepageTarget with prefix "hp"', () => {
      const homepageRoutes = routes.filter((r: any) => r.name.startsWith('homepage'))
      for (const r of homepageRoutes) {
        const targets = Array.isArray(r.target) ? r.target : [r.target]
        const target = typeof targets[0] === 'string' ? { name: targets[0] } : targets[0]
        expect(target.name, `${r.name} target`).toBe('homepageTarget')
        if (target.prefix !== undefined) {
          expect(target.prefix, `${r.name} prefix`).toBe('hp')
        }
      }
    })

    it('homepageShelves keeps the legacy "homepage" URL pattern (backward compat)', () => {
      const r = routes.find((x: any) => x.name === 'homepageShelves')
      expect(r.pattern).toBe('homepage')
    })

    it('has no legacy single "homepage" route name', () => {
      expect(routes.find((r: any) => r.name === 'homepage')).toBeUndefined()
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
      // Note: NAV_KEY_TO_TITLE uses "Homepage Shelves" / "Homepage Redirects" /
      // "Homepage Config" (used as the page-header / document title), while
      // navigation.json uses the shorter "Shelves" / "Redirects" / "Config"
      // (used as the side-nav leaf label). The divergence is intentional:
      // the parent "Homepage" group label in the nav already provides the
      // prefix context, whereas the page header stands alone.
      expect(ctrl).toMatch(/homepageShelves:\s*"Homepage Shelves"/)
      expect(ctrl).toMatch(/homepageRedirects:\s*"Homepage Redirects"/)
      expect(ctrl).toMatch(/homepageConfig:\s*"Homepage Config"/)
    })

    it('pushes the inner hash for Redirects and Config (pipelinelog/joblog precedent)', () => {
      expect(ctrl).toMatch(/setHash\("homepageRedirects&\/hp\/Redirects"\)/)
      expect(ctrl).toMatch(/setHash\("homepageConfig&\/hp\/Config"\)/)
    })

    it('does NOT setHash for homepageShelves (defaults to inner ShelvesList route)', () => {
      // Catches a future contributor copy-paste-ing an unnecessary setHash.
      expect(ctrl).not.toMatch(/setHash\("homepageShelves/)
    })

    it('drops the legacy single "homepage" nav-key mapping', () => {
      // The new keys (homepageShelves, etc.) include "homepage" as a prefix,
      // but the legacy `homepage: "homepage"` exact mapping must be gone.
      expect(ctrl).not.toMatch(/^\s+homepage:\s+"homepage"\s*,?\s*$/m)
      expect(ctrl).not.toMatch(/^\s+homepage:\s+"Homepage"\s*,?\s*$/m)
    })
  })

  describe('cross-file consistency', () => {
    // The side-nav highlight requires `selectedNavKey` (set by
    // _onRouteMatched from the matched route name) to match a key that
    // exists somewhere in navigation.json's items. Drift between the
    // three files breaks the highlight silently — pin that the three
    // route names appearing in manifest.json all exist as nav-keys.
    const nav = JSON.parse(readFileSync(path.join(SHELL_DIR, 'model/navigation.json'), 'utf8'))
    const manifest = JSON.parse(readFileSync(path.join(SHELL_DIR, 'manifest.json'), 'utf8'))

    it('every homepage* route name has a matching nav-key in navigation.json', () => {
      const navKeys = new Set(
        nav.groups.flatMap((g: any) => [g.key, ...(g.items || []).map((i: any) => i.key)])
      )
      const homepageRoutes = manifest['sap.ui5'].routing.routes
        .filter((r: any) => r.name.startsWith('homepage'))
      for (const r of homepageRoutes) {
        expect(navKeys, `route name "${r.name}" must exist as a nav-key for the side-nav highlight to work`).toContain(r.name)
      }
    })
  })
})
```

- [ ] **Step 2: Run the test**

Run:
```bash
npx vitest run test/unit/admin-shell-homepage-nav.test.ts
```

Expected: all 12 cases pass (3 in navigation.json describe, 4 in manifest.json describe, 4 in Shell.controller.js describe, 1 in cross-file consistency describe). (Tasks 1-3 already made the assertions true.)

If any case fails, the fix lives in the corresponding modified file — DO NOT relax the assertion; fix the structural mismatch.

- [ ] **Step 3: Commit**

```bash
git add test/unit/admin-shell-homepage-nav.test.ts
git -c core.autocrlf=false commit -m "test(#734): pin admin-shell homepage nav structural invariants

Text-grep test across navigation.json, manifest.json, and
Shell.controller.js asserting:
- The new homepageGroup with three children exists in nav.
- Three shell routes target the same homepageTarget.
- homepageShelves keeps the legacy 'homepage' URL pattern.
- The two setHash calls for Redirects + Config are wired.
- The legacy single 'homepage' nav-key is gone.
- Every homepage* shell-route name has a matching nav-key
  (catches drift that would break the side-nav highlight).

UI5 has no runtime test harness in this repo; text-pinning the
shape catches future drift the same way the explore-layout test
does for #744."
```

---

## Task 5: Add smoke test for the deployed approuter + srv

**Files:**
- Create: `test/smoke/admin-homepage-config.smoke.test.js`

Confirms the deployed approuter serves `/admin-ui/` (XSUAA-gated, like all other admin-* smoke tests) and that the `HomepageConfig` singleton route exists on srv. The actual content-load happens after XSUAA login, which the smoke harness can't bypass without a tech-user token — we follow the existing `admin-exports.smoke.test.js` pattern.

- [ ] **Step 1: Write the test file**

Create `test/smoke/admin-homepage-config.smoke.test.js`:

```js
// Smoke test for issue #734 — the admin-shell surfaces HomepageConfig +
// Redirects + Shelves via three top-level nav entries.
//
// Pattern: matches admin-exports.smoke.test.js (the established admin smoke
// test shape). XSUAA gates /admin/* and /admin-ui/* — anonymous requests
// resolve to 401 / 302 / HTML-redirect to /oauth/authorize. With a
// SMOKE_ADMIN_TOKEN env var (tech user), we can hit the OData singleton
// directly and assert the four-field shape.

import { describe, it, expect } from 'vitest';

const APPROUTER = process.env.SMOKE_BASE_URL;
const SRV       = process.env.SMOKE_SRV_URL;

describe.runIf(APPROUTER && SRV)('admin homepage config smoke (#734)', () => {
  it('rejects anonymous request to approuter /admin-ui/ (401, 302, or JS-redirect to XSUAA)', async () => {
    const res = await fetch(`${APPROUTER}/admin-ui/`, { redirect: 'manual' });
    if (res.status === 200) {
      const body = await res.text();
      expect(body).toMatch(/\/oauth\/authorize/);
    } else {
      expect([401, 302]).toContain(res.status);
    }
  });

  it('rejects anonymous request to /admin/HomepageConfig (401, 302, or JS-redirect)', async () => {
    // Hit srv directly. The OData v4 singleton URL must not return 200 with
    // data for an anonymous client. We confirm the route is gated, not what
    // it returns when authenticated.
    const res = await fetch(`${SRV}/admin/HomepageConfig`, { redirect: 'manual' });
    if (res.status === 200) {
      const body = await res.text();
      expect(body).toMatch(/\/oauth\/authorize/);
    } else {
      expect([401, 302]).toContain(res.status);
    }
  });

  // With an admin tech token, hit srv directly and confirm the singleton
  // returns the four expected fields. Tracks the admin-exports.smoke.test.js
  // convention (SMOKE_ADMIN_TOKEN), so this branch runs only in environments
  // that provide a token.
  const ADMIN_TOKEN = process.env.SMOKE_ADMIN_TOKEN;
  describe.runIf(ADMIN_TOKEN)('with admin token', () => {
    it('GET /admin/HomepageConfig: 200 with all four fields', async () => {
      const res = await fetch(`${SRV}/admin/HomepageConfig`, {
        headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
      });
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toMatch(/application\/json/);
      const body = await res.json();
      // Singleton must always have these four fields (auto-init handler
      // creates the row with defaults if missing — srv/admin-service.js).
      expect(body).toHaveProperty('developerNewsPlaylistId');
      expect(body).toHaveProperty('videoBandEnabled');
      expect(body).toHaveProperty('eventsBandEnabled');
      expect(body).toHaveProperty('communityLaneEnabled');
      // Flags are booleans by spec; playlist ID is a nullable string.
      expect(typeof body.videoBandEnabled).toBe('boolean');
      expect(typeof body.eventsBandEnabled).toBe('boolean');
      expect(typeof body.communityLaneEnabled).toBe('boolean');
    });
  });
});
```

- [ ] **Step 2: Run the test against the current local env (it will be auto-skipped)**

Run:
```bash
npx vitest run test/smoke/admin-homepage-config.smoke.test.js
```

Expected: skipped (no `SMOKE_BASE_URL` env var locally). The test exists for CI / post-deploy verification — running it locally just confirms the file parses and `describe.runIf` short-circuits cleanly.

- [ ] **Step 3: Commit**

```bash
git add test/smoke/admin-homepage-config.smoke.test.js
git -c core.autocrlf=false commit -m "test(#734): smoke test for admin /admin-ui/ + HomepageConfig

Asserts the deployed approuter gates /admin-ui/ and /admin/HomepageConfig
with XSUAA (anonymous: 401/302/JS-redirect), and — when a
SMOKE_ADMIN_TOKEN tech-user token is supplied — that the singleton
returns the four expected fields (developerNewsPlaylistId plus three
feature flags).

Pattern mirrors admin-exports.smoke.test.js — same describe.runIf
conditional structure, same token convention."
```

---

## Task 6: Verify the admin-shell build still works

**Files:** none (verification task)

The admin-shell uses `npm run build:admin` which delegates to `npm --prefix app/admin-shell run build`. We need to confirm the manifest changes survive a fresh build.

- [ ] **Step 1: Run the admin-shell build**

Run:
```bash
npm run build:admin 2>&1 | tail -10
```

Expected: build succeeds. If a UI5 manifest validator runs during the build, it will catch JSON schema violations in our edits.

- [ ] **Step 2: Locate the built manifest**

UI5 builds sometimes nest the manifest under `dist/resources/<namespace>/`. Find it:

```bash
find app/admin-shell/dist -name manifest.json -not -path "*/node_modules/*" 2>/dev/null
```

Expected: one or more lines pointing at the built manifest(s). Pick the one that's a direct copy of `webapp/manifest.json` — it'll be either `app/admin-shell/dist/manifest.json` (typical) or `app/admin-shell/dist/resources/sap/tutorials/admin/shell/manifest.json` (nested namespace layout). Set `MANIFEST_PATH` to that path for the next step.

- [ ] **Step 3: Inspect the built manifest's homepage routes**

Substitute the path from Step 2:

```bash
MANIFEST_PATH="app/admin-shell/dist/manifest.json"   # or the nested path from Step 2
node -e "const m=JSON.parse(require('fs').readFileSync('$MANIFEST_PATH','utf8')); console.log(m['sap.ui5'].routing.routes.filter(r=>r.name.startsWith('homepage')).map(r=>r.name).sort().join(','))"
```

Expected: `homepageConfig,homepageRedirects,homepageShelves`

- [ ] **Step 4: Verify the built navigation.json**

```bash
find app/admin-shell/dist -name navigation.json -not -path "*/node_modules/*" 2>/dev/null
NAV_PATH="app/admin-shell/dist/model/navigation.json"  # or the discovered path
node -e "const n=JSON.parse(require('fs').readFileSync('$NAV_PATH','utf8')); const g=n.groups.find(x=>x.key==='homepageGroup'); console.log(g && g.items.map(i=>i.key).join(','));"
```

Expected: `homepageShelves,homepageRedirects,homepageConfig`

- [ ] **Step 5: No commit (verification only)**

If anything fails, fix the source (Tasks 1-3) and re-run. Otherwise proceed.

---

## Task 7: Open the PR

**Files:** none

- [ ] **Step 1: Push the branch**

```bash
git push -u origin 734-homepage-config-ui
```

- [ ] **Step 2: Write the PR body file**

First, write `PR_BODY.md` at the repo root (we'll delete it after the PR opens; it isn't committed):

```bash
cat > PR_BODY.md << 'PR_BODY_EOF'
Closes #734.

## What

Adds a top-level **Homepage** nav group to the admin shell with three child entries — Shelves, Redirects, Config — so admins can edit the `HomepageConfig` singleton (Developer News playlist ID + three band feature flags) without HANA access, and can reach the previously-unreachable `LegacyRedirects` list.

The Fiori component already had all three inner routes wired (`ShelvesList`, `RedirectsList`, `ConfigOP`); we just made them reachable.

## Spec & plan

- Spec: [docs/superpowers/specs/2026-06-29-734-homepage-config-admin-surface-design.md](docs/superpowers/specs/2026-06-29-734-homepage-config-admin-surface-design.md)
- Plan: [docs/superpowers/plans/2026-06-29-734-homepage-config-admin-surface.md](docs/superpowers/plans/2026-06-29-734-homepage-config-admin-surface.md)

## How

- Add a top-level Homepage nav group to `navigation.json` (icon: home, between Content and Rewards), replacing the single 'homepage' entry that was buried under Content.
- Replace the single 'homepage' shell route with three (homepageShelves / homepageRedirects / homepageConfig), all targeting the existing `homepageTarget` Component.
- Wire `Shell.controller.js` — three entries each in `NAV_KEY_TO_ROUTE` and `NAV_KEY_TO_TITLE`, plus two `HashChanger.setHash` calls in `onNavItemSelect` for Redirects + Config (replicates the existing pipelinelog/joblog precedent on lines 119-124).
- Keep `pattern: "homepage"` on the new `homepageShelves` route so existing `#homepage` bookmarks continue to work.

## Backward compatibility

The old `/admin-ui/#homepage` URL still resolves — the new `homepageShelves` route's pattern is `homepage`, so bookmarks and external links land on the Shelves list unchanged.

## Tests

- New: `test/unit/admin-shell-homepage-nav.test.ts` — 12 text-grep assertions pinning the structural invariants across all three modified files, including a cross-file consistency check that every shell-route name has a matching nav-key.
- New: `test/smoke/admin-homepage-config.smoke.test.js` — XSUAA-gate assertions on `/admin-ui/` and `/admin/HomepageConfig`, plus a tech-token-gated assertion on the singleton's four-field shape.

## Rollback

`git revert` + redeploy. No data migration. No feature flag.

## Manual smoke after deploy

1. Load `/admin-ui/` — see new 'Homepage' group in the side nav with three children.
2. Click each child — Shelves / Redirects / Config each render their existing Fiori Elements view.
3. On Config: edit `developerNewsPlaylistId`, save, refresh — value persists.
4. Wait ~15 min, reload `/` — new playlist drives the YouTube band on the homepage.
5. Toggle `videoBandEnabled` off, wait ~60s, reload `/` — band disappears. Toggle back, verify restoration.
PR_BODY_EOF
```

Verify the file exists:

```bash
ls -l PR_BODY.md && wc -l PR_BODY.md
```

Expected: a non-empty file with ~40 lines.

- [ ] **Step 3: Create the PR**

```bash
gh pr create --base main --head 734-homepage-config-ui \
  --title "feat(#734): surface HomepageConfig + Redirects in admin shell" \
  --body-file ./PR_BODY.md
```

- [ ] **Step 4: Remove the body file (do NOT commit it)**

```bash
rm PR_BODY.md
```

- [ ] **Step 5: Verify CI green**

Watch the standard CI run. Expected: green. If anything fails, address before merging.

---

## Task 8: Post-merge deploy + verify

After PR merge, deploy from `main` in the **primary tree** (per memory [[feedback_always_deploy_from_main_primary_tree.md]]):

- [ ] **Step 1: Switch to primary tree, pull main**

```bash
cd D:/projects/tutorials-poc
git checkout main
git pull --ff-only origin main
```

- [ ] **Step 2: Verify CF target**

```bash
cf target
```

Expected: DEV space. If wrong, surface and STOP before deploying.

- [ ] **Step 3: Build + redeploy (full MTA — default safe path)**

```bash
cd D:/projects/tutorials-poc
npm run build:all
cd .deploy && mbt build && cf deploy mta_archives/*.mtar -e ../deploy/dev.mtaext -f
```

- [ ] **Step 4: Probe the deployed admin shell**

```bash
curl -s https://tutorial-system-dev-tutorials-approuter.cfapps.eu10-005.hana.ondemand.com/admin-ui/ -o /dev/null -w "%{http_code}\n"
```

Expected: 200 or 302 (XSUAA redirect). NOT 404, NOT 500.

- [ ] **Step 5: Manual smoke per the PR body**

Walk Tom through the 5-item manual smoke. Confirm before closing the PR.

---

## Notes / hazards

- **The `_onRouteMatched` hash-sniffing branch for operations is NOT mirrored for homepage** — and it shouldn't be. Each homepage surface has its own outer route name (`homepageShelves`, `homepageRedirects`, `homepageConfig`), so `_onRouteMatched` resolves `sNavKey` from the route name directly. The operations precedent uses ONE route name with multiple URL patterns; we use multiple route names. Don't add a symmetric branch.
- **Pattern collision is impossible** because the new patterns (`homepageRedirects`, `homepageConfig`) are unique strings not used by any existing route, and the legacy `homepage` pattern moves to `homepageShelves` (one-to-one).
- **No i18n changes needed** — the side nav binds `{nav>title}` directly from the JSON model (verified in `Shell.view.xml:75,82`). Titles are literals.
- **CRLF on Windows:** all commits use `git -c core.autocrlf=false commit` per memory [[feedback_crlf_regression_on_windows]].
- **Work in the worktree; deploy from primary tree.** Tasks 1-7 run in `D:/projects/tutorials-poc/.claude/worktrees/734-homepage-config-ui`; Task 8 runs in `D:/projects/tutorials-poc` against `main`.
- **No new backend code.** The CDS singleton, auto-init handler, and UI annotations already exist. If you find yourself adding code to `srv/admin-service.js` or `app/admin-annotations.cds`, stop — that's scope creep.
