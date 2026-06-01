# Reduce navigation flash on tutorial detail pages

**Issue:** [sap-tutorials/tutorials-ims#156](https://github.com/sap-tutorials/tutorials-ims/issues/156)
**Date:** 2026-06-01
**Scope:** Polish on the home-page → tutorial-detail navigation experience.

## Problem

When the user clicks an entry under "Recently updated tutorials" on the
home page (`/`), they see a brief visual flash before the tutorial body
arrives. Daniel Wroblewski reported this as feedback on 2026-06-01.

The flash is **partly intentional**: tutorial pages are server-rendered as
static Hugo HTML so AI crawlers (which don't execute JavaScript) get the
real content. After the static paint, several JS layers hydrate:

- [tutorial-breadcrumbs/main.ts](../../../hugo-apps/src/tutorial-breadcrumbs/main.ts)
  may rewrite parent group/mission titles (only fires visibly if a parent
  was renamed since last build).
- [tutorial.ts](../../../hugo/assets/js/tutorial.ts) calls `/getProgress`,
  fills `.progress-segment` and `.step-check-circle`, and flips
  `html[data-hydrated="false"]` → `"true"` on resolution or after the
  1.5 s race ([head.html:50-55](../../../hugo/layouts/partials/head.html#L50-L55)).
- 5 Vue islands (pip-launcher, rating, prefs, feedback, plus
  ui5-bootstrap registering web components) mount within the first
  ~200 ms.

The
[skeleton shimmer rule](../../../hugo/assets/css/skeletons.css#L14-L29)
already masks the progress-bar flash via `html[data-hydrated="false"]`, but
nothing today smooths the title's repositioning between the recent-tutorials
card and the tutorial hero `<h1>`. That visual jump is the dominant
"flash" the user perceives.

A View Transitions title morph is **already shipped** for the
[tutorial-navigator grid](../../../hugo-apps/src/navigator/TutorialNavigator.vue#L740) —
clicking a navigator card morphs the card title into the hero title across
the document boundary
([view-transitions.ts:28-52](../../../hugo/assets/js/view-transitions.ts#L28-L52),
[view-transitions.css:1-14](../../../hugo/assets/css/view-transitions.css#L1-L14)).
The Recently-updated list and the cmd-palette tutorial results don't
participate in this morph because their markup lacks the
`data-vt-card="navigator"` and `nav-card__title` hooks the binder looks
for.

## Approach

Two independent, additive interventions. Neither hides any HTML from
crawlers — both layers are progressive enhancements gated on browser
support.

### Intervention A — Extend cross-document View Transitions

Re-use the already-shipped morph by adding the two markup hooks to the
two surfaces that need them:

1. **Home page recent-tutorials list** — [hugo/layouts/index.html:38-46](../../../hugo/layouts/index.html#L38-L46).
   Each `<a>` gets `data-vt-card="navigator"` and the `<h3>` inside gets
   `class="nav-card__title"`. No JS change — the existing
   `bindCardClick` listener on `document` (registered once at module load)
   matches by selector.

2. **Cmd-palette tutorial results** — [hugo-apps/src/cmd-palette/CommandPalette.vue:46-63](../../../hugo-apps/src/cmd-palette/CommandPalette.vue#L46-L63).
   Tutorial result rows are currently rendered as `<button @click="runItem">`
   that programmatically navigates via `window.location.href`. Replace
   the `<button>` with an `<a href="/tutorials/{slug}">` carrying
   `data-vt-card="navigator"` and a `<span class="nav-card__title">{title}</span>`.
   The default browser navigation triggers the cross-doc VT, identical
   to a navigator-grid click. `runItem` becomes a fallback only invoked
   for keyboard `Enter` selection (which programmatically clicks the
   anchor instead of using `location.href`).

   Action rows (commands like "copy URL", "report issue") stay as
   `<button>` — they don't navigate to a tutorial.

The destination side ([u1-object-page.html:192](../../../hugo/layouts/tutorials/u1-object-page.html#L192))
is unchanged: `<h1 class="op-header__title tutorial-hero-title">` already
has `view-transition-name: hero-title` declared in
[view-transitions.css](../../../hugo/assets/css/view-transitions.css).

The browser handles the morph itself. Browsers without cross-doc View
Transitions (today: Firefox, Safari < 18) fall through to plain
navigation — no flash regression vs. today.

### Intervention B — Hover-based prerender via speculationrules

Add a JSON `<script type="speculationrules">` block to
[hugo/layouts/partials/head.html](../../../hugo/layouts/partials/head.html)
gated to non-tutorial pages:

```html
{{ if not (eq .Type "tutorials") }}
<script type="speculationrules">
{
  "prerender": [{
    "where": { "and": [
      { "href_matches": "/tutorials/*" },
      { "not": { "selector_matches": ".no-prerender, .no-prerender a" } }
    ]},
    "eagerness": "moderate"
  }]
}
</script>
{{ end }}
```

`eagerness: "moderate"` is the Chromium-defined trigger that fires on
~200 ms `pointerover` or on `pointerdown` — exactly the hover-intent
behaviour we want. The browser prerenders the URL in a hidden tab; on
click the swap is instant (full hydration completed in the background).

Gating to `not (eq .Type "tutorials")` keeps the rule off the tutorial
detail pages themselves — tutorials cross-link heavily to other tutorials
inside their bodies, and we don't want a hover on a content link to
trigger a prerender mid-read. The home page, navigator, group/mission
landing pages, and any page that can host the cmd-palette all keep the
rule.

The `selector_matches` exclusion gives us a `.no-prerender` opt-out class
we can sprinkle on individual links if we discover a problem case (e.g.
a tutorial that tracks impressions on hover). None ship today; the hook
is preventative.

Browsers without speculationrules support (everything except recent
Chromium) ignore the entire `<script type="speculationrules">` block — no
behavior change.

## Out of scope

- Static `<link rel="prefetch">` on the top 6 recent tutorials. Per
  Tom: audience and topic mix are too diverse for a 6-URL prediction to
  pay off vs. the bandwidth cost.
- Eager prerender. Same reasoning.
- Extending the `data-hydrated` shimmer to the breadcrumb container.
  [tutorial-breadcrumbs/main.ts](../../../hugo-apps/src/tutorial-breadcrumbs/main.ts)
  only rewrites text when the parent was renamed since the last Hugo
  build — visibly no-op on the common click. Not worth the
  coordination overhead (per-element `data-bc-loaded` flag, additional
  CSS selectors).
- Reducing actual hydration work (collapsing islands, deferring fetches).
  Bigger architectural moves; this PR stays non-invasive.
- Touching the navigator-grid morph itself — already works.

## Implementation

### 1. `hugo/layouts/index.html` (recent-tutorials block)

```diff
   <ul class="tutorial-grid">
     {{ range first 12 (where .Site.RegularPages "Type" "tutorials").ByLastmod.Reverse }}
     <li>
-      <a href="{{ .RelPermalink }}">
-        <h3>{{ .Title }}</h3>
+      <a href="{{ .RelPermalink }}" data-vt-card="navigator">
+        <h3 class="nav-card__title">{{ .Title }}</h3>
         <p>{{ .Params.description | truncate 140 }}</p>
         <p class="meta">{{ .Params.level }} · {{ .Params.time }} min</p>
       </a>
     </li>
     {{ end }}
   </ul>
```

The `nav-card__title` class is **also** styled by
`hugo-apps/src/navigator/style.css` (or the navigator's scoped styles).
Verify on implementation that adding it to the home `<h3>` doesn't
inherit unexpected typography — if it does, scope the existing rule to
`.nav-card .nav-card__title` instead of bare `.nav-card__title`. The
`bindCardClick` selector
([view-transitions.ts:22](../../../hugo/assets/js/view-transitions.ts#L22))
queries `.nav-card__title` regardless of ancestor — so the class on the
home `<h3>` is sufficient for the binder to find it.

### 2. `hugo-apps/src/cmd-palette/CommandPalette.vue`

Replace the tutorial-results `<button>` with an `<a>`:

```vue
<a
  v-for="(item, i) in tutorialResults"
  :key="`t-${item.id}`"
  :href="`/tutorials/${tutorialSlugFromAction(item)}`"
  :class="['cmdk__item', 'cmdk__item--link', { 'cmdk__item--active': activeIndex === actionResults.length + i }]"
  data-vt-card="navigator"
  role="option"
  :aria-selected="activeIndex === actionResults.length + i"
  @mouseenter="activeIndex = actionResults.length + i"
  @click="onTutorialClick($event, item)"
>
  <span class="cmdk__item-icon" data-icon="course-book" aria-hidden="true"></span>
  <span class="cmdk__item-content">
    <span class="cmdk__item-label nav-card__title">{{ item.label }}</span>
    <span v-if="item.hint" class="cmdk__item-hint">{{ item.hint }}</span>
  </span>
</a>
```

Where:

- `tutorialSlugFromAction(item)` — small helper that extracts the slug
  the existing `runItem` was already deriving from `item.id` /
  `item.run`. The current handler in
  [CommandPalette.vue:189-192](../../../hugo-apps/src/cmd-palette/CommandPalette.vue#L189-L192)
  has `window.location.href = \`/tutorials/${row.slug}\`` inline — pull
  the slug onto the `PaletteAction` shape (or compute it where the
  result is built in `searchTutorials`) so it's available declaratively
  for `:href`.
- `onTutorialClick($event, item)` — closes the palette overlay
  (`close()`) and lets the default link navigation proceed (no
  `preventDefault`). The browser handles VT.
- Keyboard `Enter` already calls `runItem`; update `runItem` for
  tutorial rows to **programmatically click the anchor** (via a `ref`
  or by querying the active row) so the cross-doc VT fires for keyboard
  navigation too. Avoid `window.location.href` for tutorial rows —
  programmatic location changes don't trigger cross-doc VT.

The CSS selector `.cmdk__item` likely styles a `<button>` — ensure
`<a class="cmdk__item">` renders identically (no underline, inherited
color, no default visited state). Add a defensive
`.cmdk__item--link { color: inherit; text-decoration: none; }` if
needed.

### 3. `hugo/layouts/partials/head.html`

Append the speculationrules block after the existing `<script>` block
ending at line 77, gated by `{{ if not (eq .Type "tutorials") }}`. The
exact JSON is in the Approach section above.

Place it OUTSIDE the existing inline `<script>` (it's a separate
script type and the parser won't execute it as JS).

### 4. No CSS changes required

The `view-transition-name: hero-title` declaration on
`.tutorial-hero-title` is already in
[view-transitions.css:1-14](../../../hugo/assets/css/view-transitions.css#L1-L14)
and is gated by `@supports (view-transition-name: none)` and
`prefers-reduced-motion: no-preference`. No additions needed.

## Verification

Manual on deployed dev (full MTA deploy required to refresh the home
page + cmd-palette bundles):

1. **VT — home page recent-tutorials.** Open the home page in
   Chrome/Edge ≥ 126. Click a card under "Recently updated tutorials".
   Expected: title smoothly morphs from card position to hero `<h1>`
   position. Pre-fix: title disappears from the card and pops in at the
   hero with no animation.
2. **VT — cmd-palette tutorial result.** Press `⌘K` / `Ctrl K`. Type a
   query that returns tutorial results. Click one. Expected: title
   morphs from the palette row into the hero `<h1>`.
3. **VT keyboard.** Same as 2 but press `Enter` instead of click.
   Expected: same morph.
4. **VT fallback.** Open Firefox or Safari < 18. Both navigations work,
   no animation, no regression vs. today.
5. **Speculationrules — hover.** In Chrome, open DevTools → Application
   → Speculative loads. Hover a recent-tutorial card for ~300 ms. Expected:
   "Ready" entry appears for that URL. Click it. Expected: instant
   load, no flash, hydration already complete.
6. **Speculationrules — gating.** Navigate into a tutorial detail page.
   View source. Expected: no `<script type="speculationrules">` block
   present (page type is `tutorials`).
7. **Crawler safety.** Navigate to a tutorial. View source (not DevTools).
   Expected: full breadcrumb labels, full content body, hero `<h1>` text
   all in the static HTML — no `data-hydrated="false"` collapse hides
   anything from someone using `curl`.
8. **Lighthouse.** Run a Lighthouse SEO audit on the home page and a
   tutorial page. Expected: scores unchanged from baseline.
9. **Reduced-motion.** Set `prefers-reduced-motion: reduce` (DevTools
   Rendering → Emulate CSS media feature). Click a recent-tutorials card.
   Expected: navigation is instant with no morph (the existing
   `@media (prefers-reduced-motion: no-preference)` guard around the
   declarative VT name suppresses the animation; speculationrules is
   independent of motion preference and still benefits the user).

Smoke and unit tests: no changes needed. Existing
[test/smoke/](../../../test/smoke/) coverage is HTTP-level and is
unaffected by markup-class additions or `<script type="speculationrules">`
emission.

## Files touched

- [hugo/layouts/index.html](../../../hugo/layouts/index.html) — add
  `data-vt-card="navigator"` and `class="nav-card__title"` to the
  recent-tutorials list.
- [hugo-apps/src/cmd-palette/CommandPalette.vue](../../../hugo-apps/src/cmd-palette/CommandPalette.vue) —
  swap tutorial-result `<button>` for `<a>`, expose slug on
  `PaletteAction`, update keyboard-Enter handling to click the active
  anchor, add `nav-card__title` class.
- [hugo/layouts/partials/head.html](../../../hugo/layouts/partials/head.html) —
  emit speculationrules block on non-tutorial pages.

No backend, schema, route, build-pipeline, or CSS changes.
