# Devtoberfest right-rail navigation + Rules & FAQ pages

**Date:** 2026-08-02
**Status:** Approved (design)
**Author:** Tom (via Claude)

## Problem

The Devtoberfest landing page (`/devtoberfest/`) has a right-side navigation
rail (`dtf-rail` in `hugo-apps/src/devtoberfest/DevtoberfestHome.vue`) with only
4 links (THE RULES, THE WEEKS, FAQ, GAMEBOARD), whose URLs are read from
admin-entered `DevtoberfestConfig` columns via `/api/devtoberfest/status`. Two of
those targets (Rules, FAQ) have no destination page at all, and the rail does not
surface the Activities, Sessions, Arcade, or Leaderboard surfaces that now exist.

We want the rail to link to the full set of Devtoberfest surfaces, plus two new
content pages:

- **Rules** — shows the same terms & conditions the user accepts in the
  registration popup, so they can review them any time.
- **FAQ** — an admin-editable FAQ page (2025 content will be pasted/updated by an
  admin after the field ships).

## Current state (verified)

- **Rail** — `railItems` computed in `DevtoberfestHome.vue:127` builds 4 items
  from `status.contentRulesUrl / activitiesUrl / faqUrl / gameboardUrl`. Rail CSS
  (`hugo-apps/src/devtoberfest/styles.css:373`) hard-codes 4 `nth-child` accent
  colors.
- **Existing internal pages** (Hugo routes under `hugo/content/devtoberfest/`,
  layouts under `hugo/layouts/devtoberfest/`): `calendar`, `sessions` (grid),
  `schedule` (table w/ Session/Activity filter), `gameboard` (leaderboard),
  `arcade`, `selfie`.
- **Terms** — `GET /api/devtoberfest/terms` (`srv/routes/devtoberfest-public.js:68`)
  returns `{ text, version }` from `DevtoberfestConfig.termsText` (LargeString,
  markdown source). The registration popup (`TermsDialog.vue:197`) currently
  renders it as **plain text** (`{{ text }}`), NOT parsed markdown.
- **Markdown rendering** — `markdown-it.min.js` + `purify.min.js` are loaded
  globally on every page via `hugo/layouts/_default/baseof.html:51-52`, exposed as
  `window.markdownit` / `window.DOMPurify`. Canonical usage pattern
  (`hugo/static/js/joule-render.js:8`): `window.markdownit({ html: false,
  linkify: true, breaks: true })` → `window.DOMPurify.sanitize(dirty, {
  USE_PROFILES: { html: true } })`. No markdown npm dep exists in `hugo-apps`.
- **Config schema** — `DevtoberfestConfig` (`db/devtoberfest.cds:27`) has
  `termsText`, `contentRulesUrl`, `faqUrl`, `gameboardUrl`, `activitiesUrl`. There
  is a `faqUrl` (link) but **no FAQ body field**.
- **Admin UI** — Fiori Elements LR/OP at `/admin-ui/#/devtoberfest`, annotated in
  `app/admin-annotations.cds:2762`. `termsText` is surfaced as `@UI.MultiLineText`
  under a `FieldGroup#Terms` facet.
- **Island build** — entries registered in `hugo-apps/vite.config.ts:236` input
  map; output `[name].js` into `hugo/static/js/`.

## Decisions

1. **Rail = 7 fixed internal links**, hardcoded in the component (not config-URL
   driven). More robust: no dependency on admins populating URL fields, all
   targets are stable internal routes. Order and mapping:

   | Label | Target |
   |---|---|
   | THE WEEKS | `/devtoberfest/calendar/` |
   | ACTIVITIES | `/devtoberfest/schedule/` |
   | SESSIONS | `/devtoberfest/sessions/` |
   | ARCADE | `/devtoberfest/arcade/` |
   | LEADERBOARD | `/devtoberfest/gameboard/` |
   | THE RULES | `/devtoberfest/rules/` (new) |
   | FAQ | `/devtoberfest/faq/` (new) |

2. **Rules page** renders `termsText` as **rendered markdown** (Tom's choice),
   via the global `window.markdownit` + `window.DOMPurify`. Sourced from the
   existing `/api/devtoberfest/terms` endpoint — always matches what the user
   accepts at registration; admin-editable via the existing `termsText` field.

3. **FAQ page** is admin-editable via a **new `faqText` field** on
   `DevtoberfestConfig`, rendered as markdown the same way. New public endpoint
   `GET /api/devtoberfest/faq` mirrors `termsHandler`.

4. The config URL fields (`contentRulesUrl`, `faqUrl`, `gameboardUrl`,
   `activitiesUrl`) **stay in the schema** — the Joule tool and chat-context
   (`srv/lib/devtoberfest-joule-tool.js`, `srv/lib/chat-context.js`) still read
   them. They simply no longer drive the rail. No removal, no migration risk.

## Design

### Component units

Each new island is a small, single-purpose unit: fetch one endpoint, render
markdown, handle loading/empty/error. They share one markdown helper.

#### Shared markdown helper (`hugo-apps/src/devtoberfest-shared/render-markdown.ts`)

```ts
// Renders markdown to sanitized HTML using the globally-loaded
// window.markdownit + window.DOMPurify (baseof.html). Falls back to
// escaped plain text if the globals are unavailable (defensive).
export function renderMarkdown(src: string): string
```

- Uses `window.markdownit({ html: false, linkify: true, breaks: true })` +
  `window.DOMPurify.sanitize(html, { USE_PROFILES: { html: true } })` — identical
  config to `joule-render.js`.
- `html: false` means raw HTML in the source is escaped; DOMPurify is defense in
  depth. Content is admin-authored (trusted-ish) but sanitization stays.
- If globals missing (e.g. unit test / load race), returns escaped text so the
  page degrades to readable plain text rather than throwing.

TypeScript: declare `window.markdownit` / `window.DOMPurify` as `any` in a local
ambient block (no `@types` dep).

#### Rules island (`hugo-apps/src/devtoberfest-rules/`)

- `main.ts` mounts `App.vue` into `#devtoberfest-rules-mount`.
- `App.vue`: on mount, `fetch('/api/devtoberfest/terms', { credentials: 'include' })`.
  States: loading / ok (render markdown via helper, `v-html` on sanitized output) /
  empty (no active event → 503, show "no rules yet" message) / error (show retry).
- Shows the terms `version` as a small badge, matching the popup's `v{{ version }}`.

#### FAQ island (`hugo-apps/src/devtoberfest-faq/`)

- Identical shape to Rules; fetches `/api/devtoberfest/faq`, renders `text`.
- Empty state: "FAQ coming soon."

### Backend: `GET /api/devtoberfest/faq`

In `srv/routes/devtoberfest-public.js`, add `faqHandler` mirroring `termsHandler`:

```js
async function faqHandler(_req, res) {
  await cds.connect.to('db');
  const { DevtoberfestConfig } = cds.entities('com.sap.developers.ims');
  const config = await SELECT.one.from(DevtoberfestConfig).where({ isActive: true });
  if (!config) return res.status(503).json({ error: 'EVENT_NOT_CONFIGURED' });
  return res.status(200).json({ text: config.faqText || '' });
}
```

Register `app.get('/api/devtoberfest/faq', _contextMw, _authMw, faqHandler)` and
export it. Anonymous-friendly (public), same as `/terms`.

### Schema: `faqText`

Add to `DevtoberfestConfig` (`db/devtoberfest.cds`):

```cds
faqText : LargeString;   // markdown body for the public FAQ page
```

### Admin annotation

In `app/admin-annotations.cds`, add to the field block:

```cds
faqText @title: 'FAQ (markdown)' @Common.Label: 'FAQ (markdown)' @UI.MultiLineText;
```

Surface it in the Object Page — extend `FieldGroup#Terms` (rename facet label to
"Content Rules / Terms / FAQ") or add a `FieldGroup#Faq` facet. Chosen approach:
add `{ Value: faqText }` to `FieldGroup#Terms`'s Data array and update that
facet's label to `'Content Rules, Terms & FAQ'`. One less facet to maintain.

### Hugo pages & layouts

Two new content files + two new layouts, following the existing pattern
(`schedule.html` etc.):

- `hugo/content/devtoberfest/rules/_index.md` — front matter `type: devtoberfest`,
  `layout: rules`, title "Devtoberfest Rules".
- `hugo/layouts/devtoberfest/rules.html`:
  ```html
  {{ define "main" }}
  <main id="devtoberfest-rules-mount"></main>
  <noscript>The Devtoberfest rules require JavaScript.</noscript>
  <script type="module" src="{{ "/js/devtoberfest-rules.js" | relURL }}?v={{ now.Unix }}"></script>
  {{ end }}
  ```
- `hugo/content/devtoberfest/faq/_index.md` + `hugo/layouts/devtoberfest/faq.html`
  (same shape, `#devtoberfest-faq-mount`, `/js/devtoberfest-faq.js`).

### Build registration

Add to `hugo-apps/vite.config.ts` input map:

```ts
'devtoberfest-rules': resolve(__dirname, 'src/devtoberfest-rules/main.ts'),
'devtoberfest-faq':   resolve(__dirname, 'src/devtoberfest-faq/main.ts'),
```

### Rail component change

In `DevtoberfestHome.vue`, replace the config-driven `railItems` computed with a
static array of the 7 items above. Remove the dependency on `status.*Url` for the
rail (leave the `StatusResponse` type fields intact — still returned by the API).
Rail CSS: extend the `nth-child` accent-color list from 4 to 7 (add 3 more Horizon
palette hues), and confirm the `:nth-child` fallback / `--rail-i` stagger handles 7
items.

## Data flow

```
/devtoberfest/ (Hugo) → devtoberfest.js island → GET /api/devtoberfest/status
    → renders 7 static rail links (no longer uses status URLs)

/devtoberfest/rules/ → devtoberfest-rules.js → GET /api/devtoberfest/terms
    → renderMarkdown(termsText) → sanitized v-html

/devtoberfest/faq/ → devtoberfest-faq.js → GET /api/devtoberfest/faq
    → renderMarkdown(faqText) → sanitized v-html

Admin edits termsText / faqText at /admin-ui/#/devtoberfest (FE OP)
```

## Error handling

- **503 EVENT_NOT_CONFIGURED** (no active config row) → both pages show a friendly
  empty state, not an error.
- **Non-2xx / network error** → error state with a Retry button (mirrors
  `TermsDialog.loadTerms`).
- **Empty `faqText` / `termsText`** → empty-state message ("FAQ coming soon." /
  "Rules will be posted soon.").
- **Markdown globals missing** → helper returns escaped plain text; page still
  readable.

## Testing

- **Unit (hugo-apps, vitest + happy-dom):**
  - `renderMarkdown` — renders headings/lists/links; escapes raw HTML; falls back
    to escaped text when globals absent.
  - Rules `App.vue` — loading → ok renders sanitized HTML; 503 → empty state;
    500 → error + retry.
  - FAQ `App.vue` — same matrix against `/api/devtoberfest/faq`.
  - `DevtoberfestHome.vue` — rail renders exactly 7 links with the expected
    hrefs/labels, independent of `status` URL fields.
- **Backend (unit, in-memory SQLite):** `GET /api/devtoberfest/faq` returns
  `{ text }` for the active row; 503 when no active row. Follow the
  `cds.test('serve','--project','.','--in-memory')` bootstrap (per memory:
  cds.deploy(cds.model) is broken here).
- **Schema guard:** `npx cds deploy --to sqlite::memory:` after the `faqText` add
  (assert-unique / compile guard).
- **Manual (the real thing, per Tom's #1 rule):** after DEV deploy, load
  `/devtoberfest/` in a browser, click all 7 rail links, verify each lands on the
  right surface; edit `faqText`/`termsText` in the admin OP and confirm the pages
  reflect it.

## Deploy / build notes

- User-facing UI change (`hugo-apps/**`, `hugo/layouts/**`, `app/admin/**`) → wants
  a committed e2e spec (advisory nudge); add a `test/e2e/` spec for the rail +
  Rules/FAQ pages.
- Schema change → `cds build --production` for `db/last-dev/` migration table
  (never hand-author the `.hdbmigrationtable`).
- Full deploy required (admin annotation + island bundles): `npm run deploy --
  --env dev` (NO `--skip-build`, NO `-m` scoping — Step 3.5 bundle gate).
- Hugo must finish (`npm run build:all`) before `mbt build`.

## Out of scope

- Removing the now-unused `contentRulesUrl` / `activitiesUrl` config fields (still
  read by Joule/chat-context).
- Rendering markdown in the registration popup (`TermsDialog.vue` stays plain text
  unless separately requested — changing it is a behavior change to the accept
  flow, out of scope here).
- Migrating 2025 FAQ content — an admin pastes it into `faqText` after ship.
