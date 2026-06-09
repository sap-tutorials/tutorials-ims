# Issue #173 — OS-conditional content with AI-assisted authoring

**Status:** Design approved, awaiting implementation plan
**Issue:** [sap-tutorials/tutorials-ims#173](https://github.com/sap-tutorials/tutorials-ims/issues/173)
**Author:** Claude Code (brainstormed with Thomas Jung, 2026-06-09)
**Related:** [[u8-codetabs]] (cross-block sync pattern), [[project_171_ai_code_check_shipped]] (author-side AI pattern), [[project_211_anonymize_cascade_shipped]] (annotation walker pattern), [[reference_ai_sdk_embedding_response]]

## 1. Summary

Tutorials already use `[OPTION BEGIN [Windows]] / [OPTION END]` blocks for OS-specific instructions (~50+ tutorials in `.tutorial-cache/`). Today these render as independent per-step tab strips with messy, inconsistent labels (`Windows`, `MacOS`, `Mac OS`, `Mac and Linux`, `Linux & MacOS`, etc.) — readers must click through every step.

This design adds:

1. **Reader-side**: a single global OS toggle (`Windows / macOS / Linux / BAS`) at the top of any tutorial that contains OS-flavored option blocks. The toggle drives every OS group on the page, defaults to the reader's actual OS (with first-class BAS detection), and persists across tutorials via `localStorage`.
2. **Authoring API**: a stable `POST /author/generateOsVariants` action on the existing `AuthorService`. The VS Code authoring plugin calls this to generate the missing OS variants from a generic instruction and inserts them into the tutorial markdown. We design and ship the API; the plugin owns its own UX.

The core principle is that AI is **authoring-time only**. Readers never trigger an AI call.

## 2. Architecture overview

```
┌─────────────────────────────────────────────────────────────────┐
│  Build pipeline (scripts/)                                      │
│                                                                 │
│  fetch-tutorials.ts                                             │
│    └─ parsers/options.ts          (modified)                    │
│         └─ parsers/os-classifier.ts   (NEW)                     │
│              ↓                                                  │
│         emits {{< os-options >}} for OS groups                  │
│         emits {{< option-tabs >}} for non-OS groups (unchanged) │
│         sets hugo frontmatter `hasOsOptions: true` if any       │
└─────────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────────┐
│  Hugo render (hugo/layouts/, hugo/assets/js/)                   │
│                                                                 │
│  shortcodes/os-options.html        (NEW) ─ static panels        │
│  layouts/tutorials/u1-object-page.html  ─ injects picker        │
│  assets/js/os-toggle.ts            (NEW) ─ picker + sync        │
│  assets/css/os-toggle.css          (NEW) ─ data-os hide rule    │
└─────────────────────────────────────────────────────────────────┘
                              ↓
                       reader's browser

                       (separate dataflow)

┌─────────────────────────────────────────────────────────────────┐
│  Authoring API (srv/, called by VS Code plugin)                 │
│                                                                 │
│  author-service.cds                                             │
│    + action generateOsVariants(...) returns {...}    (NEW)      │
│  author-service.js                                              │
│    + handler delegates to lib/os-variant-generator.js (NEW)     │
│  lib/os-variant-generator.js   (NEW)                            │
│    └─ AI Core chat completion + system prompt + rate limit      │
│  db/schema.cds                                                  │
│    + entity AuthorAiRequests (NEW)                              │
└─────────────────────────────────────────────────────────────────┘
```

**Key boundaries:**

- The build pipeline never calls AI. AI lives only in the authoring API.
- The reader-side picker has zero backend dependency — pure static HTML + localStorage, like [[u8-codetabs]].
- The authoring API never writes to the tutorial repo or the DB schema. It returns generated markdown; the VS Code plugin decides what to do with it.
- Authoring API and reader-side toggle share **no code** beyond the `OS_VALUES` constant (`['Windows', 'macOS', 'Linux', 'BAS']`) and the `os-classifier.ts` label dictionary, which is exposed as both a TS module (build-time) and re-exported in CommonJS for the CAP service.

## 3. Build-time classification

### 3.1 `scripts/parsers/os-classifier.ts` (new module)

A single curated map from regex → canonical OS set:

```ts
export const OS_VALUES = ['Windows', 'macOS', 'Linux', 'BAS'] as const;
export type OS = typeof OS_VALUES[number];

// Order matters — multi-OS labels must match before single-OS labels.
const RULES: Array<{ pattern: RegExp; oses: OS[] }> = [
  { pattern: /^(mac\s*(os)?|os\s*x)\s*(and|&|\/|,)\s*linux$/i,        oses: ['macOS', 'Linux'] },
  { pattern: /^linux\s*(and|&|\/|,)\s*(mac\s*(os)?|os\s*x)$/i,        oses: ['Linux', 'macOS'] },
  { pattern: /^(windows|win)\s*(and|&|\/|,)\s*(mac\s*(os)?|linux)$/i, oses: ['Windows', 'macOS', 'Linux'] },
  { pattern: /^(mac\s*os|macos|mac|os\s*x|darwin)$/i,                  oses: ['macOS'] },
  { pattern: /^(windows|win|win32|win64)$/i,                           oses: ['Windows'] },
  { pattern: /^(linux|ubuntu|debian|fedora|unix)$/i,                   oses: ['Linux'] },
  { pattern: /^(bas|business\s*application\s*studio|sap\s*bas)$/i,     oses: ['BAS'] },
];

export function classifyTab(label: string): OS[] | null { /* trim, run rules, return null if no match */ }

export function classifyGroup(labels: string[]): { kind: 'os' | 'regular'; assignments: Map<string, OS[]> } {
  const assignments = new Map<string, OS[]>();
  for (const label of labels) {
    const oses = classifyTab(label);
    if (!oses) return { kind: 'regular', assignments: new Map() }; // any non-OS tab => regular group
    assignments.set(label, oses);
  }
  // Sanity: at least 2 distinct canonical OSes covered (otherwise it's just "[Windows]" alone — keep as regular)
  const distinct = new Set([...assignments.values()].flat());
  if (distinct.size < 2) return { kind: 'regular', assignments: new Map() };
  return { kind: 'os', assignments };
}
```

### 3.2 Author override (frontmatter)

```yaml
---
title: My Tutorial
osOverrides:
  step-3-install-cli: regular   # force this group to non-OS even if heuristic flagged it
  step-5-deploy:      os        # force this group to OS even if heuristic missed it
---
```

The override key is the slugified step heading the group lives under. Falls through to heuristic if the key isn't listed. This is the safety valve when the heuristic gets it wrong.

### 3.3 Emitter changes in `scripts/parsers/options.ts`

For each detected option group:

```ts
const labels = group.map(g => g.tabName);
const override = osOverrides[stepSlug];
const decision =
  override === 'regular' ? { kind: 'regular' as const } :
  override === 'os'      ? { kind: 'os' as const, assignments: forceClassify(labels) } :
                           classifyGroup(labels);

if (decision.kind === 'os') {
  hasOsOptions = true;
  replacement = renderOsOptions(group, decision.assignments);
} else {
  // Existing path — option-tabs shortcode unchanged
  replacement = renderOptionTabs(group);
}
```

After the file is processed, `hasOsOptions: true` is written into the Hugo page frontmatter if any group on the page was classified as OS.

### 3.4 Two specific decisions

1. **Single-OS groups stay regular.** A group with just `[OPTION BEGIN [Windows]]` and no Mac/Linux peer renders as a normal single-tab block (no toggle). The toggle wouldn't make sense there.
2. **Combined labels duplicate panels.** A `[Mac and Linux]` source tab becomes two panels in the rendered HTML — both with the same content body, one with `data-os="macOS"`, one with `data-os="Linux"`. Slightly more bytes, much simpler runtime — the toggle just shows/hides by attribute.

## 4. Runtime rendering

### 4.1 Shortcodes

`hugo/layouts/shortcodes/os-options.html`:

```html
{{/* Wrapper for one OS-conditional group. JS adds [data-os-options-hydrated] on mount;
     CSS hides non-active panels only inside the hydrated wrapper, so JS-off readers
     see all panels stacked (graceful no-JS fallback). */}}
<div class="os-options" data-os-options>
  {{ .Inner }}
</div>
```

`hugo/layouts/shortcodes/os-panel.html`:

```html
{{ $os := .Get "os" }}
<div class="os-panel" data-os="{{ $os }}">
  {{ .Inner }}
</div>
```

The emitter writes one `os-panel` per *canonical* OS — so a source `[Mac and Linux]` produces two `os-panel` elements with identical inner content.

### 4.2 Page-level picker injection

In `hugo/layouts/tutorials/u1-object-page.html`, before the step list:

```html
{{ if .Params.hasOsOptions }}
<div class="os-picker" data-os-picker>
  <ui5-segmented-button accessible-name="Operating system">
    <ui5-segmented-button-item data-os="Windows">Windows</ui5-segmented-button-item>
    <ui5-segmented-button-item data-os="macOS">macOS</ui5-segmented-button-item>
    <ui5-segmented-button-item data-os="Linux">Linux</ui5-segmented-button-item>
    <ui5-segmented-button-item data-os="BAS">BAS</ui5-segmented-button-item>
  </ui5-segmented-button>
</div>
{{ end }}
```

The picker is rendered inline at the top of the OP, **not sticky**. Readers who scroll deep rely on the global localStorage preference rather than re-scrolling.

### 4.3 `hugo/assets/js/os-toggle.ts` (new — modeled on `codetabs.ts`)

Responsibilities:

1. **Detect default OS** when `localStorage['os-preference']` is empty:
   - BAS heuristic: `location.ancestorOrigins?.[0]?.includes('applicationstudio')` OR `document.referrer.includes('applicationstudio')` OR a hand-curated regex for known BAS hosts.
   - Then `navigator.userAgentData?.platform` (modern Client Hints) — `Windows` / `macOS` / `Linux`.
   - Fallback: parse `navigator.userAgent` — `Win` → Windows, `Mac` → macOS, `Linux` / `X11` → Linux.
   - Final fallback: Windows.
2. **Activate** by setting `data-os-active` on every `.os-panel[data-os="<choice>"]`. CSS hides non-active siblings.
3. **Fallback chain** when the active OS doesn't match any panel in a group:
   - Linux → macOS → Windows → BAS → first available
   - macOS → Linux → Windows → BAS → first available
   - BAS → Linux → macOS → Windows → first available
   - Windows → macOS → Linux → BAS → first available
   - When fallback fires, render an inline `<ui5-message-strip>` *inside the os-options wrapper, above the activated panel*: "No <chosen> instructions for this step — showing <fallback>."
4. **Picker change** (`selection-change` on `<ui5-segmented-button>`) → update localStorage, re-activate every group, dispatch a document-level `osprefchange` event.
5. **Cross-tab sync** — listen for `storage` events on `os-preference` so two open tabs converge.

### 4.4 CSS (`hugo/assets/css/os-toggle.css`)

```css
.os-options[data-os-options-hydrated] .os-panel[data-os] { display: none; }
.os-options[data-os-options-hydrated] .os-panel[data-os][data-os-active] { display: block; }
/* Without [data-os-options-hydrated]: all panels visible — no-JS fallback. */
```

### 4.5 `hugo/assets/js/ui5-bootstrap.ts` integration

Add a single import: `import './os-toggle.ts';`. The module's `init()` short-circuits when `document.querySelector('[data-os-picker]')` returns nothing, mirroring [[u11-progress]]'s gated-on-DOM-presence pattern.

### 4.6 Two specific decisions

1. **No-JS fallback shows all panels.** With JS off, every OS variant is visible. Honest content delivery; the alternative (hide everything pending hydration) breaks readers behind aggressive script blockers.
2. **Picker is non-sticky.** Sticky positioning interacts badly with the existing OP header. Persistence via localStorage covers the deep-scroll case.

## 5. Authoring API

### 5.1 CDS surface

Append to existing `AuthorService` (`srv/author-service.cds` — already has `@requires: 'Tutorial.Author'` at service level, so the new action inherits scope automatically):

```cds
type OsValue : String enum {
  Windows; macOS; Linux; BAS
};

type OsVariantContext : {
  tutorialSlug      : String;
  stepHeading       : String;
  surroundingMarkdown : String;
};

type OsVariant : {
  os       : OsValue;
  markdown : LargeString;
};

action generateOsVariants(
  sourceMarkdown : LargeString,
  sourceOS       : OsValue,
  targetOSes     : array of OsValue,
  context        : OsVariantContext
) returns {
  variants    : array of OsVariant;
  model       : String;
  tokensUsed  : Integer;
  requestId   : String;
};
```

### 5.2 Handler (`srv/author-service.js`)

Thin pass-through:

```js
const { generateOsVariants } = require('./lib/os-variant-generator');
const { getRateLimiter } = require('./lib/rate-limiter');

module.exports = (srv) => {
  // ... existing handlers (reviewTutorial, snoozeTutorial)

  srv.on('generateOsVariants', async (req) => {
    const { sourceMarkdown, sourceOS, targetOSes, context } = req.data;
    const userId = req.user.id;

    if (!sourceMarkdown || sourceMarkdown.length > 8000) return req.reject(400, 'sourceMarkdown must be 1..8000 chars');
    if (!OS_VALUES.includes(sourceOS)) return req.reject(400, 'invalid sourceOS');
    if (!Array.isArray(targetOSes) || targetOSes.length === 0 || targetOSes.length > 3) return req.reject(400, 'targetOSes must be 1..3');
    for (const t of targetOSes) {
      if (!OS_VALUES.includes(t)) return req.reject(400, `invalid targetOS: ${t}`);
      if (t === sourceOS) return req.reject(400, 'targetOSes cannot include sourceOS');
    }

    // Rate limit: 60 calls / hour per author (XSUAA user ID)
    const limited = await getRateLimiter('author:generateOsVariants').check(userId, { limit: 60, window: '1h' });
    if (limited) return req.reject(429, `Rate limit exceeded — ${limited.retryAfter}s`);

    return generateOsVariants({ sourceMarkdown, sourceOS, targetOSes, context, userId });
  });
};
```

### 5.3 `srv/lib/os-variant-generator.js` (new)

Single source of truth for the prompt. Reuses the existing AI Core client wrapper (whichever module the code-check feature uses today; to be confirmed during implementation).

```js
const SYSTEM_PROMPT = `You rewrite tutorial instructions for SAP developers. Given source markdown
written for a specific operating system, produce equivalent instructions for the target OS.

Rules:
- Translate shell commands (PowerShell ↔ bash, file paths, line continuations: \` ↔ \\).
- Translate path conventions (C:\\Users\\... ↔ ~/, / vs \\, drive letters).
- Translate package managers when an obvious equivalent exists (choco ↔ brew ↔ apt).
  When no equivalent exists, leave the instruction in prose form ("install <X> for your distro").
- BAS == Linux container with VS Code; treat it as Linux but call out terminal location
  ("In the BAS terminal, run...") when relevant.
- Preserve markdown structure exactly: same heading levels, same list shapes, same code-fence languages.
- Preserve all non-OS content verbatim (concepts, screenshots, links, prose explanations).
- Never invent commands you are uncertain about; if you cannot translate, leave a
  TODO marker in markdown comment form: <!-- TODO: confirm <command> on <os> -->.

Output: ONE markdown block per requested target OS, in the order requested. Each block separated by
the literal sentinel "===NEXT_VARIANT===" on its own line. No preamble, no explanation, no fences around the whole.`;

async function generateOsVariants({ sourceMarkdown, sourceOS, targetOSes, context, userId }) {
  const userPrompt = renderUserPrompt({ sourceMarkdown, sourceOS, targetOSes, context });
  const { content, model, tokensUsed } = await aiCoreChat({
    system: SYSTEM_PROMPT,
    user: userPrompt,
    maxTokens: 2000,
    temperature: 0.2,
  });
  const blocks = content.split('===NEXT_VARIANT===').map(s => s.trim());
  if (blocks.length !== targetOSes.length) {
    throw new Error(`AI returned ${blocks.length} blocks, expected ${targetOSes.length}`);
  }
  const variants = targetOSes.map((os, i) => ({ os, markdown: blocks[i] }));
  const requestId = randomUUID();
  await persistAuthorAiRequest({ requestId, userId, sourceOS, targetOSes, sourceMarkdown, variants, tokensUsed, model });
  return { variants, model, tokensUsed, requestId };
}
```

### 5.4 Audit persistence (`db/schema.cds` addition)

```cds
@PersonalData.EntitySemantics: 'Other'
entity AuthorAiRequests : cuid, managed {
  authorId       : String;        // XSUAA user ID, hashed before persist (mirrors codecheck)
  feature        : String;        // 'os-variants' (forward-compat for other author AI tools)
  sourceOS       : String;
  targetOSes     : String;        // comma-joined list
  sourceMarkdown : LargeString;   // v1: persisted (author content, no end-user PII concerns)
  variants       : LargeString;   // v1: persisted as JSON-stringified array
  sourceLength   : Integer;
  variantsLength : Integer;
  model          : String;
  tokensUsed     : Integer;
  durationMs     : Integer;
  errorCode      : String;        // null on success
}
```

Annotated `@analytics.exposed` so authoring-AI usage shows up in the existing Joule analytics dashboards (mirrors code-check pattern).

### 5.5 What the VS Code plugin sees

Request:

```http
POST https://<approuter>/author/generateOsVariants
Authorization: Bearer <author-XSUAA-token>
Content-Type: application/json

{
  "sourceMarkdown": "Open PowerShell and run:\n\n```powershell\ncd $HOME\\projects\\bookshop\nnpm install\n```",
  "sourceOS": "Windows",
  "targetOSes": ["macOS", "Linux"],
  "context": {
    "tutorialSlug": "cap-getting-started",
    "stepHeading": "Set up your project"
  }
}
```

Response:

```json
{
  "variants": [
    { "os": "macOS", "markdown": "Open Terminal and run:\n\n```bash\ncd ~/projects/bookshop\nnpm install\n```" },
    { "os": "Linux", "markdown": "Open a terminal and run:\n\n```bash\ncd ~/projects/bookshop\nnpm install\n```" }
  ],
  "model": "gpt-4o-2024-08-06",
  "tokensUsed": 412,
  "requestId": "8c4e..."
}
```

The plugin is responsible for inserting these as `[OPTION BEGIN [macOS]]` / `[OPTION END]` blocks alongside the source, and for any preview/diff/accept-reject UX.

### 5.6 API stability

The endpoint is **versioned via the action name itself**, not URL versioning. If the request/response shape needs to change later, we ship `generateOsVariantsV2` and keep `generateOsVariants` working for at least one release cycle. The VS Code plugin can then upgrade on its own schedule.

## 6. Authoring documentation updates

Per Tom's explicit callout — adoption hinges on docs. These updates ship in the same PR.

### 6.1 `docs/authors/writing-tutorials.md` — primary update

§3.5 "Option blocks" gets split into:

- **§3.5.1 Generic option blocks** (existing content, unchanged) — Java vs Node, JSON vs XML, Cloud vs On-premise.
- **§3.5.2 OS-conditional content** ★ NEW — explains the global picker, lists every recognized label (`Windows`, `Win`, `Mac`, `MacOS`, `OS X`, `Darwin`, `Linux`, `Ubuntu`, `Debian`, `Fedora`, `Unix`, `BAS`, `Business Application Studio`, `SAP BAS`), shows combined-label support (`Mac and Linux`), defaults & detection (browser sniff + BAS heuristic), missing-variant behavior (closest match + banner), and the `osOverrides:` frontmatter escape hatch.
- **§3.5.3 AI-assisted OS variants (VS Code)** ★ NEW — points authors at the VS Code extension feature with a TODO link to the plugin docs (filled in when the plugin ships).

A specific call-out: existing OS-tabbed tutorials get the global picker for free (no author migration required). The doc explicitly says so.

### 6.2 `docs/developers/architecture/build.md`

Short paragraph noting that `scripts/parsers/options.ts` consults `scripts/parsers/os-classifier.ts` and emits `os-options` shortcode for OS-flavored groups. Plus a frontmatter note that `hasOsOptions: true` is auto-injected.

### 6.3 `docs/developers/operations/testing-endpoints.md`

Add `POST /author/generateOsVariants` to the canonical endpoint table:

- Auth: bearer
- Scope: `Tutorial.Author`
- Rate limit: 60/hr per author
- Brief request/response example.

### 6.4 Doc verification

The existing `predocs:build` sidebar guard (runs as part of `npm run docs:build`) catches unregistered pages and dead links. No separate author-facing changelog file exists today; the `writing-tutorials.md` updates are visible at deploy time on the docs site at <https://sap-tutorials.github.io/tutorials-poc/>.

## 7. Error handling and edge cases

### 7.1 Build pipeline

| Failure | Behavior |
|---|---|
| Heuristic mis-classifies a group | Author override in frontmatter rescues it. No build error. |
| `osOverrides` references a non-existent step heading | Build-time **warning** via `console.warn`, lists unmatched keys. Doesn't fail the build. |
| Source has only one canonical OS represented | `classifyGroup` returns `regular` (`distinct.size < 2`). Renders as a normal option-tabs group. Logged at debug. |
| New emit fails for any reason | Falls back to existing option-tabs emitter, logs warning. The page must always build. |

### 7.2 Runtime

| Failure | Behavior |
|---|---|
| `localStorage` blocked (private mode, quota) | Detection runs every load; preference doesn't persist. Same throw-swallowing pattern as [[u8-codetabs]]. |
| `customElements.whenDefined('ui5-segmented-button')` never resolves | `Promise.race` with 3s timeout falls back to plain `<button>` row driven by inline JS. Picker degrades, never disappears. |
| User has tutorial open in two tabs and toggles in one | `storage` event fires in the other; both converge. |
| JS fails entirely (CSP, ad blocker) | No-JS fallback CSS leaves all panels visible with OS labels as sub-headings. Honest content delivery. |
| `hasOsOptions: true` but every group is `osOverrides: regular` | Picker exists but does nothing. Acceptable rare edge case caused by author intention. |

### 7.3 Authoring API

| Failure | Response |
|---|---|
| Source markdown > 8000 chars | 400 with explicit reason |
| `targetOSes` empty / contains source / has duplicates / has invalid value | 400 |
| Rate limit exceeded (60/hr) | 429 with `Retry-After` header |
| AI Core call times out (>30s) or upstream 5xx | 503 with `requestId` in body. Logged with full context. |
| AI returns wrong number of `===NEXT_VARIANT===` blocks | 502 (upstream protocol error). One internal retry with stricter prompt before surfacing. |
| AI returns raw HTML | Pass through — eventual rendering goes through existing `sanitize-html.ts`. Safety lives at render time, not API time. |

### 7.4 Cross-cutting concerns

1. **CSP**. New `os-toggle.ts` makes no `eval` or `Function()` calls. Adds zero new directives.
2. **Hydration mismatch**. Picker renders entirely from server HTML; JS only adds attributes and listeners. No risk of [[feedback_vue_fragment_hydration_mismatch]]-style problems (no Vue here).
3. **CRLF on Windows**. New TS files written on Windows worktrees — verify line endings before commit per [[feedback_crlf_regression_on_windows]].
4. **srv-qa cp list**. New `srv/lib/os-variant-generator.js` is a transitive dep that QA srv must bundle. Per [[feedback_srv_qa_cp_list_recurring]] re-walk imports and update `.deploy/mta.yaml` `srv-qa.cp` list in the same PR.
5. **HDI deploy parity**. `db/schema.cds` change adds `AuthorAiRequests` — must deploy cleanly to both prod and QA HDI containers (the schema-drift-check workflow validates this on PR).

### 7.5 Observability

- Every API call writes one `AuthorAiRequests` row regardless of success/failure (`errorCode` populated on failure).
- `AuthorAiRequests` annotated `@analytics.exposed` so it surfaces in the Joule analytics dashboards (mirrors [[project_admin_analytics_explorer]]).
- Standard CAP request logging via `cds.log('os-variants')` — debug for prompt content, info for timing, error for upstream failures.

## 8. Testing strategy

| Layer | Workspace | What we test |
|---|---|---|
| `os-classifier.ts` | unit | Every distinct OS-shaped label currently in `.tutorial-cache/` (extracted via grep, baked as fixture). Negatives: `Cloud`/`On-premise`, `Java`/`Node.js`, `XML`/`JSON`. Combined labels: `Mac and Linux` → `[macOS, Linux]`. Override paths. |
| `options.ts` Hugo emitter | unit | Snapshot tests: input markdown with mixed OS + non-OS groups → expected `os-options` + `option-tabs` output. `hasOsOptions` frontmatter side-effect. |
| `os-toggle.ts` | unit (jsdom) | Default-OS detection priority. localStorage round-trip. Picker change → all panels update. Fallback chain. Cross-tab `storage` event handling. |
| Author API validation | unit | Every 400 path. Rate-limit decision. Persistence write happens on both success and failure. Variant block parsing (correct count, malformed AI response). |
| Author API integration | hybrid (`HYBRID_AI_TESTS=true`) | One real AI Core call with a known-good Windows snippet. Asserts variants are non-empty and contain target-OS shell tokens. Same opt-in pattern as the categories classifier. |
| Smoke | smoke | `POST /author/generateOsVariants` returns 401 without bearer, 403 without `Tutorial.Author` scope, 200 with. |
| Visual / e2e | manual | Tom's checklist: open a known OS-tabbed tutorial, verify picker appears, switch OSes, refresh, verify persistence. Open in BAS, verify BAS auto-detected. |

The hybrid test costs real AI Core quota — gated behind `HYBRID_AI_TESTS=true` per established convention; the default `npm run test:hybrid` stays $0/run.

## 9. Out of scope / explicit non-goals

To prevent spec-creep mid-build:

1. **Per-tutorial dynamic OS toggle options.** Toggle is always `Windows / macOS / Linux / BAS`. Tutorials with non-OS variant tabs (`Cloud`/`On-premise`, `Java`/`Node.js`) keep their existing per-block tab UI unchanged.
2. **Profile-level OS preference.** Browser localStorage only in v1. DB-backed cross-device preference is a future PR if asked for.
3. **AI-driven runtime rewrites.** No reader ever triggers an AI call. AI is authoring-time only.
4. **Bulk-migration tool.** No build-time agent that walks every existing tutorial and generates missing OS variants in batch. Authors do that one tutorial at a time via the VS Code plugin.
5. **Feedback signal endpoint.** The `requestId` returned by `generateOsVariants` is reserved for a future "this variant was good/bad/used/discarded" feedback endpoint, but that endpoint is NOT in this spec.
6. **Eval harness.** The PR #210 pattern (eval against fixtures) is a follow-up issue once we have enough `AuthorAiRequests` rows to evaluate against.
7. **Telemetry on OS toggle clicks.** Future analytics work.

## 10. Files to create / modify

**New files:**

- `scripts/parsers/os-classifier.ts`
- `scripts/parsers/__tests__/os-classifier.test.ts`
- `hugo/layouts/shortcodes/os-options.html`
- `hugo/layouts/shortcodes/os-panel.html`
- `hugo/assets/js/os-toggle.ts`
- `hugo/assets/css/os-toggle.css`
- `srv/lib/os-variant-generator.js`
- `srv/__tests__/author-service-os-variants.test.js`
- `test/hybrid/author-service-os-variants.test.js`
- `test/smoke/author-api.test.js` (extend if exists)

**Modified files:**

- `scripts/parsers/options.ts` — consult `os-classifier.ts`, emit new shortcode for OS groups
- `scripts/fetch-tutorials.ts` — wire `osOverrides` frontmatter through, set `hasOsOptions`
- `hugo/layouts/tutorials/u1-object-page.html` — inject picker when `hasOsOptions`
- `hugo/assets/js/ui5-bootstrap.ts` — import `os-toggle.ts`
- `srv/author-service.cds` — add `generateOsVariants` action + types
- `srv/author-service.js` — add handler
- `db/schema.cds` — add `AuthorAiRequests` entity
- `.deploy/mta.yaml` — add `srv/lib/os-variant-generator.js` to `srv-qa.cp` list
- `docs/authors/writing-tutorials.md` — split §3.5 into §3.5.1/§3.5.2/§3.5.3
- `docs/developers/architecture/build.md` — note new classifier
- `docs/developers/operations/testing-endpoints.md` — add `POST /author/generateOsVariants` row
