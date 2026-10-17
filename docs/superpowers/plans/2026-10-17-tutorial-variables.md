# Tutorial Variables Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let tutorial authors declare named variables (e.g. a workshop group number) that a reader types once into a top-of-page field and that substitute live — in prose, inline code, and fenced code blocks — everywhere in the rendered tutorial, persisting per-reader client-side and carrying across a mission.

**Architecture:** Authors declare `variables:` in source frontmatter and write `{{var:NAME}}` tokens in the body. The TS parse pipeline validates the block (hard-fail), passes `variables:` through into generated Hugo frontmatter, and wraps **prose/inline-code** tokens in `<span class="tut-var" data-tut-var="NAME">placeholder</span>` as a markdown-string transform. **Fenced-code** tokens stay literal through the TS pipeline and are wrapped inside the existing `render-codeblock.html` Hugo hook (Chroma escapes raw HTML, so the hook must segment-and-rejoin with `safeHTML`). A new Vue island reads a `<script id="tutorial-variables" type="application/json">` config, renders a header input panel, does live `textContent` substitution into every `.tut-var` span, and persists values in `localStorage` keyed by mission/tutorial. Config also persists to a `TutorialVariables` HANA entity (DELETE-then-INSERT-per-slug, like `TutorialContributors`), projected read-only into `AdminService`.

**Tech Stack:** TypeScript parsers (vitest), Hugo (goldmark + Chroma, `unsafe=true`), Vue 3 island (Vite, content-hashed, `island-src.html`), CAP/CDS + SAP HANA (CQL), Playwright e2e.

**Spec:** `docs/superpowers/specs/2026-10-17-tutorial-variables-design.md`

## Global Constraints

- Token delimiter is `{{var:NAME}}` — **spike-confirmed (Task 1 done):** goldmark passes it through verbatim in prose and inline code with `unsafe=true`; plain `{{var:...}}` is NOT parsed as a Hugo shortcode (only `{{<`/`{{%` are, and a space-less `{{var` never matches). `NAME` matches `[A-Za-z][A-Za-z0-9_]*`. Delimiter is LOCKED — no fallback needed.
- **Fenced-code tokens use a sentinel, not the literal brace token** (spike finding — Chroma fragments `{{` into `<span class="o">` in operator-lexing languages like bash, so a `replaceRE` on `{{var:NAME}}` in highlighted HTML would MISS those). The TS parser (Task 2) rewrites each fenced-code `{{var:NAME}}` into a letters-only sentinel `TUTVARxNAMEx` (lexer-opaque — spike-verified intact in bash/js/text); the Hugo hook (Task 3) `replaceRE`s the sentinel into the span. Prose/inline tokens are wrapped as spans directly by Task 2 (no sentinel).
- Any `safeHTML`/`safeHTMLAttr` added under `hugo/layouts/**` needs a `security-reviewed: <reason>` comment within 3 lines above, or `scripts/check-hugo-safe-html.cjs` fails the build.
- The active tutorial layout is `hugo/layouts/tutorials/u1-object-page.html` (NOT `single.html`).
- HANA: use CQL (CAP query API), never raw SQL, for `TutorialVariables`. Column names must avoid HANA reserved words — use `varName`, `varLabel`, `varType`, `maxLength`, `isRequired`, `placeholder`, `defaultFrom`, `defaultPattern`, `configJson`, `sortOrder`. New entity needs `@cds.persistence.journal` in `db/persistence.cds`.
- `default.from` is an allowlist: `email`, `id`, `givenName`, `familyName`. A value outside it is a build failure.
- Malformed `variables:` block is a HARD BUILD FAILURE (blocks publish).
- Reader values are NEVER persisted server-side — `localStorage` only.
- No server-side per-user rendering — one baked HTML BLOB for all readers.
- A tutorial with no `variables:` block must bake byte-identically to today.
- Tom's rules: TEST THE ACTUAL THING before done; any HANA write needs a hybrid test; PR not direct-merge; deploy only from fresh `origin/DEV`.

## Review Focus

- **Token inside a fenced code block with syntax highlighting** — must render as a styled span with the live value AND remain copy-paste-correct (not `&lt;span&gt;`). Owned by Task 3.
- **Same token appears multiple times in one tutorial (prose + code)** — every occurrence updates on keystroke; none missed. Owned by Task 2 (wrapping completeness) + Task 5 (substitution).
- **Anonymous reader (no `/auth/user`)** — `default` filler silently doesn't fire; field shows `placeholder`; no console error. Owned by Task 5.
- **Reader opens a tutorial cold (no mission context / `data-mission-slug` empty)** — falls back to per-tutorial `localStorage` key; carry-over simply doesn't apply; no crash. Owned by Task 6.
- **Author ships a malformed block (dup name, token with no declaration, bad regex, `from` off allowlist)** — build fails with a clear message naming the offending variable; nothing publishes. Owned by Task 2.

---

### Task 1: Spike — confirm `{{var:NAME}}` survives Hugo untouched

**Throwaway spike** (no tests, not committed to the feature). De-risks the delimiter before any real code. If it fails, the fallback token `::var:NAME::` is chosen here and all later literals use it.

**Files:** none permanent (scratch tutorial under `.tutorial-cache/` or a temp `hugo/content/tutorials/_spike.md`).

- [ ] **Step 1:** Add a throwaway generated tutorial containing `{{var:groupNumber}}` in (a) prose, (b) inline code `` `da164-{{var:groupNumber}}` ``, (c) a ```` ```bash ```` fenced block, and a frontmatter `variables:` stub.
- [ ] **Step 2:** Run `npm run dev` (or a scoped `hugo` build) and inspect the generated HTML for all three.
- [ ] **Step 3:** Confirm `{{var:groupNumber}}` passes through goldmark verbatim in prose/inline-code (not interpreted as a Hugo shortcode). Confirm the fenced occurrence appears HTML-escaped inside the Chroma `<pre>` (expected — proves Task 3 is needed).
- [ ] **Step 4:** Record the result in the plan/spec. If `{{ }}` is mangled, switch the global delimiter to `::var:NAME::` and note it. Delete the spike file.

---

### Task 2: Source frontmatter schema, validation (hard-fail), and prose/inline-code wrapping

**Files:**
- Create: `scripts/parsers/variables.ts`
- Create: `scripts/parsers/__tests__/variables.test.ts`
- Modify: `scripts/parsers/types.ts` (add `TutorialVariable` type + `variables?` on source `TutorialFrontmatter`)
- Modify: `scripts/parsers/compose.ts` (call the transform + surface validation)
- Modify: `scripts/parsers/render-frontmatter.ts` (pass `variables` through to generated frontmatter — see Task 4 for the Hugo-side consumption)

**Interfaces:**
- Produces:
  - `interface TutorialVariable { name: string; label: string; type: 'string' | 'number'; maxLength?: number; required?: boolean; placeholder?: string; default?: { from: 'email'|'id'|'givenName'|'familyName'; pattern: string } }`
  - `class VariablesValidationError extends Error` (thrown on malformed block; message names the offending variable).
  - `function validateVariables(vars: unknown, body: string): TutorialVariable[]` — throws `VariablesValidationError` on: duplicate `name`; a `{{var:X}}` token in `body` whose `X` is undeclared; unparseable `default.pattern` (via `new RegExp`); `type` not in set; `default.from` off allowlist. A *declared-but-unused* variable is allowed (soft — no throw).
  - `function wrapTokens(markdown: string, vars: TutorialVariable[]): string` — line-by-line via `createFenceTracker`. **Outside** fenced code: replace every `{{var:NAME}}` with `<span class="tut-var" data-tut-var="NAME">PLACEHOLDER</span>` (PLACEHOLDER = declared `placeholder` HTML-escaped, or empty). **Inside** fenced code: replace every `{{var:NAME}}` with the letters-only sentinel `TUTVARxNAMEx` (NAME is `[A-Za-z0-9_]+`; `_` is safe in all lexers tested). The sentinel form must round-trip to NAME in Task 3. Export `const SENTINEL_RE = /TUTVARx([A-Za-z0-9_]+)x/g` and a `sentinelFor(name)` helper so Task 3 and tests share the exact shape.
- Consumes: `createFenceTracker` (`scripts/parsers/fence-tracker.ts`).

- [ ] **Step 1: Write failing tests** in `variables.test.ts` (vitest, mirror `v2-fenced-h3.test.ts` style):
  - `validateVariables` throws `VariablesValidationError` naming `groupNumber` on a duplicate-name block.
  - throws on a body token `{{var:seatNo}}` with no matching declaration.
  - throws on `default.pattern: '('` (bad regex) and on `default.from: 'username'` (off allowlist).
  - returns parsed array for a valid block; does NOT throw on a declared-but-unused variable.
  - `wrapTokens`: a prose occurrence becomes `<span class="tut-var" data-tut-var="groupNumber">XXX</span>`; an **inline-code** occurrence (`` `da164-{{var:groupNumber}}` ``) is wrapped as a span; a **fenced-block** occurrence becomes the sentinel `TUTVARxgroupNumberx` (NOT a span, NOT the literal brace token).
- [ ] **Step 2: Run** `npx vitest run scripts/parsers/__tests__/variables.test.ts` — expect FAIL (module missing).
- [ ] **Step 3: Implement** `scripts/parsers/variables.ts` with `validateVariables`, `wrapTokens`, `SENTINEL_RE`, `sentinelFor`, + types above. Add `TutorialVariable` and `variables?: TutorialVariable[]` to `scripts/parsers/types.ts` source frontmatter.
- [ ] **Step 4: Wire into `compose.ts`** — after frontmatter extraction, call `validateVariables(fm.variables, body)` (let it throw up through the publish pipeline = hard fail), and run `wrapTokens` over the body/step content alongside the existing `resolveImageURLs`/`resolveTutorialSlugLinks` transforms. Add `variables` to `ComposeResult`.
- [ ] **Step 5: Run** the test file — expect PASS. Then run the full parser suite (`npm run test:all` or the vitest default project) to confirm no regressions.
- [ ] **Step 6: Commit** (`feat(parser): declare + validate + wrap tutorial variables (prose/inline)`).

---

### Task 3: Fenced-code token wrapping in the Hugo render hook

**Files:**
- Modify: `hugo/layouts/_default/_markup/render-codeblock.html`
- Test: `scripts/parsers/__tests__/` cannot cover Hugo; verified by Task 8 e2e + a manual build check in this task.

**Interfaces:**
- Consumes: letters-only sentinels `TUTVARxNAMEx` left in fenced code by Task 2 (`SENTINEL_RE = /TUTVARx([A-Za-z0-9_]+)x/g`). Spike-verified: sentinels are lexer-opaque and survive Chroma highlighting intact in bash/js/text (unlike `{{var:NAME}}`, whose braces Chroma fragments into operator spans).
- Produces: in rendered code blocks, each sentinel replaced by `<span class="tut-var" data-tut-var="NAME"></span>` that survives Chroma highlighting and is copy-paste-correct (empty initial text; island fills it on mount).

Approach: highlight the code normally, then `replaceRE` the sentinel in the highlighted HTML with the span markup, emitting via `safeHTML`. The hook has no variables array, so the span text starts empty; the island overwrites on mount. Add the required `security-reviewed: variable-token sentinel→span, fixed attribute shape, name is [A-Za-z0-9_] only` comment within 3 lines of the `safeHTML`.

- [ ] **Step 1:** In `render-codeblock.html`, capture the highlighted output into a variable instead of emitting directly; apply `replaceRE` with pattern `TUTVARx([A-Za-z0-9_]+)x` → `<span class="tut-var" data-tut-var="$1"></span>`.
- [ ] **Step 2:** Emit via `safeHTML` with the `security-reviewed:` marker. Keep the plain-text (`lang==text`) branch handled too (line ~128) — the sentinel appears there intact as well.
- [ ] **Step 3: Run** `node scripts/check-hugo-safe-html.cjs` — expect PASS (marker present).
- [ ] **Step 4:** Build a fixture tutorial with a fenced `{{var:groupNumber}}` (which Task 2 turned into `TUTVARxgroupNumberx`) in a **bash** block specifically (the fragmenting case) and confirm the span is present (not fragmented, not `&lt;span&gt;`) and surrounding code still highlighted. Confirm a tutorial with no tokens produces byte-identical code HTML to before (diff against a pre-change build).
- [ ] **Step 5: Commit** (`feat(hugo): wrap variable tokens inside fenced code blocks`).

---

### Task 4: Emit the variables config + island mount in the tutorial layout

**Files:**
- Modify: `scripts/parsers/render-frontmatter.ts` (ensure `fm.variables` is serialized into generated frontmatter — may already be covered by Task 2 Step 4; this task guarantees the Hugo-visible shape)
- Modify: `hugo/layouts/tutorials/u1-object-page.html`

**Interfaces:**
- Consumes: `.Params.variables` (array of `TutorialVariable`-shaped maps) in the layout.
- Produces: in rendered page `<head>`/body — `<script id="tutorial-variables" type="application/json">…</script>`, a mount `<div id="tutorial-variables-panel" data-slug="…" data-mission-slug="…"></div>`, and a deferred module `<script src="{{ partial "island-src.html" "tutorial-variables" }}">`.

- [ ] **Step 1:** In `render-frontmatter.ts`, add `variables?: TutorialVariable[]` to `RenderHugoFrontmatterArgs` and set `fm.variables = args.variables` when non-empty (conditional, like `fm.osList`). Wire the fetch pipeline caller to pass it through.
- [ ] **Step 2:** In `u1-object-page.html`, next to the existing `tutorial-data` script block, add `{{ with .Params.variables }}<script id="tutorial-variables" type="application/json">{{ . | jsonify }}</script>{{ end }}`. Add the mount div near the top of the content region (below description, above Step 1) with `data-slug="{{ .Params.slug }}" data-mission-slug="{{ .Params.missionSlug }}"`. Add the module script tag alongside the other island scripts (mirror `tutorial-rating` at the existing lines).
- [ ] **Step 3:** Build a fixture tutorial WITH variables and one WITHOUT. Confirm: with → config script + mount present; without → neither emitted (and page byte-identical to today for the no-variables case).
- [ ] **Step 4: Commit** (`feat(hugo): emit variables config + island mount in tutorial layout`).

---

### Task 5: Vue island — render fields + live substitution + default filler

**Files:**
- Create: `hugo-apps/src/tutorial-variables/main.ts`
- Create: `hugo-apps/src/tutorial-variables/TutorialVariables.vue`
- Create: `hugo-apps/src/tutorial-variables/__tests__/substitution.test.ts` (vitest, jsdom)
- Modify: `hugo-apps/vite.config.ts` (add the entry to `build.rollupOptions.input`)

**Interfaces:**
- Consumes: `#tutorial-variables` JSON config (`TutorialVariable[]`), `#tutorial-variables-panel` mount with `data-slug` / `data-mission-slug`, all `.tut-var[data-tut-var]` spans on the page, and the `/auth/user` response shape (`{ email, id, givenName, familyName }`).
- Produces (exported pure helpers for unit testing, imported by `main.ts`):
  - `function applyValue(name: string, value: string, root: ParentNode = document): number` — sets `.textContent` of every `[data-tut-var="name"]` to `value`; returns count updated.
  - `function resolveDefault(v: TutorialVariable, identity: Record<string,string> | null): string | null` — if `v.default` and identity present, run `new RegExp(v.default.pattern)` against `identity[v.default.from]`, return capture group 1 or null.

- [ ] **Step 1: Write failing tests** (`substitution.test.ts`, jsdom):
  - `applyValue('groupNumber','007',root)` updates two spans and returns `2`.
  - `resolveDefault` with `{from:'email',pattern:'da164-(\\d+)@'}` and `identity={email:'da164-007@x'}` returns `'007'`; returns `null` when identity is `null`; returns `null` when pattern doesn't match.
- [ ] **Step 2: Run** `npx vitest run hugo-apps/src/tutorial-variables/__tests__/substitution.test.ts` — expect FAIL.
- [ ] **Step 3: Implement** `TutorialVariables.vue` (a header panel: one labelled `ui5-input`/input per variable honoring `type`/`maxLength`/`required` with validation) and `main.ts`: parse config, mount, on input call `applyValue` for the changed var, and on load resolve initial value via Task 6's precedence. Fetch `/auth/user` (credentials:'include') once for the default filler; on failure/anon, skip defaults silently. Export `applyValue`/`resolveDefault` as pure functions.
- [ ] **Step 4: Run** the test — expect PASS.
- [ ] **Step 5:** Add `'tutorial-variables': resolve(__dirname, 'src/tutorial-variables/main.ts')` to `vite.config.ts` input. Run the island build (`npm run build:apps` or the documented island build) and confirm `tutorial-variables-<hash>.js` lands in `hugo/static/js/` and `island_manifest.json` gets the entry.
- [ ] **Step 6: Commit** (`feat(island): tutorial-variables live substitution + default filler`).

---

### Task 6: Client-side persistence + mission carry-over

**Files:**
- Create: `hugo-apps/src/tutorial-variables/storage.ts`
- Create: `hugo-apps/src/tutorial-variables/__tests__/storage.test.ts`
- Modify: `hugo-apps/src/tutorial-variables/main.ts` (use storage for load/save)

**Interfaces:**
- Produces:
  - `function readValue(name: string, ctx: { missionSlug?: string; tutorialSlug: string }): string | null` — returns the most-specific stored value: `tutvar:<missionSlug>:<name>` if `missionSlug` present and set, else `tutvar:<tutorialSlug>:<name>`, else null.
  - `function writeValue(name: string, value: string, ctx): void` — writes the per-tutorial key always, and the mission key too when `missionSlug` present.
- Consumes: `data-mission-slug` / `data-slug` from the mount (Task 4).

- [ ] **Step 1: Write failing tests** (jsdom `localStorage`):
  - write with `{missionSlug:'m1',tutorialSlug:'t1'}` then `readValue` from `{missionSlug:'m1',tutorialSlug:'t2'}` returns the carried value (mission scope).
  - write with no `missionSlug`, read back per-tutorial returns it; a different tutorial returns null.
  - `readValue` precedence: mission key beats tutorial key when both set.
- [ ] **Step 2: Run** the test — expect FAIL.
- [ ] **Step 3: Implement** `storage.ts`. Wire `main.ts` load precedence: `readValue` → else `resolveDefault` → else `placeholder` (leave span as-is); on every input call `writeValue` + `applyValue`.
- [ ] **Step 4: Run** the test — expect PASS.
- [ ] **Step 5: Commit** (`feat(island): per-tutorial + mission-scoped variable persistence`).

---

### Task 7: `TutorialVariables` HANA entity, publish write path, Admin UI projection

**Files:**
- Modify: `db/schema.cds` (new entity + `Tutorials` composition back-ref)
- Modify: `db/persistence.cds` (`@cds.persistence.journal`)
- Create: `srv/lib/variables-publish.js` (`replaceVariablesForSlug`)
- Modify: the content publish handler to call it (mirror `/content/publish-contributors` wiring; find the contributors handler registration and add the variables call in the same publish flow)
- Modify: `srv/admin-service.cds` (read-only projection)
- Create: `test/hybrid/2811-tutorial-variables.test.js`

**Interfaces:**
- Produces:
  - CDS `entity TutorialVariables : cuid, LegacyKeyed { tutorial : Association to Tutorials; varName : String(100); varLabel : String(255); varType : String(20); maxLength : Integer; isRequired : Boolean; placeholder : String(255); defaultFrom : String(50); defaultPattern : String(500); configJson : LargeString; sortOrder : Integer; }` plus `Tutorials.variables : Composition of many TutorialVariables on variables.tutorial = $self`.
  - `async function replaceVariablesForSlug(db, slug, variables): Promise<{ok, slug, count}>` — DELETE-then-INSERT inside `cds.tx`, mirroring `contributors-publish.js:replaceContributorsForSlug`; maps each `TutorialVariable` to a row (flat columns + full `configJson = JSON.stringify(v)`); uses CQL only; lowercases slug.
- Consumes: `cds.entities('com.sap.developers.ims')`, the parsed `variables` from the publish payload.

- [ ] **Step 1: Write the hybrid failing test** (`2811-tutorial-variables.test.js`, mirror `1220-a2a-task-store.test.js`): `cds.test('serve','--project','.','--profile','hybrid')`, `describe.runIf(isSafeForWrites())`, call `replaceVariablesForSlug(db, slug, [oneVar])` then read back via CQL `SELECT.from(TutorialVariables).where({tutorial_ID})` and assert `varName`, `isRequired`, and a round-tripped `JSON.parse(configJson).default.from`.
- [ ] **Step 2: Run** `npm run test:hybrid` (needs `cf login` + `cds bind`) — expect FAIL (entity/function missing).
- [ ] **Step 3: Implement** the CDS entity + composition + journal annotation; generate the `.hdbmigrationtable` (via the project's standard `cds build`/deploy flow). Implement `replaceVariablesForSlug`. Wire it into the publish handler next to contributors.
- [ ] **Step 4:** Add the `AdminService` read-only projection (`@readonly entity TutorialVariables as projection on ims.TutorialVariables;`). Confirm it compiles (`cds compile srv` — note the pre-existing unrelated duplicate-def error in `developer-service-mcp.cds` may need to be sidestepped; do not fix it here, just confirm the new entity itself is valid).
- [ ] **Step 5: Run** `npm run test:hybrid` — expect PASS. Also add a fast SQLite unit test for the row-mapping shape (pure mapping, no reserved-word risk) for quick feedback.
- [ ] **Step 6: Commit** (`feat(cap): persist tutorial variables to HANA + admin projection`).

---

### Task 8: Admin UI list + end-to-end verification

**Files:**
- Modify: the lightest-fit admin component under `app/admin/` to list a tutorial's variables (nested list under tutorial detail; builder picks the exact component — read `docs/developers/operations/testing-endpoints.md` for the admin surface map)
- Create: `test/e2e/tutorial-variables.spec.ts`

**Interfaces:**
- Consumes: the `AdminService.TutorialVariables` read-only projection (Task 7); the deployed tutorial page with the island (Tasks 2–6).

- [ ] **Step 1:** Add the Admin UI read-only list of variables for a tutorial (columns: varName, varLabel, varType, isRequired). Follow the admin-UI full-deploy + bundle-gate rules in CLAUDE.md.
- [ ] **Step 2: Write the e2e spec** (Playwright, self-skips without `SMOKE_BASE_URL`): load a tutorial that declares `groupNumber`; type `007` in the panel field; assert a prose occurrence, an inline-code occurrence, AND a **fenced-code** occurrence all read `...007...`; reload and assert the value persisted; (if a two-tutorial mission fixture exists) navigate to a sibling and assert carry-over.
- [ ] **Step 3: Run** `npm run test:e2e` against a deploy that includes the feature — expect PASS. This is the "test the actual thing" gate: the fenced-code live substitution + persistence is the real deliverable.
- [ ] **Step 4: Commit** (`feat(admin,e2e): variables admin list + live-substitution e2e`).

---

## Notes for the executor

- **Delimiter is provisional until Task 1.** If the spike forces `::var:NAME::`, update the token literals in Tasks 2, 3, 5 and the regex in Task 3's `replaceRE`.
- **Two wrapping mechanisms** (Task 2 prose/inline, Task 3 fenced) is deliberate and load-bearing — Chroma escapes raw HTML in fences, so a single parser-side transform cannot do both.
- **CLAUDE.md anchors were stale** per recon: real upsert logic is `packages/content/content-publish-session.js` (`upsertTutorialMetadata` ~line 805); the contributors REPLACE-per-slug path (`srv/lib/contributors-publish.js`) is the model Task 7 follows.
- **Do not fix** the unrelated `developer-service-mcp.cds` duplicate-definition compile error; it predates this work.
- Deploy per CLAUDE.md: admin-UI changes need a FULL deploy (no `--skip-build`, no `-m` scoping); island JS must actually ship (watch the `ignore-scripts`/`build:all` gotcha).
