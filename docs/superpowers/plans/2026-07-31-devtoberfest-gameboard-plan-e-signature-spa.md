# Devtoberfest Gameboard — Plan E: Signature-Builder SPA Port

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Port the standalone SAP Community "profile / badge-signature" Vue SPA (source: `D:\projects\sap-community-activity-badges\srv\app\profile-vue\`) into the new `sap-community-gameboard` MTA at `app/community-profile/`, served at `/community-profile-ui/` through the tutorial approuter, reading its one data endpoint from Plan D's `GET /community/user/:scnId` (same origin, same MTA) instead of the retired `/khoros/user/:scnId`.

**Architecture:** The SPA is a client-routed Vite 7 + TypeScript + Vue 3 app (Pinia store, vue-router `createWebHistory`, vue-i18n with 11 locales, UI5 Web Components 2.13 on SAP Horizon). It builds to `app/community-profile/dist/` and is served **as static assets by `gameboard-srv`** via an Express static mount at `/community-profile-ui/` — the same CAP Node.js process that already serves Plan D's `/community/user/:scnId`. This keeps the SPA and its only data source **same-origin, same-MTA**. The tutorial approuter gains one anonymous route block `^/community-profile-ui/(.*)$ → gameboard-srv-api` (mirroring Plan A Task 6 and the existing `explore-ui` anonymous-SPA pattern), with an SPA fallback so client-side deep links (`/community-profile-ui/#/<scnId>` and history-mode paths) resolve to `index.html`.

**Tech Stack:** Vite 7, TypeScript 5.7, Vue 3.5, Pinia 2, vue-router 4, vue-i18n 10, `@ui5/webcomponents` 2.13 (+ `-fiori`, `-icons`), `@sap-theming/theming-base-content` 11, Vitest 4 (jsdom), Playwright 1.49. Runs inside the `sap-community-gameboard` CAP MTA established by Plan A; consumes Plan D's `/community` router.

## Location & serving decision (justification)

- **Location = (a) new gameboard repo, `app/community-profile/`.** The SPA's sole data call is Plan D's `/community/user/:scnId`, delivered by `gameboard-srv` in the **same** MTA. Co-locating the SPA there makes it same-origin with its backend, keeps all community assets in one repo (design §2 "all-in-one, one seam"), and avoids a cross-MTA build/deploy coupling into `tutorials-ims`. `frontend-apps.md` shows the tutorial repo's `app/` tree is reserved for tutorial-system apps (admin, analytics, scanner, display) copied into **its own** approuter's `static/` — not a fit for a separate-MTA community tool.
- **Serving = (i) Express static mount on `gameboard-srv`.** The built `dist/` is mounted at `/community-profile-ui/` by a small Express handler in Plan D's `/community` router surface, so the SPA HTML/JS/CSS and its `/community/user/:scnId` JSON share one origin and one deployable unit. The approuter simply proxies `/community-profile-ui/*` to `gameboard-srv-api` (anonymous). Option (ii) — copying into the tutorial approuter's `static/` — is rejected because it would re-introduce the cross-MTA build coupling and a second origin for the data fetch, contradicting the separate-MTA design.

## Plan D contract consumed (fields this SPA needs)

`GET /community/user/:scnId` → JSON envelope `{ data: <author> }` (Plan D's `callUserAPI` shape). The SPA's `KhorosResponse = { data: KhorosProfile }` type requires these fields on `data` (all optional per the source type, but the happy path uses them). **These are Plan D's contract to satisfy** — named here so the two plans reconcile:

| Field on `data` | Used by | Notes |
|---|---|---|
| `id` | store `scnId` correlation | string |
| `login` | profile details | string |
| `first_name`, `last_name` | `ProfileDetails.vue` | string |
| `view_href` | `buildEmbedHtml`/`buildEmbedMarkdown` (profile link) | absolute community profile URL |
| `signature` | `parseSignatureBadgeIds` seeds initial selection | HTML snippet containing `<img>` with badge-group URL |
| `avatar.profile` | avatar chip | image URL |
| `rank.name` | profile details | string |
| `user_badges.items[]` | badge picker | each item `{ earned_date?, badge: { id, title?, icon_url?, awarded? } }` |

**Assumption to reconcile:** I assume Plan D returns this Khoros-native envelope **verbatim** (badges under `user_badges.items[].badge.{id,title,icon_url}`, signature as raw HTML, `view_href` as the community profile link) — i.e. Plan D's facade preserves the old `callUserAPI` `{data:<author>}` shape unchanged. If Plan D renames or reshapes any of these (e.g. flattens `user_badges`), the only SPA touch-point is `src/types/khoros.ts` + `src/store/profile.ts`; flag it so we adjust the type mapping rather than the whole app.

---

## Global Constraints

- **Only the data-layer base path changes.** The single network call in `src/composables/useKhoros.ts` moves from `/khoros/user/:scnId` to `/community/user/:scnId`. Everything else in the fetch (method, error mapping, URI-encoding, JSON envelope) is preserved byte-for-byte. Signature `<img>` URLs (`/showcaseBadgesGroups/...`, `/showcaseSingleBadge/...`, `/showcaseBadges/...`) are **also** Plan D `/community/*` routes — rebase them too (see Task 4). No other endpoints exist.
- **Router base becomes `/community-profile-ui/`.** `createWebHistory('/community-profile-ui/')` strips that prefix before the matcher; route paths stay relative (`/:scnId?`). Do NOT add a catch-all route (source comment in `router/index.ts:14-17`).
- **Preserve the full test suite.** The source has **134 `it()`/`test()` assertions across 14 vitest spec files** (not 73 — verified by `grep -cE '^\s*(it|test)\('`) plus a 2-test Playwright e2e. Port every one; they must run green against the new base path with a mocked fetch.
- **Preserve i18n (11 locales) and UI5 Horizon theming exactly.** `en, de, es, fr, hi, i-klingon, it, iw, ja, la, pl`; light/dark via `theme.ts` swapping `@sap-theming` CSS-variable stylesheets and `setTheme()`. Accessibility (`data-testid` hooks, semantic UI5 components, `prefers-reduced-motion` where present) retained.
- **Vite `base` and history base must agree** — both `/community-profile-ui/`. A mismatch breaks asset URLs or deep-link fallback.
- **No secrets, no auth in the SPA.** It is anonymous; `gameboard-srv` and the approuter route are `authenticationType: none`. The data endpoint's own auth is Plan D's concern.
- **This plan does NOT modify `tutorials-ims`** except the one approuter route block + its `.deploy/mta.yaml` mirror (Task 7) — mirror every `mta.yaml` change into `.deploy/mta.yaml` per the dual-mta caveat.
- **`.js` sidecars in the source tree are stale tsc output** — port only the `.ts`/`.vue`/`.json`/`.css` sources; do not copy the committed `.js`/`.d.ts`/`.tsbuildinfo` build artifacts.
- **Node baseline `^22 || ^24`** (matches Plan A `package.json`).

---

### Task 1: Copy the SPA source tree into `app/community-profile/`

**Repo:** `sap-community-gameboard` (new, from Plan A).

**Files:**
- Create (copy): the SPA's source-only files from `D:\projects\sap-community-activity-badges\srv\app\profile-vue\` into `app/community-profile/`.
- Do NOT copy: `node_modules/`, `dist/`, `.tsbuild/`, `test-results/`, any `*.js` sidecar next to a `*.ts`, `*.d.ts`, `*.tsbuildinfo`.

**Interfaces:**
- Produces: an `app/community-profile/` tree that builds and tests exactly as the source does today (before the base-path rebase in Tasks 2-4).

- [ ] **Step 1: Create the app directory and copy source files**

From the `sap-community-gameboard` repo root:

```bash
mkdir -p app/community-profile
SRC="D:/projects/sap-community-activity-badges/srv/app/profile-vue"
# Source-only copy (exclude build artifacts + generated sidecars).
rsync -a \
  --exclude 'node_modules/' --exclude 'dist/' --exclude '.tsbuild/' \
  --exclude 'test-results/' --exclude 'tsconfig.tsbuildinfo' \
  --exclude 'tsconfig.node.tsbuildinfo' \
  --exclude '*.d.ts' \
  "$SRC/" app/community-profile/
# Remove the stale .js sidecars that shadow the .ts sources.
find app/community-profile/src app/community-profile/tests -name '*.js' -type f -delete
```

(If `rsync` is unavailable on the workstation, use `cp -r` then delete the excluded dirs/files by hand — the exclusion list above is the contract.)

- [ ] **Step 2: Verify the copied tree is source-only**

Run:

```bash
find app/community-profile -type f -not -path '*/node_modules/*' | sort
```

Expected: `index.html`, `package.json`, `vite.config.ts`, `vitest.config.ts`, `playwright.config.ts`, `tsconfig*.json`, `public/*`, `src/**/*.{ts,vue,css,json}`, `tests/**/*.{ts,json}`. Expected ABSENT: any `.js` under `src/`/`tests/`, any `.d.ts`, `dist/`, `.tsbuild/`.

- [ ] **Step 3: Install deps and run the source tests unchanged (baseline green)**

Run:

```bash
cd app/community-profile && npm install && npm run test
```

Expected: all 134 unit assertions PASS (still against `/khoros/...` — the rebase happens next). This proves the copy is faithful before we change anything.

- [ ] **Step 4: Commit**

```bash
git add app/community-profile
git commit -m "chore(community-profile): port profile-vue SPA source tree (pre-rebase)"
```

---

### Task 2: Rebase Vite + router to `/community-profile-ui/`

**Repo:** `sap-community-gameboard`.

**Files:**
- Modify: `app/community-profile/vite.config.ts`
- Modify: `app/community-profile/src/router/index.ts`
- Modify: `app/community-profile/index.html` (favicon href)
- Modify: `app/community-profile/package.json` (name)

**Interfaces:**
- Produces: SPA whose asset base and history base are both `/community-profile-ui/`.

- [ ] **Step 1: Change the Vite `base` and dev proxy targets**

In `vite.config.ts`, change `base: '/profile/'` → `base: '/community-profile-ui/'`, and repoint the dev proxy to the local `gameboard-srv` (`cds watch` default port 4004) with the new `/community/*` prefixes:

```ts
  base: '/community-profile-ui/',
  server: {
    port: 5173,
    proxy: {
      '/community': { target: 'http://localhost:4004', changeOrigin: true }
    }
  },
```

(The four old `/khoros`, `/showcaseBadges*` proxy entries collapse into one `/community` prefix — all signature/user URLs now live under `/community/*`, per Task 4.)

- [ ] **Step 2: Change the router history base**

In `src/router/index.ts`, change `createWebHistory('/profile/')` → `createWebHistory('/community-profile-ui/')`. Update the two explanatory comments that name `/profile/` to name `/community-profile-ui/`. Keep the single `/:scnId?` route and the "NO catch-all" note verbatim (only the base string changes).

- [ ] **Step 3: Rebase the favicon href in `index.html`**

Change `href="/profile/favicon.ico"` → `href="/community-profile-ui/favicon.ico"`. Leave the `<title>`, the `#app` mount node, and the `<script type="module" src="/src/main.ts">` unchanged.

- [ ] **Step 4: Rename the package**

In `package.json`, change `"name": "profile-vue"` → `"name": "community-profile"`. Leave all deps/scripts unchanged.

- [ ] **Step 5: Build to confirm asset base is correct**

Run:

```bash
cd app/community-profile && npm run build
```

Expected: `dist/` produced; `dist/index.html` references assets under `/community-profile-ui/assets/...` (grep to confirm: `grep -o '/community-profile-ui/[^"]*' dist/index.html`).

- [ ] **Step 6: Commit**

```bash
git add app/community-profile/vite.config.ts app/community-profile/src/router/index.ts \
        app/community-profile/index.html app/community-profile/package.json
git commit -m "feat(community-profile): rebase Vite base + router history to /community-profile-ui/"
```

---

### Task 3: Repoint the data fetch to Plan D's `/community/user/:scnId` (TDD)

**Repo:** `sap-community-gameboard`.

**Files:**
- Modify: `app/community-profile/src/composables/useKhoros.ts`
- Modify: `app/community-profile/tests/unit/useKhoros.spec.ts`
- Modify: `app/community-profile/src/types/khoros.ts` (doc comment only)

**Interfaces:**
- Consumes: Plan D's `GET /community/user/:scnId` → `{ data: KhorosProfile }`.
- Produces: `loadUserProfile(scnId)` hitting the new path with identical error semantics.

- [ ] **Step 1: Update the unit test FIRST (failing)**

In `tests/unit/useKhoros.spec.ts`, change the two URL assertions to the new base path:

```ts
    expect(fetchMock).toHaveBeenCalledWith('/community/user/alice', expect.any(Object))
```

and

```ts
    expect(fetchMock).toHaveBeenCalledWith('/community/user/alice%20bob', expect.any(Object))
```

Leave the 404/500/network/invalid-JSON/`instanceof KhorosError` cases unchanged.

- [ ] **Step 2: Run it to confirm it fails**

Run: `cd app/community-profile && npx vitest run tests/unit/useKhoros.spec.ts`
Expected: FAIL — impl still fetches `/khoros/user/...`.

- [ ] **Step 3: Change the single URL in `useKhoros.ts`**

In `src/composables/useKhoros.ts`, change:

```ts
  const url = `/community/user/${encodeURIComponent(scnId)}`
```

Update the JSDoc line "Loads a Khoros user profile via the existing Express endpoint" → "Loads a community user profile via Plan D's `/community/user/:scnId` endpoint (`{data}` envelope)." No other change (error mapping, `encodeURIComponent`, JSON parse all preserved).

- [ ] **Step 4: Update the type doc comment**

In `src/types/khoros.ts`, change the header comment "Type definitions for the /khoros/user/:scnId response shape" → "...for Plan D's /community/user/:scnId response shape ({data:<author>} envelope, Khoros-native fields)." No structural type change — the envelope shape is identical (Plan D contract).

- [ ] **Step 5: Run the test green**

Run: `npx vitest run tests/unit/useKhoros.spec.ts`
Expected: PASS — all 7 assertions.

- [ ] **Step 6: Commit**

```bash
git add app/community-profile/src/composables/useKhoros.ts \
        app/community-profile/tests/unit/useKhoros.spec.ts \
        app/community-profile/src/types/khoros.ts
git commit -m "feat(community-profile): fetch /community/user/:scnId (Plan D) instead of /khoros"
```

---

### Task 4: Rebase signature-image URLs to `/community/*` (TDD)

**Repo:** `sap-community-gameboard`. The signature `<img>` URLs and embed snippets point at the badge-render routes, which Plan D re-hosts under `/community/*` (design §6.2: `/community/showcaseBadges/...`, `showcaseBadgesGroups`, `showcaseSingleBadge`).

**Files:**
- Modify: `app/community-profile/src/utils/signatureUrls.ts`
- Modify: `app/community-profile/tests/unit/signatureUrls.spec.ts`

**Interfaces:**
- Consumes: Plan D `/community/showcaseBadgesGroups/:scnId[/:ids]`, `/community/showcaseSingleBadge/:scnId[/:id]`, `/community/showcaseBadges/:scnId[/:ids]`.
- Produces: signature URLs + embed HTML/Markdown pointing at `/community/*`.

- [ ] **Step 1: Update the URL-builder tests FIRST (failing)**

In `tests/unit/signatureUrls.spec.ts`, prefix the three expected path bases with `/community`:
- `buildSignatureUrl` expectations → `/community/showcaseBadgesGroups/...`
- `buildSignatureLightUrl` expectations → `/community/showcaseSingleBadge/...`
- `buildSignatureBigUrl` expectations → `/community/showcaseBadges/...`

(Read each of the 10 assertions and prepend `/community` to the literal expected path; the embed-HTML/Markdown tests that concatenate `origin + sigPath` need the same prefix inside their expected strings.)

- [ ] **Step 2: Run it to confirm it fails**

Run: `npx vitest run tests/unit/signatureUrls.spec.ts`
Expected: FAIL on all path-shape assertions.

- [ ] **Step 3: Rebase the three builders**

In `src/utils/signatureUrls.ts`, prefix each returned path literal with `/community`:

```ts
export function buildSignatureUrl(scnId: string, badgeIds: readonly string[]): string {
  const tail = badgeIds.filter((id) => id !== '').join('/')
  return tail
    ? `/community/showcaseBadgesGroups/${scnId}/${tail}`
    : `/community/showcaseBadgesGroups/${scnId}`
}

export function buildSignatureLightUrl(scnId: string, badgeIds: readonly string[]): string {
  const first = badgeIds.find((id) => id !== '')
  return first
    ? `/community/showcaseSingleBadge/${scnId}/${first}`
    : `/community/showcaseSingleBadge/${scnId}`
}

export function buildSignatureBigUrl(scnId: string, badgeIds: readonly string[]): string {
  const tail = badgeIds.filter((id) => id !== '').join('/')
  return tail
    ? `/community/showcaseBadges/${scnId}/${tail}`
    : `/community/showcaseBadges/${scnId}`
}
```

`buildEmbedHtml`/`buildEmbedMarkdown` are unchanged — they concatenate the passed-in `origin` + `sigPath`, and `sigPath` now already carries `/community`.

- [ ] **Step 4: Run the test green**

Run: `npx vitest run tests/unit/signatureUrls.spec.ts`
Expected: PASS — all 10 assertions.

- [ ] **Step 5: Commit**

```bash
git add app/community-profile/src/utils/signatureUrls.ts \
        app/community-profile/tests/unit/signatureUrls.spec.ts
git commit -m "feat(community-profile): rebase signature image URLs to /community/*"
```

---

### Task 5: Run the full ported test suite green

**Repo:** `sap-community-gameboard`. Prove the whole suite (134 assertions) passes against the rebased paths with mocked fetch.

**Files:**
- No production changes expected; this task is a gate. If a store test hardcodes `/khoros` or `/profile/`, fix that test (it references the old base).

**Interfaces:**
- Consumes: nothing new.
- Produces: green `npm run test`.

- [ ] **Step 1: Grep for any lingering old base references in tests + src**

Run:

```bash
cd app/community-profile
grep -rnE '/khoros|/profile/|/showcaseBadges(Groups)?/|/showcaseSingleBadge/' src tests \
  | grep -v '/community/'
```

Expected: only comment/i18n hits, if any. Any assertion or code still emitting a bare `/khoros`, `/profile/`, or un-prefixed `/showcase*` is a miss from Tasks 2-4 — fix it (the store test `store-profile.spec.ts` seeds signature HTML fixtures; confirm those fixtures use the new `/community/showcase*` URL when they assert parsed output, but raw upstream `signature` HTML from Plan D may still contain legacy URLs — see Step 2).

- [ ] **Step 2: Confirm `parseSignatureBadgeIds` still parses Plan D signature HTML**

`src/utils/parseSignature.ts` extracts badge ids from the `signature` HTML `<img>` src. Plan D returns the community-native `signature` field, whose embedded URL may still be the community's own absolute badge URL (not our `/community/*` path). Read `tests/unit/parseSignature.spec.ts` (8 assertions) and confirm the parser keys off the badge-id path segments, not the host — if the fixtures encode a specific host, keep them as-is (the parser is host-agnostic). Do NOT rewrite the parser; only verify the 8 tests still pass.

- [ ] **Step 3: Run the complete unit suite**

Run: `npm run test`
Expected: PASS — 134 assertions across 14 files (`vitest run`, jsdom, `tests/setup.ts`).

- [ ] **Step 4: Type-check + build (the `build` script runs `vue-tsc -b` first)**

Run: `npm run build`
Expected: no TS errors; `dist/` produced.

- [ ] **Step 5: Commit any test fixes**

```bash
git add app/community-profile/tests app/community-profile/src
git commit -m "test(community-profile): full suite green against /community/* base paths"
```

---

### Task 6: Serve the built SPA from `gameboard-srv` at `/community-profile-ui/` (TDD)

**Repo:** `sap-community-gameboard`. Mount the built `dist/` as static assets on the CAP server, same origin as `/community/user/:scnId` (Plan D). Use a CAP bootstrap hook so the Express static mount is registered on the CAP app's underlying Express instance.

**Files:**
- Create: `srv/lib/community/serve-spa.js` (Express static mount + SPA fallback)
- Modify: `srv/server.js` (wire the mount on `bootstrap`) — create it if Plan D/A has not; otherwise extend.
- Create: `test/unit/serve-spa.test.js`

**Interfaces:**
- Consumes: `app/community-profile/dist/` (built in Task 5) — at deploy time this is copied to a path `gameboard-srv` can read (Task 7 wires the MTA build-result copy). For local test, point at the repo-relative `app/community-profile/dist`.
- Produces: `GET /community-profile-ui/` → `index.html`; `GET /community-profile-ui/assets/*` → hashed asset; `GET /community-profile-ui/<deep-link>` (no file extension, not `/community/*`) → `index.html` (SPA history fallback).

- [ ] **Step 1: Write the failing mount test**

`test/unit/serve-spa.test.js`:

```js
const path = require('path');
const express = require('express');
const { expect } = require('chai');
const { mountCommunityProfileSpa } = require('../../srv/lib/community/serve-spa');

describe('community-profile SPA static mount', () => {
  let server, base;
  const distDir = path.join(__dirname, 'fixtures', 'spa-dist');
  before((done) => {
    const app = express();
    mountCommunityProfileSpa(app, distDir);
    server = app.listen(0, () => { base = `http://127.0.0.1:${server.address().port}`; done(); });
  });
  after((done) => server.close(done));

  it('serves index.html at the mount root', async () => {
    const res = await fetch(`${base}/community-profile-ui/`);
    expect(res.status).to.equal(200);
    expect(await res.text()).to.contain('<div id="app">');
  });

  it('serves a static asset', async () => {
    const res = await fetch(`${base}/community-profile-ui/assets/app.js`);
    expect(res.status).to.equal(200);
    expect(res.headers.get('content-type')).to.match(/javascript/);
  });

  it('falls back to index.html for a client-side deep link', async () => {
    const res = await fetch(`${base}/community-profile-ui/12345`);
    expect(res.status).to.equal(200);
    expect(await res.text()).to.contain('<div id="app">');
  });

  it('does NOT swallow /community/* API paths', async () => {
    // /community/user is owned by Plan D's router, not the SPA mount.
    const res = await fetch(`${base}/community/user/12345`);
    expect(res.status).to.equal(404); // no API handler in this isolated test app
  });
});
```

Create the fixture `test/unit/fixtures/spa-dist/index.html` containing `<div id="app"></div>` and `test/unit/fixtures/spa-dist/assets/app.js` containing `console.log('spa')`.

- [ ] **Step 2: Run it to confirm it fails**

Run: `npx vitest run test/unit/serve-spa.test.js`
Expected: FAIL — `serve-spa.js` does not exist.

- [ ] **Step 3: Implement `srv/lib/community/serve-spa.js`**

```js
const path = require('path');
const express = require('express');

const MOUNT = '/community-profile-ui';

/**
 * Mounts the built community-profile SPA (Vite dist/) as static assets under
 * /community-profile-ui, with an SPA history fallback so client-routed deep
 * links resolve to index.html. Must be registered AFTER the /community API
 * router so it never shadows /community/user or /community/showcase* paths.
 */
function mountCommunityProfileSpa(app, distDir) {
  const dir = distDir || path.join(__dirname, '../../../app/community-profile/dist');
  const indexHtml = path.join(dir, 'index.html');

  // 1. Static assets (hashed JS/CSS, favicon, public/*).
  app.use(MOUNT, express.static(dir, { fallthrough: true }));

  // 2. SPA fallback: any GET under the mount that isn't a real file and has
  //    no file extension → index.html (client router takes over).
  app.get(new RegExp(`^${MOUNT}(?:/(?!.*\\.[a-zA-Z0-9]+$).*)?$`), (req, res, next) => {
    res.sendFile(indexHtml, { dotfiles: 'allow' }, (err) => {
      if (err) next(err);
    });
  });
}

module.exports = { mountCommunityProfileSpa, MOUNT };
```

- [ ] **Step 4: Wire it into the CAP server bootstrap**

In `srv/server.js` (extend Plan A/D's file; create if absent), register the mount on the Express app after CAP's routers are attached, so `/community/*` (Plan D) resolves first:

```js
const cds = require('@sap/cds');
const { mountCommunityProfileSpa } = require('./lib/community/serve-spa');

cds.on('bootstrap', (app) => {
  // Plan D's /community router is registered by the service; the SPA static
  // mount goes last so it never shadows /community/user or /community/showcase*.
  cds.on('served', () => mountCommunityProfileSpa(app));
});

module.exports = cds.server;
```

(If Plan D already defines `srv/server.js` with a `bootstrap` hook, add the two lines there instead of creating a second file.)

- [ ] **Step 5: Run the mount test green**

Run: `npx vitest run test/unit/serve-spa.test.js`
Expected: PASS — all 4 assertions.

- [ ] **Step 6: Commit**

```bash
git add srv/lib/community/serve-spa.js srv/server.js test/unit/serve-spa.test.js \
        test/unit/fixtures/spa-dist
git commit -m "feat(gameboard-srv): serve community-profile SPA at /community-profile-ui/"
```

---

### Task 7: MTA build wiring — build the SPA and stage its dist for `gameboard-srv`

**Repo:** `sap-community-gameboard`. Make `mbt build` produce `app/community-profile/dist/` and place it where the deployed `gameboard-srv` reads it.

**Files:**
- Modify: `mta.yaml` (the Plan A `gameboard-srv` module) — add a `build-parameters.before-all` (or module-level `commands`) step that runs the SPA build and copies `dist/` into the module's staged content.
- Modify: `package.json` (root) — add a `build:spa` script.
- Test: `test/smoke/spa-served.test.js` (post-deploy)

**Interfaces:**
- Consumes: `app/community-profile/` (Tasks 1-5).
- Produces: a deployed `gameboard-srv` that serves `/community-profile-ui/` from bundled `dist/`.

- [ ] **Step 1: Add a root `build:spa` script**

In the repo-root `package.json` scripts:

```json
"build:spa": "npm --prefix app/community-profile install && npm --prefix app/community-profile run build"
```

- [ ] **Step 2: Wire the SPA build + stage into the `gameboard-srv` MTA module**

In `mta.yaml`, extend the `gameboard-srv` module (from Plan A) so its build runs `build:spa` and copies the result under the module path that `serve-spa.js` reads (`app/community-profile/dist` relative to the built module root). Because CAP builds the nodejs module to `gen/srv`, stage the SPA dist into `gen/srv/app/community-profile/dist` so the deployed layout matches `serve-spa.js`'s default `distDir` (`../../../app/community-profile/dist` from `gen/srv/srv/lib/community/`):

```yaml
  - name: gameboard-srv
    type: nodejs
    path: gen/srv
    build-parameters:
      before-all:
        - builder: custom
          commands:
            - npm ci
            - npm run build:spa
            - npx cds build --production
        - builder: custom
          commands:
            - mkdir -p gen/srv/app/community-profile
            - cp -r app/community-profile/dist gen/srv/app/community-profile/dist
    # ...(requires/provides/parameters from Plan A unchanged)...
```

(If Plan A already declares a `before-all` `cds build`, merge these commands into that block rather than duplicating it. The key contract: `app/community-profile/dist` must exist under `gen/srv/` in the staged module so the runtime default path resolves.)

- [ ] **Step 3: Confirm the default `distDir` resolves in the staged layout**

`serve-spa.js` lives at `gen/srv/srv/lib/community/serve-spa.js` after `cds build`; its default `distDir` is `path.join(__dirname, '../../../app/community-profile/dist')` = `gen/srv/app/community-profile/dist`. Verify Step 2's `cp` target matches this exactly. If Plan A's `cds build` places `serve-spa.js` at a different depth, adjust the default in `serve-spa.js` to match (single source of truth: the runtime path).

- [ ] **Step 4: Local build dry-run**

Run:

```bash
npm run build:spa
npx cds build --production
mkdir -p gen/srv/app/community-profile && cp -r app/community-profile/dist gen/srv/app/community-profile/dist
ls gen/srv/app/community-profile/dist/index.html
```

Expected: `index.html` present at the staged path.

- [ ] **Step 5: Write the post-deploy smoke test**

`test/smoke/spa-served.test.js`:

```js
const { expect } = require('chai');
describe('deployed community-profile SPA', () => {
  const base = process.env.SMOKE_BASE_URL; // tutorial approuter host
  (base ? it : it.skip)('serves index.html at /community-profile-ui/', async () => {
    const res = await fetch(`${base}/community-profile-ui/`);
    expect(res.status).to.equal(200);
    const html = await res.text();
    expect(html).to.contain('<div id="app">');
  });
  (base ? it : it.skip)('deep link falls back to index.html', async () => {
    const res = await fetch(`${base}/community-profile-ui/12345`);
    expect(res.status).to.equal(200);
    expect(await res.text()).to.contain('<div id="app">');
  });
});
```

Run (after Task 8 deploy): `SMOKE_BASE_URL=<approuter-host> npx vitest run test/smoke/spa-served.test.js`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add mta.yaml package.json test/smoke/spa-served.test.js
git commit -m "build(gameboard): build community-profile SPA and stage dist into gameboard-srv"
```

---

### Task 8: Approuter route in `tutorials-ims` + e2e verification

**Repo:** route block lands in `tutorials-ims`; e2e spec lands in `sap-community-gameboard`. Mirrors Plan A Task 6 and the existing `explore-ui` anonymous-SPA route.

**Files:**
- Modify (`tutorials-ims`): `approuter/xs-app.json`, and mirror any destination change into `mta.yaml` AND `.deploy/mta.yaml`.
- Create (`sap-community-gameboard`): `app/community-profile/tests/e2e/signature-embed.spec.ts` (ported + retargeted from the source e2e).

**Interfaces:**
- Consumes: `gameboard-srv-api` destination (declared in Plan A Task 6 for `/gameboard` + `/community`).
- Produces: `/community-profile-ui/*` reachable anonymously through the tutorial approuter with SPA fallback.

- [ ] **Step 1: Add the approuter route block**

In `tutorials-ims` `approuter/xs-app.json`, insert BEFORE the catch-all `^(.*)$` route (and alongside the Plan A/D `/gameboard` and `/community` blocks):

```json
{
  "source": "^/community-profile-ui/(.*)$",
  "target": "/community-profile-ui/$1",
  "destination": "gameboard-srv-api",
  "authenticationType": "none"
}
```

The SPA history fallback is handled server-side by `serve-spa.js` (Task 6), so no approuter-level `localDir` fallback is needed — every `/community-profile-ui/*` request proxies to `gameboard-srv`, which returns `index.html` for non-asset deep links.

- [ ] **Step 2: Confirm the `gameboard-srv-api` destination exists**

The `gameboard-srv-api` destination was declared in Plan A Task 6 (URL-based destination to the deployed `gameboard-srv`) for `/gameboard/*` and `/community/*`. This route reuses it — no new destination. If deploying this plan standalone, add the destination to BOTH `mta.yaml` and `.deploy/mta.yaml` (mirror exactly) per Plan A Task 6 Step 2.

- [ ] **Step 3: Deploy the gameboard MTA, then the approuter (base-then-enable)**

```bash
# In sap-community-gameboard: build (incl. SPA) + deploy the backend first.
npm run build:spa && npx cds build --production
mkdir -p gen/srv/app/community-profile && cp -r app/community-profile/dist gen/srv/app/community-profile/dist
cf target   # RE-ASSERT dev target right before deploy (cf target can drift)
mbt build && cf deploy mta_archives/sap-community-gameboard_0.1.0.mtar -f
# In tutorials-ims: full deploy so the approuter rebuilds with the new route.
npm run deploy -- --env dev
```

(Explicit mtar filename, not a glob — glob panics on Windows.)

- [ ] **Step 4: Port + retarget the Playwright e2e**

Copy the source `tests/e2e/happy-path.spec.ts` into `app/community-profile/tests/e2e/signature-embed.spec.ts` and retarget it:
- Route mock: `**/khoros/user/*` → `**/community/user/*`.
- Navigation: `page.goto('/profile/demo_user')` → `page.goto('/community-profile-ui/demo_user')` (or `/community-profile-ui/#/demo_user` if serving history-mode behind the approuter surfaces a base issue — history mode is server-fallback-backed by Task 6, so the clean path should work).
- Signature assertions: `/showcaseBadgesGroups/demo_user/` → `/community/showcaseBadgesGroups/demo_user/`.
- Keep the two scenarios: (1) load profile + toggle a badge updates the signature `<img>` src (the "generate the signature embed markup" flow — assert `preview-full` src changes and, if the source has an embed-copy testid, assert `embedHtml`/`embedMarkdown` output contains the `/community/showcaseBadgesGroups/` URL), and (2) 404 shows the not-found banner.

Update `playwright.config.ts`: `baseURL` → the deployed tutorial approuter host (via `PLAYWRIGHT_BASE_URL` env, self-skipping when absent, per the repo e2e convention); drop the source `webServer` block that built the old Express app (this SPA is served by `gameboard-srv`, exercised post-deploy).

- [ ] **Step 5: Run the e2e against the deployed board**

Run: `PLAYWRIGHT_BASE_URL=<approuter-host> npx playwright test tests/e2e/signature-embed.spec.ts`
Expected: PASS — profile loads at `/community-profile-ui/demo_user`, badge toggle regenerates the embed markup, 404 shows the banner.

- [ ] **Step 6: Verification-before-done — exercise the real SPA in a browser**

Load `https://<approuter-host>/community-profile-ui/<a-real-scnId>` in a browser (Playwright MCP against Tom's session if auth-gated upstream). Confirm: profile renders, badge picker populates from Plan D data, selecting badges updates the live signature preview, the embed HTML/Markdown copy fields produce a `/community/showcaseBadgesGroups/...` URL, theme toggle + a non-English locale both work. Screenshot as evidence.

- [ ] **Step 7: Commit (PR on each repo)**

```bash
# tutorials-ims
git add approuter/xs-app.json mta.yaml .deploy/mta.yaml
git commit -m "feat(approuter): route /community-profile-ui/* to gameboard-srv (anonymous SPA)"
# sap-community-gameboard
git add app/community-profile/tests/e2e/signature-embed.spec.ts app/community-profile/playwright.config.ts
git commit -m "test(community-profile): e2e signature-embed against deployed /community-profile-ui/"
```

---

## No Placeholders

Every code step contains real, runnable content:
- Task 1: exact `rsync` exclusion list + sidecar deletion.
- Task 2: exact `base`/`createWebHistory` string swaps + favicon href + package name.
- Task 3-4: exact one-line URL changes + the corresponding test-assertion edits (TDD).
- Task 6: full `serve-spa.js` (static mount + regex SPA fallback that excludes extensioned assets) + `server.js` bootstrap wiring + 4-assertion test with fixtures.
- Task 7: exact `build:spa` script + `mta.yaml` `before-all` commands + staged path contract + post-deploy smoke test.
- Task 8: exact approuter route JSON + e2e retarget deltas.

No TBDs. The single conditional (Task 8 Step 4 clean-path vs `#/` fallback) is a verify-then-pick, not an unresolved placeholder — the server-side fallback makes the clean path the expected default.

## Self-Review

**Spec coverage (§7.2 signature-builder SPA):**
- Ported as standalone `app/` SPA, client-routed, served at `/community-profile-ui/`, reads `/community/user/:scnId` → Tasks 1-8. ✅
- Router base `/community-profile-ui/`; single data-fetch base-path change → Tasks 2, 3. ✅ (design §7.2 "only code change to its data layer is the base path" — honored; signature-image URLs also rebased to `/community/*` because those routes moved under Plan D's `/community` surface per §6.2, which is the same base-path class of change).
- Pinia store, vue-i18n (11 locales), UI5 Web Components (Horizon), accessibility → preserved unchanged (Tasks 1, 5); no store/i18n/theme code touched. ✅
- 134 vitest assertions (source truth; prompt's "73" was approximate) ported + green → Task 5. ✅
- Playwright e2e (`/community-profile-ui/#/<scnId>`, pick badges, generate signature embed) → Task 8 Steps 4-6. ✅
- Build test that `dist/` is produced + static mount serves `index.html` → Task 6 (unit) + Task 7 (build dry-run + smoke). ✅

**Decisions encoded:** Location (a) `sap-community-gameboard` `app/community-profile/`; serving (i) Express static mount on `gameboard-srv` — both justified at the top, ~3 lines each.

**Plan D contract:** consumed as `{ data: <author> }` from `GET /community/user/:scnId`; the 8 required fields are tabulated with the explicit assumption (verbatim Khoros-native envelope) flagged for reconciliation.

**Cross-plan coupling:** consumes Plan A's `gameboard-srv` module + `gameboard-srv-api` destination (Task 6/8) and Plan D's `/community` router (Task 6 ordering: SPA mount registered after the API router so it never shadows `/community/user` or `/community/showcase*`). Approuter change mirrored into `.deploy/mta.yaml`.

**Placeholder scan:** none. **Path consistency:** `/community-profile-ui/` is identical across Vite `base`, `createWebHistory`, `serve-spa.js` `MOUNT`, the approuter route, and both smoke + e2e targets. The staged dist path (`gen/srv/app/community-profile/dist`) matches `serve-spa.js`'s default `distDir` (Task 7 Step 3 re-verifies the relative depth).
