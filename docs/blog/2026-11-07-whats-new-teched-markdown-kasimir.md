# What's new on developers.sap.com — TechEd week, a pile of new Markdown, and a cat in a tuxedo

*Posted 2026-11-07 · the stretch since our last update on October 19th*

It's been a loud three weeks. TechEd pulled a wave of event-floor features over the line, authors got a genuinely large box of new Markdown toys, and — because we apparently can't help ourselves — Kasimir the cat learned to run, jump, and fall into pits inside a Three.js arcade game that lives on the event kiosks. This post walks through all of it, from the user-facing to the load-bearing internals.

If you just want the headlines:

- **App Space** (our in-person event hub) learned to branch, fork lanes and free-order tutorial clusters, and now gates completions to the actual event window, shows a scannable prize barcode, and can quietly pull a broken track offline without republishing.
- The **Badge Scanner** got a v2: a camera that actually opens, an atomic two-prize cap, and a live event-stats panel.
- **Daily Drawings** is a new projector screen for on-stage prize draws, presented by a tuxedo-wearing Kasimir.
- Authors can now write **callouts, synced tabs, reusable snippets, smart reference links, console/diff/tree code blocks, walkthroughs, figures, image sliders, hotspots, asciinema casts, diagrams, and sortable tables** — all through a new directive grammar.
- HANA Cloud can now generate **embeddings natively in the database** via AI Core, no Node round-trip.
- And the **Kasimir Arcade** — the aforementioned cat game.

Let's dig in.

---

## Part 1 — TechEd on the event floor: App Space grows up

A quick refresher on what **App Space** is, because most of this section hangs off it. App Space is the hub we run at in-person SAP events — TechEd, Sapphire, Devtoberfest. It runs on a bank of shared kiosk laptops, reached at `/app-space/?eventId=N`. A visitor logs in with their SAP ID, picks a **track**, works through its tutorials, and earns a physical prize (a shirt, a hat) that an instructor hands over after scanning a barcode. Under the hood a track is a `CompletionPath` — an ordered set of `CompletionPathItems`, each row typed as a `TUTORIAL`, `GROUP`, `CHECKPOINT`, and so on.

Historically a track was a straight line: tutorial → tutorial → checkpoint → prize. TechEd Berlin needed more than that.

### Tracks that branch: fork lanes and free-order clusters (#2887)

Two Berlin tracks broke the linear model. One was a **fork** — "Explore Agentic AI with CAP" shares a setup, then splits into independent **MCP** and **Agents** branches. The other was a **free-order** track — a setup plus six or seven tutorials you could do in any sequence.

The elegant part is how this was built: **zero schema changes**. The whole thing keys off two fields that already existed on every path-item row — its `itemOrder` and its `taskType`. One rule drives everything:

> Path items that share the same `itemOrder` within a path are parallel.

From there the shape falls out of the type:

- One item at an order → a **linear** segment (byte-identical to today's behavior).
- Two or more `TUTORIAL` rows at the same order → a **parallel-any** cluster (unordered, all unlock together).
- Two or more `GROUP` rows at the same order → a **fork** (side-by-side lanes; each GROUP expands in place into its own ordered chain, and the lane's label is the group's title).

Even the "how do you complete this?" rule is expressed in data rather than a new config screen. A GROUP that carries its own `prize` means "finishing *this* branch earns the reward" — the resolver appends a **synthetic `CHECKPOINT`** carrying that prize to the end of the lane. A `CHECKPOINT` sitting at a higher order *after* the fork means "you need all lanes" — a join.

The code lives in two pure functions worth knowing by name:

- `srv/lib/app-space-segments.js` → `classifyPathSegments(pathItems)` groups items by `itemOrder` and tags each segment `linear | parallel-any | fork`.
- `srv/lib/path-item-task-resolver.js` → `buildPathSegments({...})` shapes each segment, expands GROUP lanes, pulls lane labels, and appends the synthetic checkpoint when a prize is attached.

Crucially the old flat `buildPathItems` is untouched — `getAppSpaceProgress` still emits a flat `items[]` for backward compatibility *alongside* the new `segments[]`. And the unlock gating moved server-side: `annotateUnlocked` now stamps a per-item `unlocked` flag using segment-aware rules, so the client's `app-space-gating.ts` became a thin reader of that flag (with a legacy index-walk fallback). A chain of follow-ups cleaned up the timeline rendering — fork/join connectors aligned to lane-bubble centers (#2896), the multi-lane fork widened to use the full horizontal width (#2913), and branching-path time **averaged** across branches instead of summed (#3007).

One sibling design — "complete any one of N plain tutorials for a single *shared* prize" — was deliberately **designed but not built**; per-lane fork prizes plus the scanner's two-prize cap already cover the "don't make prizes too cheap" concern.

### Completions now respect the event window (#2866)

Previously completion was time-agnostic: someone who'd finished a tutorial months earlier could walk up and collect a prize without doing anything at the booth. Now, in `getAppSpaceProgress` only, a tutorial counts toward a track **only if its completion timestamp falls inside the event's `[startDate, endDate]`**. An out-of-window completion is downgraded to a new `COMPLETED_OUT_OF_WINDOW` status, which surfaces as a distinct **"redo" visual state** with an inline nudge toward the reset feature — and the tutorial URL stays clickable so you can go re-do it right there (#2866 follow-up). It's **fail-open**: if the event has no usable date window, there's no gating at all, exactly as before. This only touches `TUTORIAL` items, and only the anonymous kiosk path — the authenticated `getEventProgress` is unchanged.

### A one-flip "Temporarily Unavailable" toggle (#2864)

When a mission or path breaks mid-event, you want to pull it *fast* without the heavier SuperAdmin `published` dance. Two new fields — `temporarilyUnavailable` (default false) and a free-text `unavailableReason` — do exactly that. Flip the toggle in the Mission Editor and the card gets a "Temporarily Unavailable" badge, its child links disappear from `/browse/` and the navigator, and in App Space the item is greyed out and delinked. The flag threads through `buildPathSegments`, and a GROUP's unavailable flag **propagates onto each expanded child tutorial** (#2890) so a whole branch dims and can't count as complete. The content itself stays reachable by direct URL — this is a soft, reactive disable, and it takes effect on the next content rebuild.

### The prize barcode (#2861)

Finishing a track now renders a **scannable QR barcode** at the terminal checkpoint, encoding the visitor's identity for the instructor's scan-and-hand-over. The important detail is security: it comes from an **authenticated, session-based endpoint** `GET /api/my-prize-barcode?eventId=N` — identity is read server-side and never appears in a client-visible query string. The barcode encodes `{ uid: <Users.ID UUID>, eventId }`, deliberately the **database user UUID** (always present, every auth provider) rather than the nullable `sapId` or legacy numeric ID. The real fix that made it work for logged-in users was resolving identity from `cds.context.user` rather than `req.user` (`691e181ec`) — a classic CAP gotcha. A later Refresh button (#2952) lets a visitor re-check completion and reveal the barcode without reloading the page.

---

## Part 2 — Badge Scanner v2

The **Badge Scanner** is the operator-facing side of that barcode: the instructor at the prize table scans the visitor's on-screen QR to verify identity, see progress, record a capped handover, and glance at event stats. There are two scanner apps — an older UI5 `sap.ndc.BarcodeScanner` one and a newer Vue "Badge Scanner" — and v2 targets the Vue app.

The headline fixes:

- **The camera actually opens now.** The Vue camera was reading `videoRef` in the same tick it set `scanning` state, before Vue had rendered the video element — "Video element not available," every time. The fix is a one-liner that reads like a koan: `await nextTick()` before calling `scan()`. A **jsQR fallback** was added for cross-browser camera support.
- **Atomic, capped prize handover.** A new `claimPrizeForContestant(uid, eventId)` action resolves the visitor by UUID, then — inside a single CAP transaction using `forUpdate()` — checks that fewer than 2 prizes are already claimed for that user+event and inserts the new CLAIMED row in the *same* transaction. Two instructors scanning the same badge simultaneously can't create a third claim. The cap is **max 2 per user per event**, event-wide.
- **Privacy-respecting identity.** `getContestant` returns an identity line formatted `LastName, F.` — full last name plus a single first initial, derived server-side. No email and no full first name ever cross the wire. It also returns the **names of already-claimed prizes** and an event-scoped claimed count (0–2).
- **A live event-stats panel.** A new `getEventStats(eventId)` powers a panel under the contestant card (refreshed per scan, no polling): prizes claimed vs. available, how many are *earned but awaiting handover*, distinct participants, participants-who-claimed, and total tutorials/groups/missions completed.

---

## Part 3 — Daily Drawings (#2865)

At events we run **daily prize drawings** on stage, and this is the purpose-built, projector-friendly screen for it. The host picks the event, hits **Draw**, and a randomly chosen winner's name and email are revealed game-show style — confetti, the works — with **Kasimir in his tuxedo** "presenting" the prize.

The design decisions are all about trust and PII:

- The eligible pool is everyone with a `status='CLAIMED'` prize record for the event, deduplicated to **distinct users** — "we draw people, not claims," so the two-prize cap doesn't skew the odds. Draws are independent over the full pool; re-draws are fine.
- The backend `DrawingService` (`@path:'/drawings'`) is **Admin-scope gated at the CAP layer** — a real server-enforced `@requires`, not just an approuter rule, because it returns PII. The randomness *and* the PII resolution happen **server-side**: the browser only ever receives the single chosen winner, never the full roster.
- Anonymized/merged-away users are excluded so a draw never reveals a blanked-out identity, and a missing email degrades gracefully to "no email on file."

It ships as a new sibling Vue 3 app, `app/display-app-drawings/`, served at `/drawings-ui/` — kept separate from the continuously-updating monitor dashboard so the modal draw flow doesn't muddy it.

---

## Part 4 — A genuinely big Markdown upgrade for authors

This is the part tutorial authors will feel every day. We shipped a new **directive grammar** — a generic, CommonMark-style syntax — and then landed a whole catalog of concrete directives on top of it. (Note for anyone reading the docs: the `writing-tutorials.md` §3.8 "foundation" page still says "ships with no concrete directives yet." That line is now stale — the foundation shipped first, the directives followed in their own PRs, documented across four new author pages.)

Each feature below links its **author guide** (the reference doc) and a **live example tutorial** you can read on the author QA channel — every one is a real, published tutorial in the `sap-tutorials/meta-tutorials` repo that self-demonstrates the syntax it documents.

### The grammar

Three forms, one consistent shape:

```markdown
Inline:     available in :menu[Production]{edition="prod"} only
Leaf:       ::code-sample[Download the SDK]{url="https://example.com/sdk.zip"}
Container:  :::details[Click to expand]
            Hidden markdown body.
            :::
```

Single `:` is inline (always needs a `[label]`), `::` is a leaf, `:::` wraps a container — and you nest by adding *more* colons on the outer fence. Attributes are `key="value"`, bare flags (`open` → `open=true`), `.class`, and `#id`, and values are always HTML-escaped so there's no injection path. Anything inside a code fence, inline code, HTML block, or frontmatter is left completely alone. An unregistered directive is rendered literally and raises a warning-only `directive-unknown` lint — prose that happens to look like `:foo[...]` stays safe.

> 📖 **Docs:** [`writing-tutorials.md` §3.8 — Directives](https://github.com/sap-tutorials/tutorials-ims/blob/main/docs/authors/writing-tutorials.md)

### UI instruction directives

Five inline directives for writing UI steps that render crisply and adapt to the reader:

| Directive | Example | Renders |
|---|---|---|
| `:menu` | `:menu[File > New > Project]` | breadcrumb pills with chevrons |
| `:kbd` | `:kbd[Mod+S]` | styled keycaps, **OS-aware** |
| `:icon` | `:icon[filter]{label="Filter"}` | inline UI5 icon glyph |
| `:ui` | `:ui[Save]{type=button}` | styled UI label |
| `:ask` | `:ask[What is a CDS projection?]` | an "Ask Joule" button |

The clever one is `:kbd`. Write `:kbd[Mod+S]` once and it renders `Ctrl`+`S` on Windows/Linux and `⌘S` on macOS, with `Alt`→`⌥`, `Shift`→`⇧`, `Enter`→`↩`, and friends. You can override per-platform with `:kbd[Mod+T]{mac="Ctrl+Option+T"}`. `:icon` names are validated against a real `@ui5/webcomponents-icons` allowlist — a typo is a **hard build error** that suggests the closest match. `:ask` is hidden on the QA channel and removed entirely from the DOM if Joule isn't enabled for the session.

> 📖 **Docs:** [`ui-instruction-directives.md`](https://github.com/sap-tutorials/tutorials-ims/blob/main/docs/authors/ui-instruction-directives.md) · ▶️ **Live example:** [UI Instruction Directives](https://tutorial-system-prod-tutorials-approuter.cfapps.eu10-005.hana.ondemand.com/tutorials-qa/directive-ui-instructions) (a "Configure an SAP BTP Destination" walkthrough)

### Content reuse and smart references

`::include` pulls in a shared snippet with parameter substitution and cycle detection:

```markdown
::include[btp-trial-setup]{region=eu10}
::include[shared:install-cf-cli]
```

Snippets live at `<repo>/_snippets/<name>.md` (or the shared `tutorial-snippets` repo via the `shared:` prefix), max include depth 3, with circular-include rejection. It's gated — your repo has to be on the `SNIPPETS_ENABLED_REPOS` list.

Smart reference links turn an ID into a correct, status-aware link at build time:

```markdown
:tutorial[hana-cloud-tutorial-1]{label=Get Started with HANA}
:note[2471802]                       → "SAP Note 2471802"
:help[cap/docs/about-cap]            → title resolved at build (7-day cache)
:api[cds.ql.SELECT]{lib=cap-node}
:since[CAP 10]                       → a version badge
```

Prerequisite cards get their own directive, `::requires[some-slug]` (add `{optional}` for optional ones), rendering a card with title, estimated time, and the reader's completion status. And a new `testedWith:` frontmatter block renders a collapsible "Tested with" panel that the freshness detector watches for stale majors:

```yaml
testedWith:
  "@sap/cds": "10.x"
  node: "22"
```

> 📖 **Docs:** [`content-reuse-and-references.md`](https://github.com/sap-tutorials/tutorials-ims/blob/main/docs/authors/content-reuse-and-references.md) · ▶️ **Live example:** [Content Reuse and References](https://tutorial-system-prod-tutorials-approuter.cfapps.eu10-005.hana.ondemand.com/tutorials-qa/directive-content-reuse)

### Code blocks that behave like real docs

A lot landed here (`writing-tutorials.md` §3.6):

- **Console blocks** split commands from output. Lines starting with `$ > PS> #` are highlighted commands; everything else is dimmed output; and the copy button copies **only the command lines, prompts stripped**. Trailing `\` folds a continuation into one copyable line.
- **Diff / focus markers** as trailing comments that vanish from the rendered view:
  ```js
  function greet(name) { // [!code --]
  function greet(name = 'World') { // [!code ++]
  ```
  `[!code ++]`/`[!code --]` for added/removed, `[!code focus]` to dim everything else until hover, `[!code highlight]` for an accent. Copy defaults to the **final** code (removed lines excluded); `{copy=raw}` copies the source with markers intact.
- **Fill-in placeholders** — opt in with `placeholders: auto` and tokens like `<YOUR_SUBACCOUNT>` become fillable chips backed by the variables system. Fill once, it updates everywhere and persists across refresh. (It's smart enough to skip `Array<T>` generics.)
- **Tree fences** (` ```tree `) render file hierarchies with `/` for folders and `+`/`~`/`-` prefixes for new/modified/deleted, collapsible and accessible, copying back to a plain ASCII tree.
- **Walkthroughs** — a `:::walkthrough` container pairs one code fence with a numbered list where each item carries a `{N}` or `{N-M}` line range; clicking a note highlights those lines.

> 📖 **Docs:** [`writing-tutorials.md` §3.6](https://github.com/sap-tutorials/tutorials-ims/blob/main/docs/authors/writing-tutorials.md) · ▶️ **Live example:** [Code Block Enhancements](https://tutorial-system-prod-tutorials-approuter.cfapps.eu10-005.hana.ondemand.com/tutorials-qa/directive-code-blocks)

### Callouts

GitHub-style blockquote alerts, finally:

```markdown
> [!TIP]
> Prefer the frontmatter `video:` field over an inline iframe.
```

`[!NOTE]` `[!TIP]` `[!IMPORTANT]` `[!WARNING]` `[!CAUTION]` are the standard set, plus ours: `[!DETAILS] Title` and `[!DETAILS+] Title` (collapsible closed/open), `[!TROUBLESHOOT]` (feeds an auto-generated troubleshooting index at the bottom of the tutorial), `[!RESULT]` ("You should see…"), and `[!HINT]`/`[!SOLUTION]`. Multiple `[!HINT]`s in one step reveal **progressively** — the second only opens after you've opened the first. There's an inline `:spoiler[text]` that blurs until clicked (and renders as `||text||` in plain-text/MCP contexts), and collapsibles auto-expand for print.

> 📖 **Docs:** [`writing-tutorials.md` — Alert callouts](https://github.com/sap-tutorials/tutorials-ims/blob/main/docs/authors/writing-tutorials.md) · ▶️ **Live example:** [Callouts & Alerts](https://tutorial-system-prod-tutorials-approuter.cfapps.eu10-005.hana.ondemand.com/tutorials-qa/directive-callouts)

### Synced tabs

Built on our existing OPTION blocks — tag the first block of each group with `sync=<key>`:

```markdown
[OPTION BEGIN [Node.js] sync=runtime]
...
[OPTION BEGIN [Java] sync=runtime]
```

The reader picks once from a page-level picker bar, every group on the page updates, and the choice is remembered across tutorials. There are built-in preset keys (`runtime`, `account`, `ide`) that alias common labels, an auto-classifier (`syncTabs: auto`), deep links (`?runtime=Java`), and a proper WAI-ARIA option-tabs implementation.

> 📖 **Docs:** [`writing-tutorials.md` §3.5.4](https://github.com/sap-tutorials/tutorials-ims/blob/main/docs/authors/writing-tutorials.md) · ▶️ **Live example:** [Synced Option Tabs](https://tutorial-system-prod-tutorials-approuter.cfapps.eu10-005.hana.ondemand.com/tutorials-qa/directive-synced-option-tabs)

### Rich media and tables

- **Figures**: `:::figure[Caption]{width=80% align=center}` wrapping one or more images, auto-numbered "Figure N," with a lightbox gallery.
- **Inline sized images**: `:image[alt]{src=gear.png width=16}` for mid-sentence icons Goldmark otherwise can't size.
- **Before/after slider**: `::compare{before=a.png after=b.png labels="Before|After"}`, keyboard-accessible, degrades to both images side-by-side with no JS.
- **Hotspot images**: `![alt](arch.png){hotspots="1:15%,30% 2:65%,45%"}` overlays numbered markers cross-linked to the ordered list that follows.
- **Terminal recordings**: `::cast[deploy-demo.cast]{rows=24 cols=80 speed=1.2}` embeds a vendored asciinema player (v3.18.0) with **selectable, copyable** text, lazy-mounted via IntersectionObserver so the bundle only loads on pages that use it and only when scrolled into view.
- **Diagrams**: `::diagram[cap-architecture.svg]{alt="…"}` with lightbox zoom/pan and automatic dark-mode inversion for white-background SVGs (`alt` is required — missing it fails the build).
- **Interactive tables**: append `{.sortable .filterable .sticky}` after any Markdown table.

> 📖 **Docs:** [`rich-media-and-tables.md`](https://github.com/sap-tutorials/tutorials-ims/blob/main/docs/authors/rich-media-and-tables.md) · ▶️ **Live example:** [Rich Media & Tables](https://tutorial-system-prod-tutorials-approuter.cfapps.eu10-005.hana.ondemand.com/tutorials-qa/directive-rich-media)

### Authoring aids

For the people writing all this: inline/block **author notes** `%% @reviewer: fix this %%` (visible on QA, stripped entirely on PROD), `:::qa-only[Reason]` blocks, and a **CLI-freshness linter** that scans shell fences against a deprecations list and warns on things like `cf push --hostname` (removed in cf v8) or `cds serve --in-memory` (→ `cds watch`).

> 📖 **Docs:** [`authoring-aids.md`](https://github.com/sap-tutorials/tutorials-ims/blob/main/docs/authors/authoring-aids.md) · ▶️ **Live example:** [Authoring Aids](https://tutorial-system-prod-tutorials-approuter.cfapps.eu10-005.hana.ondemand.com/tutorials-qa/directive-authoring-aids)

Variables got new `value`/`display` fields too — see the self-demonstrating [Use Variables to Personalize Your Tutorials](https://tutorial-system-prod-tutorials-approuter.cfapps.eu10-005.hana.ondemand.com/tutorials-qa/use-variables-in-tutorials). All seven directive samples live in the `sap-tutorials/meta-tutorials` repo and are collected in the **[Tutorial Platform Features for Authors](https://tutorial-system-dev-tutorials-approuter.cfapps.eu10-005.hana.ondemand.com/tutorials/mission-tutorial-platform-features-for-authors)** mission.

---

## Part 5 — HANA generates its own embeddings (#2810)

A quieter but strategically important one. We proved that HANA Cloud's `VECTOR_EMBEDDING` SQL function can generate embeddings **from inside the database**, calling AI Core as a remote source — removing the Node/CAP → AI Core network round-trip. Scope was deliberately just the de-risking proof, not an application rewrite.

Two tiers, both proven and **live on DEV and PROD**:

- **Tier A — built-in NLP, zero new privileges:** `SELECT VECTOR_EMBEDDING('Hello world!','DOCUMENT','SAP_GXY.20250407') FROM DUMMY` returns a 768-dim `REAL_VECTOR`.
- **Tier B — AI Core remote source:** a PSE plus a `sapgenaihub` remote source (x509 credentials) lets you call `VECTOR_EMBEDDING(..., 'text-embedding-3-small.1', TUTORIALS_AICORE)`.

The interesting war story is the grants. The original design wanted `CREATE PSE` in `_grants.hdbgrants`; the shipped path pivoted several times — `CREATE PSE` via a role, then `TRUST ADMIN` + `CERTIFICATE ADMIN`, before finally landing on the realization that **PSE and remote source are instance-level admin objects, not container grants**, resolved via `external_privileges_role`. The full runbook with both-tier proofs and a PROD checklist is in `docs/developers/operations/hana-aicore-embeddings.md`.

---

## Part 6 — The Kasimir Arcade (#3009)

And now the cat.

App Space is the event-floor landing page — but at a busy booth, a static grid of track cards does nothing to pull someone in from across the room. So we built a **retro-arcade entry layer**: when a kiosk sits idle, **Kasimir the Cat** auto-runs through a Sonic-style 2.5D platform level whose zones *are* the event's tracks. Movement and color are the hook; the grid is still where the real work happens.

### The idea

It's **one URL**. The kiosk loads the normal App Space page. After 60 seconds of no input, the grid dims and the game fades in — "attract mode," Kasimir auto-running forever. Any touch, click, or key hands control to the visitor for a short platformer run. Reach a zone's prize chest (or tap "Pick this track →") and the game fades out, returning the real grid opened on that track for the actual login-and-launch. Walk away, and attract mode resumes. A "▶ Demo" link lets staff trigger it on demand.

And the level genuinely **reads the track** — it's not decoration. It consumes the *same* `getAppSpaceProgress` payload the grid uses, with **zero backend changes**:

- one zone per track (the ASUG event had 11), chained left→right;
- one coin per tutorial, with the tutorial title floating above it;
- a checkpoint → a lit archway gate;
- a prize → a glowing treasure chest at the zone end, which *is* the track selector;
- and when you're logged in, completed tutorials render as collected coins and finished tracks show ✓ CLEARED, while locked tracks are dimmed and barred with their unlock condition.

### The technology

The engine is **Three.js** — a true 3D world with lighting, shadows, and parallax depth, side-scroll camera, with Kasimir as a **"Paper-Mario" billboard**: a flat sprite standing upright in the 3D scene, lit, casting a shadow. It's a new Vue 3 island (`hugo-apps/src/app-space-game/`), 17 modules, built through the existing `hugo-apps` Vite pipeline with Three.js **dynamically imported and code-split** into its own chunk so it never bloats any other page.

The physics are real, and tuned to feel good rather than to be hard. From `constants.ts`:

```ts
export const SPEED = 7          // max horizontal speed (units/s)
export const GRAV = -34         // gravity
export const JUMP = 13.5        // jump launch speed
export const JUMP_CUT_GRAV = 2.4 // variable-height jump: cut gravity when button released
export const COYOTE_S = 0.1      // jump grace after walking off a ledge
export const JUMP_BUFFER_S = 0.12 // a jump pressed just before landing still fires
```

Coyote time, jump buffering, variable-height jumps, a fixed 1/120s physics step — the vocabulary of a real platformer. There are three hazard types (`crates` that block and can be stood on, `spikes` that cost you rings, `pits` you fall into), and critically, every hazard is **provably clearable**. The jump arc is computed from `JUMP` and `GRAV`, and hazards are sized to sit well inside it (`crateMaxH: MAX_H * 0.55`, `pitMaxW: maxGap * 0.5`). A `solvability.test.ts` asserts — with pure geometry, no physics simulation — that no placement ever requires a jump the fixed arc can't make.

That matters because of the **single most important rule: the kiosk must never get stuck**. In attract mode an autopilot plays the game — `autopilot.ts` finds the next hazard and times a full-height jump so the apex lands over its middle. It's allowed to occasionally miss (that adds life), and when it does, Kasimir tumbles and respawns at the last safe ground a beat later — there's no game over. On top of that, a **watchdog** tracks forward progress and, if the autopilot somehow makes none for 3 seconds, force-teleports past the stuck point. The never-wedge guarantee is belt *and* suspenders.

Everything is fail-safe: `?nogame=1` disables the game per-machine (remembered in `localStorage` so a booth laptop opts out without a redeploy), the server flag `APP_SPACE_GAME_ENABLED` gates it globally (default OFF, DEV-first), and if WebGL is unavailable or the scene throws, it silently falls back to today's grid. No black screen, ever.

### The art and the creation process

This is the part I'm proudest of, because the game started out feeling *fake*. The first version shipped Kasimir as a single frozen billboard who auto-ran rightward, clipped through everything, couldn't fall, and had unreadable overlapping labels. Tom's verdict: "it just feels unreal." A frozen cat reads as fake no matter how good the obstacles are.

The fix was **two new hand-drawn sprite sheets** (2000×1116 each) — a locomotion sheet (idle / walk / trot / run / jump) and an actions sheet (hit / KO / celebrate / chest-open / reach / taunt). But you can't just drop hand-drawn art into a 3D engine. Two problems, both discovered by inspecting the actual pixels rather than trusting the description:

1. The sheets had an **opaque cream paper background** (~#F4F3EE), so they'd render as cream rectangles in the scene.
2. They were **irregular galleries** — variable frames per row, inconsistent spacing — not a uniform grid you can slice with `floor(w/cols)` math.

So we wrote `scripts/build-kasimir-atlas.mjs`, a sprite-sheet compiler. It:

- samples the paper color, then keys it out by color distance (with a feathered edge so it doesn't eat Kasimir's white chest and face);
- labels 8-connected ink components and attaches little effect blobs (sparkles, motion lines) to the nearest sprite;
- clusters sprites into rows, splits any two that touch, and **flood-fills enclosed holes** opaque (the white chest is close to paper color, so it would otherwise go transparent);
- normalizes scale between the two sheets (the actions sheet was drawn larger), and — the key trick — **anchors every frame at its feet** and packs them into uniform cells where the anchor sits at the same point in every cell, so switching clips never makes Kasimir jump, shrink, or slide;
- fails loudly if the art changes (`EXPECTED_ROWS` asserts the exact sprite count per row).

The output is a packed 2044×1944 atlas PNG and a `kasimir-frames.json` frame-map describing 12 animation clips. The renderer animates by swapping the texture's UV offset per frame, flipping `scale.x` to face the direction of travel, and a small state machine drives the clips off physics state — `idle`/`walk`/`run`/`jump` plus `hit` (stars) on a crate collision, `ko` (ghost) on a pit-fall, `celebrate` on a ring pickup, and `chest` on reaching a goal. If the atlas ever fails to load, it falls back to the original static PNG.

The **process** is worth calling out too, because it's how we build risky UI here: it went brainstorm → throwaway visual spike (validated the Three.js look in a standalone HTML file) → a written design doc with explicit goals, non-goals, and anti-goals → implementation → and then a whole second **"make it feel like a game" enhancement round** driven directly by Tom's feedback on the live DEV build. The scene polish ("too simplistic and boring") was itself de-risked with another 2–3-variation spike shown in a browser before the real build. Nothing about the game is persisted — the ring count resets every run, scatters to zero on a hit, and never leaves the overlay. It's a toy whose entire job is to be eye-catching and then get out of the way.

---

## Wrapping up

Three weeks, and the throughline is "meet people where they are." At an event that means tracks that branch the way a real curriculum does, a barcode and scanner that make prize handover fast and private, a drawing screen for the stage, and — yes — a cat game to catch an eye from across the room. For authors it means a Markdown toolbox that finally covers callouts, tabs, reuse, rich media, and interactive code without dropping to raw HTML. And underneath, HANA quietly learned to embed its own text.

As always: feature work lands on DEV first and bakes behind flags before it reaches PROD. PROD event cutover is end of July 2026 — all of the above is additive and flag-gated, so it can settle without pressure on that date.

See you at the booth. Kasimir will be the one in the tuxedo.
