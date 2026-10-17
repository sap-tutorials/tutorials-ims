# Tutorial Variables — Design

**Issue:** [sap-tutorials/tutorials-ims#2811](https://github.com/sap-tutorials/tutorials-ims/issues/2811)
**Date:** 2026-10-17
**Status:** Design — approved shape, pending plan

## Intent & Why

Tutorials frequently contain a value that differs per reader — most commonly a
**workshop group / seat number** — that today appears as a manual placeholder
(`XXX`) the reader is told to find-and-replace everywhere. Real example:
[teched2026-DA164 ex0](https://github.com/SAP-samples/teched2026-DA164/blob/main/exercises/ex0/README.md)
uses `XXX` in prose, in a username (`da164-XXX@education.cloud.sap`), and in a
project name (`da164-product-advisor-XXX`), inconsistently (some occurrences are
already filled as `001`/`007`).

The reader has to remember to swap the value in every copy-pasted command and
code block; missing one breaks their exercise. We want the author to declare the
variable **once**, the reader to type it **once** into a field, and have every
occurrence — prose, URLs, **and code blocks** — update **live** so the reader can
copy-paste with their own value already baked in and nothing to remember.

## Goals

- Author declares one or more variables per tutorial; each renders as a labelled
  **input field** that is always present.
- Reader types a value; **every** marked occurrence in the rendered tutorial
  updates **immediately** (including inside fenced code blocks, for copy-paste).
- Changing the value re-updates every occurrence live.
- Variable config (label, type, length, required, placeholder, optional default
  rule) is **author-controlled in source frontmatter**.
- Config is **persisted in HANA in a readable form** and shown **read-only in the
  Admin UI**.
- Reader's entered value **carries across tutorials within a group/mission** and
  **survives browser restarts** (client-side persistence).
- Authoring syntax stays **as close to native markdown as possible** — must not
  break other markdown consumers (GitHub rendering, AI reading the raw file,
  Hugo shortcodes, code fences).

## Non-Goals / Anti-Goals

- **No server-side per-user rendering.** HTML is built once and served to
  everyone from HANA BLOBs exactly as today; substitution is client-side only.
  (Server-side per-user rendering of HANA BLOBs is explicitly rejected as too
  heavy and defeats the live-update requirement.)
- **No server-side persistence of reader-entered values** — values live only in
  the reader's browser (`localStorage`). Privacy-clean by construction; nothing
  to store, GDPR-delete, or XSUAA-gate.
- **No cross-tutorial shared variable *declarations*.** Each tutorial declares
  its own variables. Carry-over is by variable **name** (see Persistence).
- **Not** a general templating/logic engine — no conditionals, loops, or
  computed expressions in v1. Just named placeholder substitution + one optional
  regex-default filler.

## Constraints

- **Parser v2** treats `###` (H3) as step delimiters; `##` (H2) only for
  You-will-learn / Prerequisites / Intro. Variable tokens must not interfere.
- **Fenced code blocks must be respected** — a homegrown parser that walks lines
  MUST track fenced-code state. `scripts/parsers/fence-tracker.ts`
  (`createFenceTracker()`) already exists and is the mechanism for safe
  in-fence wrapping.
- Source frontmatter is parsed with `gray-matter` (YAML); structured nested
  objects are already used (`steps`, `contributors`) so a `variables:` block
  fits the existing shape.
- Tutorial HTML is **not** served from static files — `publish-content.ts`
  uploads gzip BLOBs to HANA; AppRouter routes `/tutorials/*` →
  CAP `/content/tutorials/:slug`. The baked HTML is what reaches the browser.
- Authoring token must not collide with Hugo shortcode delimiters (`{{ }}`),
  must survive GitHub markdown rendering, and must be inert/neutral when the raw
  markdown is read by an AI or another tool.
- A tutorial can belong to **multiple** groups/missions (the single-valued
  next/prev clobber problem) — "the mission context" is not always unambiguous
  from the baked page alone.
- **Tom's rules:** test the actual thing before calling it done; DB-touching work
  needs a thin **hybrid** test (SQLite unit tests miss HANA reserved words,
  JSON/NCLOB handling, and column-name mismatches); PR over direct merge; deploy
  only from fresh `origin/DEV`.

## Decisions (the "how" settled in brainstorming)

### 1. Authoring — frontmatter declaration

Authors add a `variables:` block to source frontmatter. One entry per variable:

```yaml
variables:
  - name: groupNumber              # identifier; also the body-token key
    label: Your 3-digit seat number
    type: string                   # string | number  (v1 set)
    maxLength: 3                    # length metadata (affects input + validation)
    required: true
    placeholder: XXX               # rendered before the reader types — AUTHOR'S CHOICE
    default:                        # OPTIONAL add-on, niche scenarios only
      from: email                   # a built-in field (allowlist, see Built-ins)
      pattern: 'da164-(\d+)@'       # regex; capture group 1 is the default value
```

- `placeholder` governs the unfilled state (author decides whether it's `XXX`, a
  sample like `001`, or anything else). **Author's call, per requirement.**
- `required`, `type`, `maxLength` drive input rendering + client-side validation.
- `default` is the **optional** filler: field still always renders and is always
  overridable by the reader. If `default` is absent or doesn't match, the field
  starts at `placeholder`.
- `default.from` names one of an **allowlist of built-in identity fields** the
  author picks from (decision below), not a single fixed `username`.

### 1a. Build-pipeline anchors (verified against the codebase)

These were confirmed by reading the actual layout/header, not assumed:

- **Config JSON emitter + location:** `hugo/layouts/tutorials/single.html` already
  reads `.Params.*` and injects `<script id="tutorial-data" type="application/json">{{ .Params.steps | jsonify }}</script>`.
  So `variables:` **passes through into Hugo front-matter** (like `steps` /
  `stepCount` / `missionSlug`), and the layout emits a sibling
  `<script id="tutorial-variables" type="application/json">{{ .Params.variables | jsonify }}</script>`.
  The TS parser does **not** emit the config script — it only validates + wraps
  body tokens. The config script is part of the **baked HANA BLOB** because Hugo
  renders it in.
- **Island mount:** follows the existing pattern — a mount div in the layout,
  e.g. `<div id="tutorial-variables-panel" data-slug="{{ .Params.slug }}"
  data-mission-slug="{{ .Params.missionSlug }}"></div>` plus a
  `<script type="module" src="{{ partial "island-src.html" "tutorial-variables" }}">`
  (exactly like `progress-bar` and `tutorial-pip-launcher`).
- **Mission/group context is authoritative from front-matter, not guessed.**
  `.Params.missionSlug` / `.Params.missionId` are already on the tutorial page
  (used by `mission-side-nav.html`). The layout emits `data-mission-slug`, so the
  carry-over key uses that — **no reliance on `document.referrer`.** Multi-group
  ambiguity collapses because the baked page carries the mission it was rendered
  for; standalone tutorials simply have no `data-mission-slug` and fall back to
  the per-tutorial key.
- **Username/built-ins source:** the page already loads identity via
  `fetch('/auth/user')` (returns `email`, `id`, `givenName`, `familyName`, …),
  cached client-side and rendered into the header. The island reads the **same
  `/auth/user`** response for `default.from` — no new endpoint. Anonymous ⇒ the
  default simply doesn't fire.

### 2. Authoring — body token

**Chosen token:** `{{var:NAME}}` — e.g. `{{var:groupNumber}}`.

Rationale:
- Double-brace is familiar/neutral to readers of raw markdown and to AI.
- The `var:` prefix namespaces it away from Hugo shortcodes (Hugo shortcodes are
  `{{< … >}}` / `{{% … %}}` / `{{ … }}` Go-template calls; `{{var:groupNumber}}`
  has no leading `<`, `%`, space, or Go identifier/function, so Hugo leaves it
  untouched — **must be verified against the actual Hugo pipeline**, see Risks).
- GitHub renders it as literal text (harmless when the source is viewed on
  GitHub).
- Works identically inside and outside code fences.

The author writes `{{var:groupNumber}}` anywhere: prose, inline code, URLs, and
inside fenced code blocks. Example source:

> Username: `da164-{{var:groupNumber}}@education.cloud.sap`
> Project name: `da164-product-advisor-{{var:groupNumber}}`

> **Builder note / open to revisit:** if `{{ }}` proves to collide with Hugo or
> any existing parser stage, fall back to a non-brace token (e.g. `::var:NAME::`
> or `%%var:NAME%%`). The namespacing goal and the fence-safety mechanism are
> fixed; the exact delimiter is the one thing most likely to change after the
> Hugo spike. **Validate the delimiter against the real Hugo build before
> locking it** (cheap throwaway spike recommended as first implementation step).

### 3. Build-time behaviour (no value substitution)

During parse/build the pipeline does **two** things and **no** value replacement:

1. **Validate** the `variables:` frontmatter block (names unique, referenced
   tokens declared, types/lengths well-formed, regex compiles). **A malformed
   block is a HARD BUILD FAILURE that blocks publish** — a bad declaration can
   never reach PROD (consistent with the repo's fail-fast build guards, e.g. the
   `CAP_BASE_URL` empty-concepts guard). Specifically fail on: duplicate variable
   `name`, a body token `{{var:X}}` whose `X` is not declared, an unparseable
   `default.pattern`, `type`/`maxLength` that don't type-check, or a `default.from`
   not in the built-in allowlist. (A *declared variable with no body token* is a
   soft warning, not a failure — harmless.)
2. **Wrap** every `{{var:NAME}}` occurrence — using `fence-tracker` so in-fence
   occurrences are wrapped too — in a marked element carrying the variable name,
   e.g.:
   ```html
   <span class="tut-var" data-tut-var="groupNumber">XXX</span>
   ```
   The initial text content is the declared `placeholder`. Inside `<pre><code>`
   the same `<span>` wrapping is used (browsers render it fine; copy-paste copies
   the text content, which is the live value).

The baked HTML remains identical for every reader (one BLOB in HANA, as today).
A tutorial with **no** `variables:` block bakes exactly as it does now
(zero-cost, fully backward compatible).

### 4. Runtime — client-side Vue island

A new Vue 3 island (consistent with the ~17 existing `hugo-apps/` islands into
`hugo/static/js/`). Responsibilities:

- Read the tutorial's variable **config** (the declared list + metadata) — baked
  into the page as a small JSON `<script type="application/json">` block
  (derived from the same frontmatter, so the island needs no API call).
- Render an **input field per variable** in a labelled **panel at the top of the
  tutorial** — below the title/description, above Step 1 (decision below).
  Fields carry `label`, `type`, `maxLength`, `required` with validation.
- On input (and on load), write the current value into the `.textContent` of
  **every** `[data-tut-var="NAME"]` span on the page → live update everywhere,
  prose + code alike. Re-updates on every change.
- Apply the **default** filler on first load if the field is empty and no stored
  value exists: evaluate `default.pattern` against the named built-in; if it
  matches, pre-fill capture group 1. Reader can still overwrite.
- Persist values to `localStorage` (see §5).
- Unfilled + no default + no stored value ⇒ spans keep the author's
  `placeholder`.

**Built-in identity fields (for `default.from`):** an explicit **allowlist** the
author chooses from — `email`, `id`, `givenName`, `familyName` (extensible
later). All come from the single `/auth/user` response the page already loads.
In the DA164 example the author would use `from: email` with
`pattern: 'da164-(\d+)@'`. The set is a small, documented allowlist (a
`default.from` outside it is a build failure, §3). When logged out / no
`/auth/user` identity, the default simply doesn't fire and `placeholder` shows.

### 5. Persistence & carry-over (client-side)

Values persist in `localStorage`, keyed by variable **name** and scoped:

- **Primary (context) key:** `tutvar:<missionOrGroupSlug>:<varName>` — the
  mission/group slug taken from the **navigation context** (URL and/or
  `document.referrer`) when the reader moves within a group/mission. This gives
  carry-over: `groupNumber` typed in tutorial A is found by tutorial B in the
  same mission.
- **Fallback key:** `tutvar:<tutorialSlug>:<varName>` — used when the tutorial is
  opened cold with no mission/group context (multi-group ambiguity, direct link).

On load, the island resolves the **most specific available** value: context key
first, then per-tutorial key, then `default` filler, then `placeholder`. On
input it writes **both** the active context key (if any) and the per-tutorial key
so the value is durable either way and survives browser restarts.

**Same variable *name* across tutorials is assumed to mean the same thing** —
carry-over is by name, scoped by context, not by a shared declaration. This is
the explicitly chosen semantics (not global-by-name, which would ignore mission
boundaries).

### 6. Persistence in HANA + Admin UI (read-only)

Config is persisted in HANA so the Admin UI can show it. **Hybrid storage**
(not pure JSON, not pure flat columns), mirroring how `TutorialContributors`
hangs off `Tutorials`:

- New entity `TutorialVariables` (assoc to `Tutorials`), one row per declared
  variable, written during content publish.
- **Flattened scalar columns** the Admin UI filters/sorts on:
  `name`, `label`, `type`, `maxLength`, `required`.
- **`configJson` column** (full declared config incl. nested `default:{from,
  pattern}`) as source of truth for anything not flattened and for forward
  compatibility (field set will grow).
- Projected **read-only** into `AdminService` (like
  `TutorialMeta as projection on ims.TutorialMeta`) so the Admin UI lists each
  tutorial's variables and their settings. No admin editing in v1 — authors own
  the config in source.

Why hybrid: the Admin UI (Fiori Elements) needs real columns to filter/sort
("which tutorials have a required variable?"); a lone JSON blob renders opaque.
JSON keeps nested/forward-compatible shape without a migration per new field.

Write path must follow the repo invariants: upsert on the natural key
(tutorial + variable name), SELECT-then-UPDATE-or-INSERT (pattern at
`srv/lib/content-publish-session.js`), and **must have a hybrid test** against
real HANA (reserved words / JSON column handling).

## Data / Flow Summary

```text
SOURCE frontmatter  variables:[…]  +  body  {{var:groupNumber}}
   │
   ├─ parse/build ─ validate block
   │                wrap tokens → <span data-tut-var> (fence-safe)
   │                emit config JSON <script> into page
   │                → Hugo → gzip HTML BLOB → HANA (one per everyone)
   │
   ├─ publish ───── upsert TutorialVariables rows (flat cols + configJson)
   │                → AdminService read-only projection → Admin UI list
   │
   └─ runtime ───── Vue island reads config JSON
                    renders input field(s) (type/len/required)
                    default filler (regex over built-in e.g. username)
                    resolve value: context key → tutorial key → default → placeholder
                    on input → set textContent of every [data-tut-var] span (live)
                             → write localStorage (context + tutorial keys)
```

## Decisions Made (builder-check + author resolution)

Resolved after a builder-check review — recorded so the plan doesn't re-litigate:

**Author's calls (confirmed by Tom):**
- `default.from` is an **allowlist** (`email`, `id`, `givenName`, `familyName`) the
  author picks from — not a single fixed `username`.
- Malformed `variables:` block **hard-fails the build** (blocks publish).
- Input fields sit in a **header panel at the top of the tutorial** (below
  title/description, above Step 1). The PiP pop-out shows live-substituted text
  but does **not** mirror the input field in v1 (field lives on the main page
  only).

**My calls (verified against the codebase, not guessed):**
- Config JSON is emitted by `hugo/layouts/tutorials/single.html` from
  `.Params.variables` (passthrough front-matter), as a
  `<script id="tutorial-variables" type="application/json">`; it rides in the
  baked HANA BLOB. TS parser only validates + wraps. (§1a)
- Carry-over context key uses `.Params.missionSlug` emitted as `data-mission-slug`
  on the island mount — authoritative, no `document.referrer`. (§1a, §5)
- Built-ins read from the existing `/auth/user` fetch — no new endpoint. (§1a)
- `TutorialVariables` scalar columns that are HANA reserved words (`type`,
  `required`, etc.) get quoted/renamed in the CDS definition; confirmed as a
  hybrid-test concern, not a blocker.

## What's Left to the Builder

- **Spike the token delimiter against the real Hugo build first** (§2 builder
  note). Confirm `{{var:NAME}}` survives Hugo untouched; if not, switch to the
  non-brace fallback (`::var:NAME::` / `%%var:NAME%%` — builder's pick).
  Everything else is delimiter-agnostic. This is a sequenced prerequisite, not a
  guess, and de-risks the parser work.
- Exact parser stage/placement for validation + wrapping within
  `scripts/parsers/` (compose order, where in `v2.ts` / a new parser module).
  (The hard-fail semantics and what to fail on are decided in §3.)
- Island scaffolding to match existing `hugo-apps/` conventions (manifest,
  hashed path, island registration — mind the `ignore-scripts`/`build:all`
  wiring gotcha so the merged JS actually ships).
- Precise `TutorialVariables` CDS definition (column types/lengths, reserved-word
  quoting, natural-key unique assertion, association direction) and the
  publish-session upsert.
- Admin UI surface: which admin component lists variables (new tile vs. nested
  list under the tutorial detail) — pick the lightest Fiori Elements fit.
- Header-panel layout/styling specifics (Fundamental Styles / UI5 web components,
  Horizon theme) within the chosen top-of-page placement.
- `number` type handling specifics and validation messages.
- Tests: unit (parser wrapping incl. fence cases, hard-fail validation), **hybrid**
  (TutorialVariables persistence/upsert on real HANA), and a committed e2e for
  the island (field → live substitution incl. inside code fences → localStorage
  carry-over across a group), per the repo's user-facing-UI-change nudge.

## Testing Notes (Tom's rules)

- SQLite unit tests are fine for parser/wrapping logic.
- **Any HANA write needs a hybrid test** — SQLite can't catch HANA reserved words,
  JSON/NCLOB handling, or column-name mismatches.
- Island behaviour needs a real browser test (Playwright e2e, post-deploy) — the
  live-substitution-in-code-fences + carry-over is the actual thing to verify.
- Nothing is "done" until the field-type-value + copy-paste-with-substituted-code
  path is demonstrated end-to-end.
