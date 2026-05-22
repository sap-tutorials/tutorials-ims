# Tutorial Improvements

Forward-looking roadmap for tutorial-page enhancements that the new stack (CAP + HANA + embeddings + STOMP + modern UI) makes possible. AEM could not host most of these.

Each item lists: **what**, **why it matters**, **starting point in the code**, **rough effort**, **main tradeoff**. Items are roughly ordered by leverage / cost ratio — not strict priority. Pick one per weekend.

---

## 1. Contextual Joule help per step

**What:** Floating "stuck on this step?" button on every tutorial page. Opens Joule chat pre-seeded with the current slug, current step number, and the user's progress on this tutorial.

**Why it matters:** Joule plumbing is already wired (`getRelevantSteps`, `getUserProgress`, RAG embeddings in `TutorialEmbedding`). Today the chat is generic; tying it to *this step* is where it actually helps. Highest user-delight per build hour.

**Starting point:**
- Hugo layout: `hugo/layouts/tutorials/single.html` — add the floating action button per step
- Joule entry: existing chat tile; pass `slug`, `stepIndex`, `userId` as initial context
- Tools already present: `srv/lib/embedding-query.js`, `srv/joule-chat-service.js`

**Effort:** S (1 weekend)

**Tradeoff:** Recurring AI cost scales with usage. Mitigation: cache common Q&A per (slug, step) hash.

---

## 2. Author drop-off analytics per step

**What:** Instrument `/content/tutorials/:slug` to log step-level engagement (which step opened, time on step, scroll depth, Joule invocations from the step). Surface in the admin shell as a per-tutorial dashboard.

**Why it matters:** Content-quality flywheel. Authors today get GitHub stars and issue counts — they have no idea where readers stall. Cheapest *durable* win in the list; data compounds.

**Starting point:**
- CAP entity: new `db/schema.cds` entity `TutorialStepEvents` (slug, stepIndex, userId, eventType, timestamp)
- Hook on serve: `srv/lib/content-store.js` already serves the HTML — add a sibling `/content/events` POST endpoint
- Client beacon: small script injected into the Hugo template using `navigator.sendBeacon`
- Dashboard: new tile in `app/admin-shell/` referencing existing chart components

**Effort:** M (1–2 weekends)

**Tradeoff:** Adds writes on every page interaction — needs aggregation strategy (probably a daily rollup table) before it scales.

---

## 3. AI-generated TL;DR / "What you'll learn" card

**What:** A summary card rendered above step 1 of every tutorial: 2-sentence overview, prerequisites, estimated time, "you'll be able to…" bullets. Generated *at publish time*, not at request time.

**Why it matters:** Reduces bounce rate — readers know what they're committing to. Generation cost is one-shot per content version.

**Starting point:**
- Generation: extend `scripts/publish-content.ts` to call an LLM per changed slug, store result alongside the HTML
- Storage: extend `ContentFiles` or add a sibling `ContentSummary` entity (small JSON)
- Render: Hugo partial in `hugo/layouts/partials/`, hydrated from `/content/tutorials/:slug` response or a dedicated `/content/summary/:slug`

**Effort:** S–M

**Tradeoff:** AI may hallucinate prerequisites — need an authoring-time review gate or "regenerate" button in admin UI.

---

## 4. Step-level verification (not self-attestation)

**What:** For BTP/CAP/GitHub-flavored steps, *verify* completion: poll a destination, check that a CAP entity exists, hit the GitHub API to confirm the user pushed a repo. Mark step as `VERIFIED` vs just `CLICKED_DONE`.

**Why it matters:** Turns tutorials into credentials. Aligns with SAP Learning Journeys without needing a separate platform. Big strategic move.

**Starting point:**
- Schema: new step-frontmatter field `verification: { type, params }` parsed in `scripts/parsers/`
- Verifier registry: `srv/lib/verifiers/` with one module per type (github-repo, cap-entity, btp-destination, http-200)
- API: extend `DeveloperService` with `verifyStep(slug, stepIndex)` action returning verification result
- UI: replace "Mark complete" with "Check my work" on verified steps

**Effort:** L (multi-weekend; per verifier-type incremental)

**Tradeoff:** Each verifier is bespoke. Start with one type (github-repo-exists) and expand. False negatives will frustrate users — needs a manual override.

---

## 5. Personalized "what's next" on completion

**What:** When a user completes a tutorial, replace the static mission-defined order with a personalized recommendation based on embeddings + their progress + what similar learners did next.

**Why it matters:** Embeddings already exist. Mission-curated order is great for structured paths but ignores the long tail of self-directed learners.

**Starting point:**
- Recommender: new tool / endpoint reusing `srv/lib/embedding-query.js` with a "similar to completed, not yet completed by user" CQL
- Hugo partial: completion screen at end of last step
- Reuse `getUserProgress` for the personalization

**Effort:** S–M

**Tradeoff:** Needs critical mass of completion data to outperform curated paths — may underwhelm for niche tutorials. Show curated path *and* recommendations side-by-side initially.

---

## 6. Per-tutorial bookmarks + private notes

**What:** Logged-in users can bookmark tutorials and attach private notes per tutorial (or per step). Notes shown in a side panel.

**Why it matters:** Trivial CAP entity, very high user value. AEM had no equivalent.

**Starting point:**
- Schema: `UserBookmarks { user, slug, createdAt }`, `UserNotes { user, slug, stepIndex, body, updatedAt }` in `db/schema.cds`
- Service: extend `DeveloperService`
- UI: side drawer in Hugo template; "My Bookmarks" view in user profile area

**Effort:** S

**Tradeoff:** GDPR — these are personal data, need `@PersonalData` annotations and inclusion in user anonymization.

---

## 7. "N people doing this tutorial right now" + cohort presence

**What:** Live counter on each tutorial page showing concurrent readers, fed by the existing STOMP broker. Optional event-mode where a host can broadcast notes.

**Why it matters:** STOMP is already running for the dashboard. Social proof on tutorial pages costs almost nothing extra and creates a differentiator vs. static docs.

**Starting point:**
- Broker: `srv/server.js` STOMP setup; add `/topic/tutorial/<slug>/presence`
- Client: small JS in Hugo layout subscribes on page load, unsubscribes on unload
- Event mode: gated by an `Events.liveBroadcastEnabled` flag

**Effort:** M

**Tradeoff:** STOMP fan-out cost at scale; need a presence aggregator if usage grows. Privacy: counts only, not identities.

---

## 8. Inline executable CAP/CDS snippets

**What:** Embed a `cds repl`-style sandbox or StackBlitz/WebContainers iframe for code blocks tagged `runnable`. Reader can edit and run without leaving the page.

**Why it matters:** Largest friction reduction for CAP tutorials specifically — "now switch to your terminal" is the #1 drop-off point.

**Starting point:**
- Parser: extend `scripts/parsers/` to recognize a `runnable` fence-info tag
- Embed: WebContainers (StackBlitz SDK) is the fastest path; iframe per snippet
- Hugo shortcode for the embed

**Effort:** M–L

**Tradeoff:** WebContainers don't run native modules (HANA driver) — limited to pure-CDS / SQLite examples. Frame as "try the model" not "run the full stack."

---

## 9. Diff view for code-heavy consecutive steps

**What:** When two consecutive steps both contain a `package.json` (or any same-named file), render a `difft`-style structural diff between them so readers see exactly what changed.

**Why it matters:** RAP/CAP tutorials iterate on the same files repeatedly. Today readers diff in their head; this surfaces the delta.

**Starting point:**
- Build-time diff in `scripts/parsers/` — when the same filename appears in adjacent steps, compute the diff and stash it as a sibling code block
- Hugo shortcode `{{< diff >}}`

**Effort:** S–M

**Tradeoff:** Heuristic for "same file" can be wrong — needs an author opt-in/out frontmatter flag.

---

---

## UI-focused ideas

These lean into reusable Fiori constructs (UI5 Web Components + Fiori Elements layout patterns) plus modern UI primitives we can theme to feel Horizon-native.

**Stack note:** The Hugo public site currently uses **SAP Fundamental Styles** (CSS-only). Adopting `@ui5/webcomponents` (framework-agnostic custom elements with the `sap_horizon` theme) for selected widgets is a small dependency add — they work natively inside Hugo templates and Vue components. Many ideas below assume this; it is itself a small decision (U0) worth making explicitly.

---

## U0. Adopt @ui5/webcomponents on the public site — Done 2026-05-22

**Status:** Shipped on branch `ui-pilot/u0-u3-u5`. Bootstrap at [hugo/assets/js/ui5-bootstrap.ts](hugo/assets/js/ui5-bootstrap.ts) imports `@ui5/webcomponents` + `-fiori`, registers both `sap_horizon` and `sap_horizon_dark` via `Assets.js`, syncs theme to `data-theme` via a MutationObserver. Per-icon imports keep the bundle lean.

**What:** Add `@ui5/webcomponents` (and optionally `-fiori`) to the Hugo build. Theme via `<ui5-config>` + `setTheme('sap_horizon')` / `'sap_horizon_dark'`. Coexists with Fundamental Styles.

**Why it matters:** Unlocks U1–U13 below as one-liners instead of bespoke components. Same theme as the admin shell — visual consistency across the platform.

**Starting point:**
- `hugo/layouts/_default/baseof.html` — add ESM import + theme config
- Hugo Pipes for asset handling, or pin a CDN version for simplicity at first
- Verify CSP + shadow-DOM interactions with current Vue islands in `apps/`

**Effort:** S (foundation — half a day)

**Tradeoff:** Extra ~150 KB gzipped if everything is loaded. Mitigation: import only the components you use; many tutorials' pages won't need any.

---

## U1. Tutorial page as a Fiori Object Page — Done 2026-05-22

**What:** Replace the current single-column tutorial layout with the **Object Page** pattern: a sticky header with title / time / level / tags / completion ring, an **anchor bar** of tabs (`Overview` · `Prerequisites` · `Steps` · `Resources` · `Discussion`), and scroll-spy sections that highlight the active tab.

**Why it matters:** This is the most Fiori-native layout possible for a content-heavy entity page. Immediately recognizable to SAP devs, scales to long tutorials, and the anchor bar solves "where am I?" without ad hoc TOC code.

**Starting point:**
- Hugo template: `hugo/layouts/tutorials/single.html` — restructure into header + anchor + sections
- Use `ui5-tabcontainer` (`fixed`, `tabsPlacement="Top"`) for the anchor bar, or build with Fundamental Styles `ObjectPage` if you stay CSS-only
- Reference: Fiori Elements Object Page floorplan

**Effort:** M

**Tradeoff:** Touches every tutorial layout — needs a pass over all parser variants (V1/V2). Worth it once.

---

## U2. ui5-wizard for step navigation — Done 2026-05-22

**What:** Render the steps using `ui5-wizard`. Step indicators across the top show name + completion icon; click to jump; current step is highlighted.

**Why it matters:** `ui5-wizard` was literally designed for guided multi-step flows. Replaces the bespoke "next/previous step" buttons with a Fiori-native pattern that also doubles as visual progress feedback.

**Starting point:**
- `hugo/layouts/partials/tutorial-steps.html` — wrap each step in `<ui5-wizard-step>`
- Pre-mark completion from `getUserProgress`
- `selection-change` event drives URL fragment for deep-linking

**Effort:** M

**Tradeoff:** `ui5-wizard` is a significant component — overkill for very short tutorials (1–2 steps). Render conditionally based on step count.

---

## U3. ui5-shellbar as the global header — Done 2026-05-22

**Status:** Shipped on branch `ui-pilot/u0-u3-u5`. [hugo/layouts/partials/header.html](hugo/layouts/partials/header.html) now uses `ui5-shellbar` with profile avatar, navigation/share/help/theme/trust popovers, and an auth-aware user popover. Share popover absorbed the old action-bar (Feedback + Share This Tutorial sections, tutorial-only). Sticky prev/next footer added in [hugo/layouts/partials/feedback-share.html](hugo/layouts/partials/feedback-share.html).

**What:** Replace the current top nav with `ui5-shellbar`: logo, primary title, search slot, profile menu, notifications icon, theme toggle. Same component already shipping in the admin shell.

**Why it matters:** One header pattern across public + admin. Free polish, instant visual coherence with SAP product UX.

**Starting point:**
- `hugo/layouts/partials/header.html`
- Reuse the icon/logo assets from `app/admin-shell/`
- Search slot becomes the entry point for U4

**Effort:** S

**Tradeoff:** Need to map existing routes/menu items into the shellbar's slot model. Mostly mechanical.

---

## U4. Cmd+K command palette (Horizon-themed) — Done 2026-05-22

**What:** Modern construct. `⌘K` / `Ctrl+K` opens a fuzzy palette: *jump to tutorial*, *jump to step in current tutorial*, *open Joule*, *toggle theme*, *copy URL*, *go to my progress*, *report issue*. Live results powered by the existing embeddings (semantic, not just keyword).

**Why it matters:** This is *the* modern UI primitive (Linear, GitHub, Vercel, Raycast). Power users adore it. Implementing one against the existing search infrastructure is mostly UX work.

**Starting point:**
- `cmdk` (or `kbar`) — small library, easy to theme
- Wrap in a Vue island in `apps/` so it's loaded once site-wide
- Wire to `SearchService` for tutorial search + a static action registry for navigation
- Theme: override `cmdk` CSS vars with `--sapButton_*` / `--sapList_*` from Horizon

**Effort:** M

**Tradeoff:** Discoverability — users need to learn the shortcut. Mitigation: subtle "⌘K" hint in the shellbar.

---

## U5. ui5-message-strip for content-state banners — Done 2026-05-22

**Status:** Shipped on branch `ui-pilot/u0-u3-u5`. Banners render from frontmatter signals (`updatedAt`, `deprecated`, `requiresTrial`, etc.) at the top of tutorial pages. Styling lives in [hugo/assets/css/ui5-overrides.css](hugo/assets/css/ui5-overrides.css) under `.tutorial-banners`. Verified in both light and dark themes.

**What:** Top of every tutorial page, conditional banners powered by content metadata: *"Updated 2 days ago"*, *"This tutorial uses deprecated APIs"*, *"You've already completed this — jump to the next in the mission?"*, *"This tutorial requires a free BTP trial — set one up in 5 minutes."*

**Why it matters:** Cheap, informational, deeply Fiori. Surfaces things authors and users currently miss. Pairs naturally with the freshness data already in `ContentManifest`.

**Starting point:**
- `ui5-message-strip` with `design="Information" | "Warning" | "Positive"`
- Frontmatter signal: `deprecated:`, `requiresTrial:`, etc.
- Banner state for completion: read from `getUserProgress`

**Effort:** S

**Tradeoff:** Banner fatigue — be ruthless about which banners actually warrant attention.

---

## U6. ui5-rating-indicator + feedback drawer — Done 2026-05-22

**What:** End of every tutorial: `ui5-rating-indicator` ("How was this tutorial?") plus an optional textarea ("What worked? What didn't?"). Submit goes to a `TutorialFeedback` entity feeding the author dashboard from #2.

**Why it matters:** Closes the content-quality loop. `ui5-rating-indicator` is one component; the rest is a CAP entity.

**Starting point:**
- `db/schema.cds` entity `TutorialFeedback { user, slug, rating, comment, createdAt }`
- `DeveloperService` action `submitFeedback`
- Hugo partial at end of last step

**Effort:** S

**Tradeoff:** Personal data — needs `@PersonalData` annotation. Same pattern as bookmarks (#6).

---

## U7. ui5-illustrated-message for empty/error states — Done 2026-05-22

**What:** Use the Fiori Illustrations pack for: 404, empty search results, "no progress yet on your dashboard", "this mission has no tutorials yet".

**Why it matters:** Free polish, ships in an afternoon. Replaces blank "Not found" screens with on-brand, friendly art that signals "this is an SAP product."

**Starting point:**
- `@ui5/webcomponents-fiori` adds `<ui5-illustrated-message>`
- Replace existing 404 template in `hugo/layouts/404.html`
- Wire into search "no results" state in `apps/`

**Effort:** S

**Tradeoff:** Tiny bundle size addition for the illustrations. Worth it.

---

## U8. Code-block language tabs (ui5-tabcontainer) — Done 2026-05-22

**What:** When a tutorial shows the same concept in multiple languages (Node.js / Java, JS / TS, CDS / SQL), render alternates as `<ui5-tabcontainer>` with **persistent selection** in `localStorage` — pick "Java" once, every code block site-wide remembers.

**Why it matters:** CAP tutorials in particular constantly duplicate Node.js + Java. Today both render stacked; readers scroll past their non-language. Tabs halve perceived length and respect the user's stack.

**Starting point:**
- Parser change in `scripts/parsers/` — recognize a `tabs` or paired-fence convention
- Hugo shortcode wrapping the output in `<ui5-tabcontainer>`
- Tiny JS for the `localStorage` sync (broadcast a custom event on change)

**Effort:** M

**Tradeoff:** Authoring convention needs to be documented; parser detection has edge cases. Start with a single explicit shortcode (`{{< codetabs >}}`) before auto-pairing.

---

## U9. Inline glossary tooltips with ui5-popover — Done 2026-05-22

**What:** Hover any SAP acronym in tutorial body text (BTP, CAP, RAP, CDS, MTA, XSUAA, HDI, IAS, IDP) and a Horizon-themed `ui5-popover` shows a one-line definition + a link to a longer primer.

**Why it matters:** SAP terminology is the #1 onboarding tax. Inline glossary turns every page into a self-explaining doc — especially valuable for the *Becoming a BTP Solution Architect* audience.

**Starting point:**
- `glossary.yaml` in `data/` — term → definition + link
- Build-time pass that wraps recognized terms in `<span data-glossary="...">`
- Single shared `<ui5-popover>` instance positioned dynamically on hover

**Effort:** S–M

**Tradeoff:** Risk of over-tagging (BTP appears 50 times on a page). Solution: tag only the first occurrence per page.

---

## U10. ui5-toast for step-complete feedback — Done 2026-05-22

**What:** When the user marks a step complete, show a `ui5-toast` ("Step 3 complete — 2 to go!"). When they finish the tutorial, fire a celebratory toast with a CTA to the next recommended tutorial (#5).

**Why it matters:** Tiny, polished, immediate. Currently completion is silent.

**Starting point:**
- One `<ui5-toast>` element in the Hugo layout
- JS hook on the existing "Mark complete" call

**Effort:** XS

**Tradeoff:** None worth listing — this is pure win.

---

## U11. Sticky reading-progress bar + scrollspy TOC — Done 2026-05-22

**What:** Thin Horizon-colored progress bar at the top of the viewport (% of current step scrolled). Right-rail sticky TOC of step headings with scrollspy highlighting the active section.

**Why it matters:** Long-form content cue that every modern doc site has (Stripe, Notion, Linear). Solves "how much more is there?" anxiety on long steps.

**Starting point:**
- IntersectionObserver-based scrollspy (~30 lines of vanilla JS)
- CSS-only progress bar using `scroll-timeline` where supported, fallback to JS
- Theme via Horizon CSS vars (`--sapBrandColor`, `--sapList_HighlightColor`)

**Effort:** S

**Tradeoff:** Right-rail TOC fights with mobile layout — collapse into a popover on narrow screens.

---

## U12. Focus / reading mode toggle — Done 2026-05-22

**What:** Modern construct. Button (or shortcut: `f`) toggles a "reader mode": dims chrome, hides nav and side panels, increases line-height + font-size, centers content at ~70ch. Persisted to `localStorage`.

**Why it matters:** Long technical content rewards a distraction-free mode. Power users who already know the surrounding nav will live in this mode.

**Starting point:**
- Single `data-reader="on"` attribute on `<html>`
- CSS rules cascade off it
- Toggle button in the shellbar (U3)

**Effort:** S

**Tradeoff:** Designing the dimmed/hidden state for every page section is fiddlier than it sounds. Start with the tutorial reader, expand later.

---

## U13. Mermaid diagrams with Horizon palette — Done 2026-05-22

**What:** Render Mermaid blocks (architecture diagrams, flowcharts, sequence diagrams) using Horizon brand colors instead of Mermaid defaults — by injecting CSS variables matching `sap_horizon` / `sap_horizon_dark`.

**Why it matters:** Architecture tutorials lean heavily on diagrams; today they look like a third-party widget. Themed diagrams reinforce brand and adapt to dark mode automatically.

**Starting point:**
- Mermaid initialize with `theme: 'base'` and `themeVariables` mapped from Horizon CSS vars
- Re-render on theme toggle event
- Hugo shortcode `{{< mermaid >}}`

**Effort:** S

**Tradeoff:** Mermaid theming has quirks; some diagram types (gitGraph) don't honor all variables. Start with flowchart + sequence.

---

## Holding pen (lower priority but interesting)

### Original

- **Voice / TTS narration** for accessibility + commute learning
- **Spaced-repetition quizzes** built on the existing `rules.vr` validation data
- **Achievement / streak system** beyond accomplishments
- **AI translation on demand** (project is currently English-only by policy — would need a strategy decision first)
- **Auto-link related SAP YouTube videos** via `sap-devs-server` `search_videos`

### UI follow-ups

- **Skeleton loaders** (Horizon-themed) while CAP-served HTML is fetching
- **Image lightbox / zoom** for tutorial screenshots — themable with Horizon chrome
- **`ui5-side-navigation` drawer** showing all tutorials in the current mission with completion icons
- **Per-step `ui5-rating-indicator`** ("How confident are you?") feeding spaced repetition + author analytics
- **`ui5-timeline`** on the user profile showing learning history (completions, accomplishments, prizes)
- **`ui5-busy-indicator` + bottom sheet** for mobile step navigator
- **Drag-to-reorder steps** in admin authoring tools using `ui5-list` sortable
- **Live preview pane** (split view) when editing tutorial markdown in admin

---

## Notes for picking the first one

- **Cheapest "feels new" win:** U10 step-complete toast — XS effort, immediately visible. Or U7 illustrated empty/404 states for sitewide polish in an afternoon.
- **Highest leverage if you have a weekend:** #1 contextual Joule help — reuses existing wiring, biggest user-perceived improvement.
- **Best long-term investment:** #2 author analytics — every later improvement gets easier once you can measure impact.
- **Most strategic:** #4 step verification — repositions the platform.
