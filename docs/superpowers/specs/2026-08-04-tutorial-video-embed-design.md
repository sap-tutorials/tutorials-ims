# Tutorial Video Embed Support — Design

**Date:** 2026-08-04
**Status:** Approved (design), pending implementation plan
**Repo:** `tutorials-poc` (= `sap-tutorials/tutorials-ims`)

## Problem

Existing tutorials embed videos as raw HTML (`<iframe>`). Example:
[`hana-cloud-cap-create-ui`](https://developers.sap.com/tutorials/hana-cloud-cap-create-ui.html)
shows a YouTube video that is **missing** from the new tutorial system
([DEV/PROD render](https://tutorial-system-prod-tutorials-approuter.cfapps.eu10-005.hana.ondemand.com/tutorials/hana-cloud-cap-create-ui)).

We need to (a) support the existing raw-HTML embed syntax, and (b) add optional
frontmatter for video embedding as a nicer authoring path.

## Root cause (investigated + verified)

Two independent gaps. Only the first affects the reported example.

### Gap 1 — Pre-step content is silently dropped (THE reported bug)

`parseV2Steps` (`scripts/parsers/v2.ts:19`) begins collecting content only
*after* the first `### ` step heading (`inStep` starts `false`). In the source
markdown the video lives in a section that sits **before Step 1**:

```markdown
## Prerequisites
- ...

## Video Version

Video tutorial version:

<iframe width="560" height="315" src="https://www.youtube.com/embed/6WY70LyLS1c" ... allowfullscreen></iframe>

### Run the services
1. ...
```

The `## Video Version` heading + iframe are discarded before the sanitizer or
Hugo ever run. Confirmed by reading the generated file
`hugo/content/tutorials/hana-cloud-cap-create-ui.md` — the body jumps straight
from frontmatter to `{{% tutorial-step number="1" %}}`; the id `6WY70LyLS1c`
appears nowhere.

Hugo goldmark already has `unsafe = true` (`hugo/hugo.toml:70`), so raw HTML that
*reaches* Hugo content renders fine. The stripping is purely positional in the
Node parser.

**Corpus scan (72 tutorials with embeds):**
- iframe before first `### ` step (parser-dropped → broken): **20**
- iframe inside steps only (already render): **45**
- both: 0
- `<video>` tags: **0**
- iframe hosts actually used: `www.youtube.com` (129), `microlearning.opensap.com`
  (7), `youtu.be` (1), `sapvideo.cfapps.eu10-004.hana.ondemand.com` (1). The one
  "vimeo" hit is a plain link, not an iframe.

### Gap 2 — Sanitizer host/tag allowlist (forward-looking only)

`scripts/parsers/sanitize-html.ts` allows `iframe` only from
`ALLOWED_IFRAME_HOSTNAMES` (line 42) and does not allow `<video>`/`<source>`/
`<track>` (they are in `KNOWN_HTML_TAGS` so they are stripped, not escaped).

Every host in the corpus is **already allowlisted**, so the sanitizer drops
nothing real today. In-step embeds verified rendering live on
`build-apps-s4hana-crud` (YouTube iframe present in the served page). Adding
Vimeo + `<video>` support is requested for future authors, not to fix a current
break.

## Decisions (from brainstorming)

| Decision | Choice |
|---|---|
| Placement | **Both**: generic pre-step passthrough (fixes 20 now) **and** an optional styled frontmatter slot |
| Frontmatter shape | **Structured object**: `video: { url, title, provider }` |
| Existing 20 tutorials | **Passthrough only — no source edits**; they work on next rebuild |
| Providers | Add **Vimeo** and **`<video>`** support (beyond the existing allowlisted hosts) |

## Components

### A. Generic pre-step passthrough (fixes the 20)

- **`scripts/parsers/` — new `extractIntro(body, isV2)`** (own module, e.g.
  `intro.ts`): captures everything before the first step delimiter, minus the
  already-recognized blocks that flow to frontmatter:
  - `# Title` line
  - `<!-- description -->` line
  - `## You will learn` bullet list
  - `## Prerequisites` section

  Fence-aware (reuse `createFenceTracker`) so a `###` inside a code fence is not
  treated as a step boundary — same hazard `parseV2Steps` guards against. For v1
  tutorials, use the v1 step delimiter. Returns trimmed intro markdown/HTML, or
  `''` when there is nothing left after removing recognized blocks.
- **`compose.ts`**: call `extractIntro` on the same `processedBody` /
  `v2Body` that feeds the step parser (after option/branch pre-passes), return
  `intro` on `ComposeResult`.
- **`render-frontmatter.ts`**: accept `intro`; when non-empty, sanitize with
  `stripDangerousHtml(intro, { allowDataUrls })` and prepend a
  `{{% tutorial-intro %}}\n\n<intro>\n\n{{% /tutorial-intro %}}` block before the
  steps. Percent shortcode so `.Inner` renders through goldmark unsafe.
- **`hugo/layouts/shortcodes/tutorial-intro.html`** (new):
  `<div class="tutorial-intro">{{ .Inner }}</div>`.
- **`fetch-tutorials.ts`**: thread `intro` from the compose result into the
  `renderHugoFrontmatter` call (Hugo write path at `writeHugoPage`).

Placement of the rendered intro: top of the Steps content block, i.e. inside
`<div class="tutorial-steps">` before the first step — faithful to where the
video sits in source (immediately before Step 1).

### B. Optional styled `video:` frontmatter slot (opt-in for new tutorials)

- **`scripts/parsers/video.ts`** (new) — `normalizeVideo(input): NormalizedVideo | null`.
  - Accepts `video:` as an object `{ url, title?, provider? }`.
  - Normalizes to `{ embedUrl, title, provider }`:
    - YouTube watch URL / `youtu.be/<id>` / bare 11-char id → `https://www.youtube.com/embed/<id>`
    - Vimeo `vimeo.com/<id>` → `https://player.vimeo.com/video/<id>`
    - openSAP microlearning / sapvideo embed URLs → passed through if host allowlisted
  - Returns `null` (with a `console.warn` naming the slug) when the host/shape
    is not recognized — never emit a broken frame.
- **`frontmatter.ts` / `types.ts`**: surface `video` from parsed frontmatter;
  add `NormalizedVideo` type.
- **`render-frontmatter.ts`**: when `normalizeVideo` returns non-null, emit a
  `video` frontmatter object (`{ embedUrl, title, provider }`).
- **`hugo/layouts/partials/tutorial-video.html`** (new): renders a responsive
  16:9 styled player from `.Params.video`, output at the **top of the Steps
  section** (just above `<div class="tutorial-steps">`, `u1-object-page.html:335`).
- Independent of (A): existing 20 use (A); (B) is opt-in.

### C. Sanitizer + CSP (Vimeo / `<video>`)

The sanitizer comment (`sanitize-html.ts:35-38`) mandates three files stay in
sync. All three change together:

1. **`scripts/parsers/sanitize-html.ts`**
   - `ALLOWED_IFRAME_HOSTNAMES` += `player.vimeo.com`, `vimeo.com`.
   - `ALLOWED_TAGS` += `video`, `source`, `track`.
   - `ALLOWED_ATTRS`:
     - `video`: `controls`, `width`, `height`, `poster`, `preload`, `loop`,
       `muted`, `playsinline`, `src`
     - `source`: `src`, `type`
     - `track`: `kind`, `src`, `srclang`, `label`, `default`
   - `allowedSchemesAppliedToAttributes` already covers `src`. Dangerous attrs
     (`onerror`, `onload`, …) remain stripped by the allowlist model.
2. **`approuter/xs-app.json`** CSP:
   - `frame-src` += `https://player.vimeo.com https://vimeo.com`.
   - Add a **`media-src`** directive (currently absent → `<video>` blocked by
     `default-src 'self'`): `media-src 'self' https://raw.githubusercontent.com`
     (+ any host authors will actually serve `<video src>` from — confirm during
     implementation; default to `'self'` + GitHub raw).
3. **`docs/developers/reference/iframe-allowlist.md`**: add Vimeo rows; note the
   new `media-src` and `<video>` support.

### D. Author-preview parity

`stripDangerousHtml` and the parsers are also used by the VS Code author preview:
- **`srv-qa/preview-renderer.js`** — ensure intro + video paths run there too.
- **`srv-qa/lib/parsers.bundle.mjs`** — regenerate the bundle so preview matches
  the build. (Check the bundle's generation script; do not hand-edit.)
- **`srv-qa` cp list audit** (CLAUDE.md rule): if any new `srv/lib` / parser file
  becomes a transitive dep of `content-store.js`, add it to `.deploy/mta.yaml`'s
  `srv-qa` `cp` list.

## Data flow

```
source .md (sap-tutorials)
  → composeTutorial()
      → extractFrontmatter()         # title/desc/youWillLearn/prereq/video
      → resolveImageURLs / options / branches
      → extractIntro(body)           # NEW: pre-step content (minus recognized blocks)
      → parseV2Steps / parseV1Steps  # unchanged
  → renderHugoFrontmatter({ intro, video, steps, ... })
      → stripDangerousHtml(intro)                       # sanitizer (Gap 2 changes)
      → frontmatter.video = normalizeVideo(fm.video)    # NEW
      → {{% tutorial-intro %}} … {{% /tutorial-intro %}} + {{% tutorial-step %}}…
  → Hugo (goldmark unsafe=true)
      → partials/tutorial-video.html (styled player, from .Params.video)
      → shortcodes/tutorial-intro.html (raw passthrough)
      → shortcodes/tutorial-step.html (unchanged)
  → approuter serves; CSP frame-src/media-src permit the host (Gap 2 changes)
```

## Error handling

- `normalizeVideo` → `null` on unrecognized host/shape; `console.warn(slug)`; no
  frontmatter `video` emitted; no broken player.
- `extractIntro` → `''` when nothing survives removing recognized blocks; no
  `tutorial-intro` shortcode emitted (no empty `<div>`).
- Off-allowlist iframe hosts in intro/step content: still dropped by the
  sanitizer exactly as today (unchanged behavior).
- Fence-awareness prevents a code-fenced `###`/`<iframe>` example from being
  treated as a step boundary or a real embed.

## Testing

Unit:
- `normalizeVideo`: YouTube watch/`youtu.be`/bare-id/embed, Vimeo, openSAP,
  sapvideo → correct `embedUrl`; unknown host → `null`.
- `extractIntro`: `## Video Version` iframe preserved; `# Title` /
  `<!-- description -->` / `## You will learn` / `## Prerequisites` removed;
  fenced `###` not a boundary; no-intro → `''`; v1 + v2.
- Sanitizer: `<video>`/`<source>`/`<track>` + Vimeo iframe allowed; malicious
  attrs (`onerror`) and off-allowlist hosts stripped.

Integration:
- `composeTutorial` on a `hana-cloud-cap-create-ui`-shaped fixture → generated
  body contains the intro iframe with `6WY70LyLS1c`.

Real-thing verification (Tom's #1 rule — before calling done):
- `npm run fetch-tutorials` (or targeted rebuild) for `hana-cloud-cap-create-ui`,
  confirm the iframe is present in `hugo/content/tutorials/…`, `npm run dev`, and
  **view it in a browser** — the video renders between Prerequisites and Step 1.
- Sanity-check 2–3 of the other 20 pre-step-video tutorials.

## Out of scope (YAGNI)

- `videos:` array frontmatter — corpus has ≤1 video per tutorial.
- Migrating the 20 source tutorials to `video:` frontmatter now (see follow-up).
- `<video>` hosts beyond a sensible `media-src` default.

## Follow-up (post-deploy, per Tom)

After this ships, migrate **one** of the 20 tutorials' source markdown to the new
`video:` frontmatter as an end-to-end test of path (B). Separate PR against the
source repo; not part of this change.

## Touched files (summary)

New:
- `scripts/parsers/intro.ts` (or equivalent) — `extractIntro`
- `scripts/parsers/video.ts` — `normalizeVideo`
- `hugo/layouts/shortcodes/tutorial-intro.html`
- `hugo/layouts/partials/tutorial-video.html`
- tests under `scripts/__tests__/` and/or `test/unit/`

Modified:
- `scripts/parsers/compose.ts`, `render-frontmatter.ts`, `frontmatter.ts`,
  `types.ts`, `sanitize-html.ts`, `index.ts` (exports)
- `scripts/fetch-tutorials.ts` (thread `intro`)
- `hugo/layouts/tutorials/u1-object-page.html` (+ `single.html` if it needs the
  video partial too)
- `approuter/xs-app.json` (CSP frame-src + media-src)
- `docs/developers/reference/iframe-allowlist.md`
- `srv-qa/preview-renderer.js`, `srv-qa/lib/parsers.bundle.mjs` (parity)
