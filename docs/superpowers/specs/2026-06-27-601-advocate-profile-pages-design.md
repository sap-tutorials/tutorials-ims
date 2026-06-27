# Per-advocate profile pages

**Issue:** [#601](https://github.com/sap-tutorials/tutorials-ims/issues/601)
**Status:** Spec
**Date:** 2026-06-27

## Problem

The current Developer Advocates page (`/developer-advocates/`) shows the
whole roster as a grid of flip cards. The card back exposes bio, social
links, an email mailto, topic chips, and tutorial counts. There is no
sharable per-advocate URL — an advocate who wants to use the site as
their public profile (e.g. in a LinkedIn / X / email-signature link)
has nothing to point to. The grid is also a poor surface for browsing
everything an advocate has produced: only counts are shown, not the
actual tutorial / mission / group titles.

Issue [#601](https://github.com/sap-tutorials/tutorials-ims/issues/601)
asks for a unique slug-keyed URL per advocate that opens a full page
showing all of their content and details.

## Goals

1. Each active advocate has a stable, sharable URL of the form
   `/developer-advocates/<slug>/`.
2. The URL renders a server-side HTML page (crawlable, has og:image and
   og:description meta, works without JavaScript for the hero / bio /
   links).
3. The page surfaces tutorial / mission / group content actually
   authored or contributed to by the advocate, not just counts.
4. The existing roster grid stays intact. A click on the card's
   "View profile →" navigates to the internal page.
5. The bio supports formatting (paragraphs, links, lists) via
   markdown rendered server-side and sanitized.

## Non-goals

- Events. `Events` has no `author` association today. Adding one is a
  separate schema change tracked outside this issue.
- RSS / Atom subscription feeds. Future-friendly but out of scope for v1.
- Long-form embedded media in bios (videos, code samples). Markdown is
  enough for v1; richer content can come later.
- New admin UI. Admins continue to use the existing Fiori Object Page
  at `/admin-ui/#advocates-display`. The bio field already accepts
  markdown — admins just author with markdown syntax.
- A separate `bioMarkdown` column. The existing `Advocates.bio`
  `LargeString` is treated as markdown. Plain-text bios already on
  record continue to render fine through `marked` (line breaks and
  URLs survive unchanged).

## Architecture

### URL & rendering

- **URL:** `/developer-advocates/<slug>/` (e.g.
  `/developer-advocates/thomas-jung/`). Slug source is
  `Advocates.slug`, the same column the grid card and `/api/advocates/<slug>/photo`
  already use.
- **Rendering:** Hybrid — Hugo emits a static HTML page per active
  advocate at build time, and a small Vue island hydrates the
  tutorial / mission / group lists from a live endpoint on load.
- **SEO:** Build-time HTML includes `<title>`, `<meta name="description">`,
  `og:title`, `og:description`, `og:image` (pointing to
  `/api/advocates/<slug>/photo`), and `og:type=profile`. The fully-
  rendered bio sits in the static HTML so crawlers index it.

### Data flow

```
build time                                  runtime
============                                =======
fetch-advocates.ts                          browser hits
  → GET /api/advocates                        /developer-advocates/<slug>/
  → for each active advocate                ↓
     write <slug>.md in                     Hugo-served static HTML
     hugo/content/developer-advocates/      (hero, bio, social links,
     with frontmatter + rendered bio HTML    topic chips visible immediately)
  → Hugo builds                             ↓
                                            advocate-profile.js mounts
                                            ↓
                                            GET /api/advocates/:slug
                                            ↓
                                            list sections (tutorials,
                                            missions, groups) populate
```

The static page is fully usable even if the runtime fetch fails — only
the tutorial / mission / group sections are missing. The hero, bio,
social links, and topic chips come from build-time frontmatter.

### Trigger for stale pages

Admin save on an `Advocates`, `AdvocateTopics`, or `AdvocateLinks` row
classifies through
[srv/lib/_classify-rebuild-mode.js](../../../srv/lib/_classify-rebuild-mode.js)
as a content rebuild. A NEW advocate is invisible until the next
`rebuild-content` workflow finishes — same constraint the rest of the
catalog has. The 60s `/api/advocates` cache window means the existing
roster grid still picks up edits within ~1 minute without a rebuild.

## Components

### 1. Public route — `GET /api/advocates/:slug`

New handler in
[srv/routes/advocates-public.js](../../../srv/routes/advocates-public.js)
that returns a single advocate's full profile with authored /
contributed tutorials and authored missions + groups.

**Response shape** (delta from the existing `/api/advocates` list shape
is the addition of `authoredMissions` and `authoredGroups`):

```json
{
  "ID": "...",
  "slug": "thomas-jung",
  "firstName": "Thomas",
  "lastName": "Jung",
  "title": "...",
  "pronouns": "...",
  "location": "...",
  "region": "AMERICAS",
  "bio": "...raw markdown...",
  "joinedDate": "...",
  "hasPhoto": true,
  "photoUpdatedAt": "...",
  "topics": [{ "slug": "...", "label": "..." }],
  "links":  [{ "kind": "LinkedIn", "url": "...", "label": "...", "sortOrder": 100 }],
  "email":  "...",
  "authoredTutorials":    [{ "slug": "...", "title": "..." }],
  "contributedTutorials": [{ "slug": "...", "title": "..." }],
  "authoredMissions":     [{ "slug": "...", "title": "..." }],
  "authoredGroups":       [{ "slug": "...", "title": "..." }]
}
```

- **Auth:** public; approuter route `authenticationType: 'none'` ahead
  of `^/api/(.*)$`.
- **404:** unknown slug or `isActive: false` → 404. The island treats
  404 as "no longer listed" and shows a small banner.
- **Caching:** `ETag` derived from `MAX(modifiedAt)` across the
  advocate's row + its `AdvocateTopics`, `AdvocateLinks`, linked
  `Users` row, and joined `Tutorials` + `TutorialContributors` +
  `Missions` + `Groups`. `Cache-Control: public, max-age=60,
  stale-while-revalidate=600`.
- **HANA reads:** Same plain CDS QL pattern the list handler already
  uses. No new LOB locator concern — bio is `LargeString`, not
  `LargeBinary`.

**Join logic for missions + groups:**

```js
authoredMissions = await db.run(
  SELECT.from(Missions)
    .columns('slug', 'title', 'published', 'author_ID', 'modifiedAt')
    .where({ author_ID: user.ID, published: true })
);
authoredGroups = await db.run(
  SELECT.from(Groups)
    .columns('slug', 'title', 'published', 'author_ID', 'modifiedAt')
    .where({ author_ID: user.ID, published: true })
);
```

Only `published: true` rows surface. Unpublished work stays internal.

### 2. Build-time roster fetcher — `scripts/fetch-advocates.ts`

New TypeScript script that:

1. Calls `GET ${CAP_BASE_URL}/api/advocates` (same env var the rest of
   `scripts/parsers/cap.ts` uses; defaults to `http://localhost:4004`).
2. For each advocate where `isActive: true`:
   - Renders `bio` through `marked` (already in the project's deps; used
     by tutorial parsers) into HTML.
   - Sanitizes the rendered HTML using the project's existing sanitize
     helper (`srv/lib/_sanitize-html.cjs` pattern, or `scripts/parsers/sanitize-html.ts`
     if a build-side variant fits better).
   - Writes `hugo/content/developer-advocates/<slug>.md` with frontmatter:
     ```yaml
     ---
     title: "Firstname Lastname"
     slug: thomas-jung
     layout: single
     type: developer-advocates
     advocate:
       firstName: ...
       lastName: ...
       title: ...
       pronouns: ...
       location: ...
       region: AMERICAS
       hasPhoto: true
       photoUpdatedAt: ...
       joinedDate: ...
       topics: [{slug, label}, ...]
       links:  [{kind, url, label, sortOrder}, ...]
       bioHtml: "<p>...</p>"          # rendered + sanitized
       bioText: "first 200 chars..."  # for og:description
     ---
     ```
3. Caches the raw roster at `.tutorial-cache/advocates-roster.json` so
   reruns without admin changes skip the network round-trip. Cache key
   is the SHA-256 of the API response body.
4. Cleans up stale `<slug>.md` files when an advocate is deactivated or
   deleted — uses the roster as source of truth.

The script is wired into `npm run fetch-tutorials` (or a sibling
`fetch-advocates` script in `package.json`) so `npm run build:all` and
`rebuild-content.yml` invoke it. Add a `pretest:hybrid` step? — No,
keep build-time work in the build pipeline.

### 3. Hugo layout — `hugo/layouts/developer-advocates/single.html`

Server-renders the page from frontmatter:

```html
{{ define "main" }}
{{ $a := .Params.advocate }}
<main class="adv-profile" data-slug="{{ .Params.slug }}">
  <a class="adv-profile-back" href="/developer-advocates/">← All advocates</a>

  <section class="adv-profile-hero" data-region="{{ $a.region }}">
    {{ if $a.hasPhoto }}
      <img class="adv-profile-photo"
           src="/api/advocates/{{ .Params.slug }}/photo?v={{ $a.photoUpdatedAt }}"
           alt="Photo of {{ $a.firstName }} {{ $a.lastName }}" />
    {{ else }}
      <div class="adv-profile-photo-fallback">{{ slicestr $a.firstName 0 1 }}{{ slicestr $a.lastName 0 1 }}</div>
    {{ end }}
    <div class="adv-profile-id">
      <h1>{{ $a.firstName }} {{ $a.lastName }}
        {{ with $a.pronouns }}<span class="adv-pron">({{ . }})</span>{{ end }}
      </h1>
      {{ with $a.title }}<div class="adv-role">{{ . }}</div>{{ end }}
      <div class="adv-loc">
        {{ with $a.location }}{{ . }} ·{{ end }} {{ $a.region }}
      </div>
      <ul class="adv-profile-links">
        {{ range $a.links }}
          <li><a href="{{ .url }}" target="_blank" rel="noopener" title="{{ .label | default .kind }}">{{ .kind }}</a></li>
        {{ end }}
      </ul>
    </div>
  </section>

  {{ with $a.bioHtml }}
  <section class="adv-profile-bio">
    <h2>About</h2>
    <div class="adv-bio-md">{{ . | safeHTML }}</div>
  </section>
  {{ end }}

  {{ with $a.topics }}
  <section class="adv-profile-topics">
    <h2>Topics</h2>
    <ul>
      {{ range . }}
        <li><a class="adv-chip" href="/developer-advocates/?topic={{ .slug }}">{{ .label }}</a></li>
      {{ end }}
    </ul>
  </section>
  {{ end }}

  <div id="advocate-profile-mount"
       data-slug="{{ .Params.slug }}"
       data-api="/api/advocates/{{ .Params.slug }}"></div>
</main>

<script type="module" src="{{ "/js/advocate-profile.js" | relURL }}"></script>
{{ end }}
```

Meta tags emitted from frontmatter in `hugo/layouts/partials/head.html`
(if a head partial exists) or via the `single.html` head block:

```html
<title>{{ $a.firstName }} {{ $a.lastName }} · SAP Developer Advocates</title>
<meta name="description" content="{{ $a.bioText }}">
<meta property="og:type" content="profile">
<meta property="og:title" content="{{ $a.firstName }} {{ $a.lastName }} · SAP Developer Advocates">
<meta property="og:description" content="{{ $a.bioText }}">
{{ if $a.hasPhoto }}<meta property="og:image" content="https://developers.sap.com/api/advocates/{{ .Params.slug }}/photo">{{ end }}
```

Topic chips link back to the directory page with a `?topic=<slug>` query
that the existing
[hugo-apps/src/advocates/composables/useAdvocateFilter.ts](../../../hugo-apps/src/advocates/composables/useAdvocateFilter.ts)
already understands (it reads filter state from URL hash; we add query
parameter parity in the same composable so direct links from profile
chips work — see Task notes below).

### 4. Vue island — `hugo-apps/src/advocate-profile/`

A new entry in
[hugo-apps/vite.config.ts](../../../hugo-apps/vite.config.ts) that emits
`hugo/static/js/advocate-profile.js`. Mounts on
`#advocate-profile-mount`. Fetches `data-api` (the
`/api/advocates/<slug>` route), then renders three sections:

```
Tutorials authored (N)
  • Title — link to /tutorials/<slug>/
  ...

Tutorials contributed to (N)
  • ...

Missions curated (N)
  • Title — link to /build/missions/<slug>/   (existing mission page)
  ...

Groups curated (N)
  • Title — link to /build/groups/<slug>/
  ...
```

Each section is hidden when its array is empty (matches the existing
card-back gating pattern in `AdvocateCard.vue`). On 404 the island
renders a small "this advocate is no longer listed" banner. On generic
fetch error the island renders nothing (the static page is still
useful).

**Bundle budget:** ≤ 25 KB gzip enforced by a new `advocateProfileBudget()`
clone of the existing `advocatesBudget()` helper in
[hugo-apps/vite.config.ts](../../../hugo-apps/vite.config.ts).

**A11y:** Section headings use `<h2>`; lists use `<ul>`; each link
carries a meaningful `aria-label` when the visible text is the
tutorial title alone.

### 5. Card → page link

`AdvocateCard.vue` change:

```js
// Before
const profileUrl = computed(() => {
  const order = ['Blog','SapCommunity','LinkedIn','GitHub','X','BlueSky','Mastodon','YouTube','Email'];
  for (const k of order) {
    const link = props.advocate.links.find(l => l.kind === k);
    if (link) return link.url;
  }
  return null;
});

// After
const profileUrl = computed(() => `/developer-advocates/${props.advocate.slug}/`);
```

The external profile icons in `.adv-links` keep their existing `<a>`
elements pointing at the social URLs. The card-back "View profile →"
button now points internally. We also drop `target="_blank"` from the
"View profile →" since it's an in-site navigation.

## Data flow summary

| Step | Source | Trigger |
| --- | --- | --- |
| Build static page | `fetch-advocates.ts` → `/api/advocates` | `npm run fetch-tutorials`, CI `rebuild-content.yml` |
| Live tutorial / mission / group list | `/api/advocates/<slug>` | Browser hits the page |
| Photo | `/api/advocates/<slug>/photo` | Browser renders `<img src>` (cached 24h) |
| Bio render | `marked` + sanitizer at build time | Build step |

## Failure modes

| Scenario | Behavior |
| --- | --- |
| `fetch-advocates.ts` 500 at build time | Build fails loudly (`process.exit(1)`). Same as `fetch-tutorials.ts` today. |
| New advocate created in admin, no rebuild yet | Page returns Hugo 404. Mitigation: admin dispatches `rebuild-content` from the admin UI; expected ~10 min wall-clock for full rebuild. The grid card still shows them inside 60s though, and the "View profile →" 404 is recoverable. |
| Advocate deactivated since last rebuild | Static page still renders; live fetch 404s; island shows "no longer listed" banner. |
| `/api/advocates/:slug` returns 5xx | Island renders no extra sections; static page is still complete. |
| Bio is plain text (no markdown formatting) | `marked` returns plain `<p>` text. Links auto-detect via the markdown spec. Looks fine. |
| Bio contains script injection attempt | Sanitizer strips it at build time. The Hugo `safeHTML` only sees the sanitized form. |

## Testing

### Unit

`test/unit/advocates/`:

- `advocate-single-route.test.js` — new. SQLite seed of one advocate
  + linked user + 3 tutorials + 1 mission + 1 group. Hit
  `/api/advocates/<slug>` and verify shape, ETag, 304, 404 for unknown
  slug, 404 for inactive.
- `fetch-advocates.test.js` — new. Mock `/api/advocates`; assert
  `<slug>.md` files emitted with expected frontmatter, including
  rendered `bioHtml`. Test cache hit (no re-fetch when SHA matches).
  Test stale-cleanup (advocate removed from API → its `<slug>.md`
  deleted).

`test/unit/build-pipeline/`:

- `sanitize-bio-markdown.test.js` — new. Pass `<script>` payloads
  through the sanitize chain; assert clean output.

`hugo-apps/src/advocate-profile/`:

- `App.test.ts` — new. Vue Testing Library. Mock `fetch`, render with
  one advocate including all sections, assert each list renders.
- `App.empty-state.test.ts` — fetch returns 404 → "no longer listed"
  banner.

### Hybrid (`test/hybrid/`)

- `advocate-profile-route.test.js` — new, gated by
  `ALLOW_HYBRID_WRITES=true`. Seeds an advocate + linked user + one
  authored tutorial + one mission + one group on real HANA, hits
  `/api/advocates/<slug>`, asserts shape. Cleans up in `afterAll`
  using `__TEST__`-prefixed slugs.

### Smoke (`test/smoke/`)

- Extend `advocates.smoke.test.js`:
  - `GET /developer-advocates/<known-slug>/` returns 200 + has
    `og:title` meta + has `og:image` meta.
  - `GET /api/advocates/<known-slug>` returns 200 + valid JSON shape.
  - `GET /api/advocates/__does-not-exist__` returns 404.

## Files added / modified

**Added:**

- `srv/routes/advocates-public.js` — extend with `handleSingle()` + route registration
- `scripts/fetch-advocates.ts` — build-time roster fetcher
- `hugo/layouts/developer-advocates/single.html` — page layout
- `hugo/layouts/developer-advocates/baseof.html` (only if list.html
  doesn't already inherit from a base that gives head + body)
- `hugo-apps/src/advocate-profile/App.vue` + `main.ts` + components
- `hugo-apps/src/advocate-profile/styles.css`
- `test/unit/advocates/advocate-single-route.test.js`
- `test/unit/advocates/fetch-advocates.test.js`
- `test/hybrid/advocate-profile-route.test.js`
- `docs/superpowers/specs/2026-06-27-601-advocate-profile-pages-design.md` (this file)

**Modified:**

- `hugo-apps/vite.config.ts` — new entry + bundle budget
- `hugo-apps/src/advocates/components/AdvocateCard.vue` — repoint `profileUrl`
- `hugo-apps/src/advocates/composables/useAdvocateFilter.ts` — accept
  `?topic=<slug>` query parameter on initial load (for profile-page topic chip links)
- `package.json` — add `fetch-advocates` script if separate; otherwise
  wire into `fetch-tutorials` chain
- `srv/routes/advocates-public.js` — new handler + route
- `test/smoke/advocates.smoke.test.js` — three new assertions
- `docs/developers/architecture/advocates.md` — document the new page + endpoint

## Open questions and assumptions

1. **`marked` availability.** The build pipeline already uses
   markdown parsing for tutorial steps. Confirm `marked` is in
   `package.json` (or pick the same library the existing tutorial
   parser uses). If not, add it as a `devDependency`.
2. **Topic chip target URL.** Spec assumes
   `/developer-advocates/?topic=<slug>` parses as a filter. The
   existing filter composable reads from URL hash (`#topic=`);
   adding query-parameter support is a small composable change
   covered in the file list. Alternatively, link to
   `/developer-advocates/#topic=<slug>` and accept the `#` in the URL.
3. **Mission / Group "View" URLs.** The spec assumes
   `/build/missions/<slug>/` and `/build/groups/<slug>/` work as
   public URLs. Verify against the existing Hugo nav and the
   `/build/navigator` data shape during implementation; adjust to
   whatever the canonical public URL turns out to be.
4. **og:image absolute URL.** Build-time emit hardcodes
   `https://developers.sap.com` in the meta tag. Make this a
   Hugo site param so QA and DEV emit their own canonical hosts.
5. **Photo size on profile page.** Spec calls for the 256×256 source
   displayed at ~200×200. If that's too small for a hero, we ship the
   same source and let CSS scale it; the existing `photo256` resize
   is the only artifact in HANA. A larger source variant is a
   future-friendly change tracked outside this issue.

## Acceptance criteria

- [ ] `GET /developer-advocates/<slug>/` returns 200 HTML with
  `<title>`, `og:title`, `og:description`, `og:image` (when
  `hasPhoto`), `og:type=profile` meta tags.
- [ ] The page hero shows photo (or initials), name, pronouns,
  title, location, region, social-link icons — all in static HTML.
- [ ] The bio renders as HTML (formatted markdown). Plain-text bios
  still display correctly.
- [ ] After hydration, the page lists tutorials authored, tutorials
  contributed to, missions curated, and groups curated, each linked
  to the corresponding canonical URL.
- [ ] The existing roster grid card's "View profile →" button
  navigates to the internal page (not the first external profile).
- [ ] Topic chips on the profile page link back to the directory
  page with that topic pre-filtered.
- [ ] `GET /api/advocates/__does-not-exist__` returns 404.
- [ ] Deactivating an advocate hides their profile page on next
  `rebuild-content` run; visiting the stale URL between
  deactivation and rebuild shows a small "no longer listed" banner
  via the island's 404 handling.
- [ ] Bundle for `advocate-profile.js` is ≤ 25 KB gzip; budget
  check is enforced at build time.
- [ ] Unit, hybrid, and smoke tests all green.

## References

- Issue [#601](https://github.com/sap-tutorials/tutorials-ims/issues/601)
- Predecessor spec [2026-06-17 developer advocates design](2026-06-17-developer-advocates-design.md)
- Predecessor spec [2026-06-25 advocate-user-link design](2026-06-25-advocate-user-link-design.md)
- [docs/developers/architecture/advocates.md](../../developers/architecture/advocates.md)
- [docs/developers/operations/rebuild-content-workflow.md](../../developers/operations/rebuild-content-workflow.md)
