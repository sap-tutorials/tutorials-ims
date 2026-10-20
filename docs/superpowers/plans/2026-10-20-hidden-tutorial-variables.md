# Hidden & Author-Fixed Tutorial Variables Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let tutorial authors declare a variable with a fixed literal `value:` and/or hide it from the reader-facing "Your values" panel via `display: false`, while it still substitutes throughout the tutorial body.

**Architecture:** Extend the existing #2811 tutorial-variables feature with two optional frontmatter fields — `value?: string` (author-fixed literal) and `display?: boolean` (default `true`). Build-time: validate + carry both through compose → render-frontmatter → Hugo frontmatter → island JSON config (no change to token-wrapping; hidden vars still emit `[data-tut-var]` spans/sentinels and are substituted client-side). Runtime (Vue island): render an input only for variables where `display !== false`; seed **every** variable's value with precedence `value` > identity `default` (regex) > persisted/stored > empty, and `applyValue()` so hidden/fixed vars substitute even with no input field.

**Tech Stack:** TypeScript (Node build scripts, Vitest), Vue 3 SFC island, Hugo Go templates.

**Spec:** GitHub issue [#2852](https://github.com/sap-tutorials/tutorials-ims/issues/2852) — "Variables feature - no display to user." (no separate design doc; this plan is the design of record)

## Global Constraints

- Default MUST be to display (`display` absent or `true` → input shown). Copied from issue: "Default is to display them."
- A literal `value:` MUST override a regex `default:` when both are present. Precedence: `value` > `default` > stored/reader input > empty. (User decision, this conversation.)
- No new npm dependencies.
- Backward compatible: a tutorial whose variables declare neither new field behaves exactly as today (input shown, no literal value).
- The client-side `TutorialVariable` interface in `hugo-apps/src/tutorial-variables/substitution.ts` MUST stay field-compatible with the build-side one in `scripts/parsers/variables.ts` (the island receives these objects verbatim as JSON).
- XSS: a literal `value` reaches the DOM only via `applyValue()` which sets `.textContent` (never innerHTML) — keep it that way; do not interpolate `value` into any HTML string.

## Review Focus

- **`value` with HTML/script-ish characters** (e.g. `value: "<b>x</b>"`) — must render as literal text, never parsed HTML. Pinned in Task 4 island test (`applyValue` already uses textContent; add a test asserting a `value` with `<` survives as text).
- **`display: false` with a non-boolean (`display: "false"` string)** — validator must reject non-boolean `display`. Pinned in Task 1.
- **Hidden variable (`display:false`) with no `value` and no `default`** — substitutes to empty string, must not throw or leave the literal token/sentinel visible. Pinned in Task 4.
- **`label` omitted on a `display:false` variable** — allowed (no visible label needed); but omitted on a displayed variable must still throw. Pinned in Task 1.
- **All variables hidden** — the "Your values" panel must not render an empty shell (no heading/hint with zero inputs). Pinned in Task 4.

---

### Task 1: Validate `value` and `display` in the build-time parser

**Files:**
- Modify: `scripts/parsers/variables.ts` (interface ~31-42; validation loop ~122-214)
- Test: `scripts/parsers/__tests__/variables.test.ts`

**Interfaces:**
- Produces: `TutorialVariable` gains `value?: string` and `display?: boolean`. `label` becomes optional in the type (`label?: string`) but `validateVariables` still throws when `label` is missing/empty AND `display !== false`.

- [ ] **Step 1: Write failing tests** in `variables.test.ts`:
  - `accepts a variable with a literal value` — `[{name:'prod',label:'P',type:'string',value:'MyApp 2.0'}]` → result[0].value === 'MyApp 2.0'.
  - `accepts display:false and omits it as not-shown` — `[{name:'prod',type:'string',value:'x',display:false}]` → result[0].display === false (and no throw despite missing label).
  - `throws when display is not a boolean` — `[{name:'prod',label:'P',type:'string',display:'false'}]` → throws `VariablesValidationError` matching `/display/`.
  - `throws when value is not a string` — `[{name:'prod',label:'P',type:'string',value:123}]` → throws matching `/value/`.
  - `throws when label missing on a displayed variable` — `[{name:'prod',type:'string'}]` → throws matching `/label/` (existing behavior preserved for the default display=true case).
  - `defaults display to shown when absent` — `[{name:'g',label:'G',type:'string'}]` → `result[0].display` is `undefined` (absence = shown; island treats `!== false` as shown).

- [ ] **Step 2: Run to verify fail** — `npx vitest run scripts/parsers/__tests__/variables.test.ts` → FAIL (value/display not carried; label-missing no longer throws for hidden).

- [ ] **Step 3: Implement** in `variables.ts`:
  - Add `value?: string` and `display?: boolean` to the interface; change `label` to `label?: string`.
  - In the loop: read `display` first; if present and not `typeof === 'boolean'` → throw `tutorial variables "<name>": display must be a boolean`.
  - Label check: throw missing-label only when `display !== false`. (Keep exact existing message for the displayed case.)
  - Read `value`: if present and `typeof !== 'string'` → throw `tutorial variables "<name>": value must be a string`.
  - On the validated object: `if (typeof raw['value'] === 'string') validated.value = raw['value']`; `if (typeof raw['display'] === 'boolean') validated.display = raw['display']`.

- [ ] **Step 4: Run to verify pass** — same command → PASS.

- [ ] **Step 5: Commit** — `feat(#2852): validate value + display fields on tutorial variables`.

---

### Task 2: Carry `value`/`display` through compose + source-frontmatter type

**Files:**
- Modify: `scripts/parsers/types.ts` (`TutorialFrontmatter.variables` inline schema ~23-31)
- Test: `scripts/parsers/__tests__/variables.test.ts` (the `composeTutorial with variables` integration describe block)

**Interfaces:**
- Consumes: Task 1 `TutorialVariable`.
- Produces: `TutorialFrontmatter.variables[]` inline type gains `value?: string` and `display?: boolean` and `label?` optional. `composeTutorial` already spreads the validated array into `ComposeResult.variables` (no code change there) — this task proves the new fields survive compose.

- [ ] **Step 1: Write failing test** — in the `composeTutorial with variables` block, add `carries value and display through compose`: a v2 tutorial whose frontmatter declares `variables: [{name:'prod',type:'string',value:'MyApp 2.0',display:false}]` and body uses `{{var:prod}}`; assert `result.variables[0].value === 'MyApp 2.0'` and `result.variables[0].display === false`, and that `result.body` contains a `data-tut-var="prod"` span (substitution still wired).

- [ ] **Step 2: Run to verify fail** — `npx vitest run scripts/parsers/__tests__/variables.test.ts` → FAIL (type rejects fields / assertion).

- [ ] **Step 3: Implement** — in `types.ts`, add `value?: string`, `display?: boolean` to the `variables?` array element and make `label?` optional. (No `compose.ts` logic change — it passes the validated array through.)

- [ ] **Step 4: Run to verify pass** — PASS.

- [ ] **Step 5: Commit** — `feat(#2852): thread value/display through compose + source type`.

---

### Task 3: Emit `value`/`display` into Hugo frontmatter

**Files:**
- Modify: `scripts/parsers/render-frontmatter.ts` (type import side ~75-80; emit ~198)
- Test: add `scripts/parsers/__tests__/render-frontmatter-variables.test.ts` (mirrors the existing `render-frontmatter-*.test.ts` files; `renderHugoFrontmatter(args): string` returns the YAML frontmatter string, assert on substrings)

**Interfaces:**
- Consumes: Task 1 `TutorialVariable` (already imported at `render-frontmatter.ts:8`).
- Produces: Hugo content frontmatter `variables:` array includes `value`/`display` keys verbatim when set. Downstream Hugo template (`u1-object-page.html:510`) jsonifies `.Params.variables` unchanged — no template change needed because it serializes the whole array.

- [ ] **Step 1: Write failing test** — in a new `render-frontmatter-variables.test.ts`, `emits value and display in frontmatter when set`: call `renderHugoFrontmatter(args)` (build `args` the way the sibling `render-frontmatter-*.test.ts` files do) with `variables: [{name:'prod',type:'string',value:'MyApp 2.0',display:false}]`; assert the returned string contains `value: MyApp 2.0` and `display: false`.

- [ ] **Step 2: Run to verify fail** — `npx vitest run scripts/parsers/__tests__/render-frontmatter*.test.ts` → FAIL.

- [ ] **Step 3: Implement** — the current emit `if (variables && variables.length > 0) fm.variables = variables` already copies all fields verbatim. Confirm `variables` is typed to include the new fields (it uses `TutorialVariable`); if the local destructured type is a narrower inline shape, widen it. Likely a no-op beyond confirming the type carries through — add fields only if a narrower type blocks them.

- [ ] **Step 4: Run to verify pass** — PASS.

- [ ] **Step 5: Commit** — `feat(#2852): emit value/display in tutorial Hugo frontmatter`.

---

### Task 4: Island — hide non-displayed inputs, seed value precedence, substitute all

**Files:**
- Modify: `hugo-apps/src/tutorial-variables/substitution.ts` (`TutorialVariable` interface ~17-23; add `resolveInitial` helper)
- Modify: `hugo-apps/src/tutorial-variables/TutorialVariables.vue` (template `v-if` + `v-for`; `onMounted`)
- Test: `hugo-apps/src/tutorial-variables/__tests__/substitution.test.ts`

**Interfaces:**
- Consumes: island config objects now carrying `value?: string`, `display?: boolean`.
- Produces: `resolveInitial(v: TutorialVariable, identity: Record<string,string>|null): string | null` — returns `v.value` if a non-empty string; else `resolveDefault(v, identity)`; else `null`. (`value` overrides `default`.)

- [ ] **Step 1: Write failing tests** in `substitution.test.ts`:
  - Add `value?: string` / `display?: boolean` to the local test `TutorialVariable` usages as needed.
  - `resolveInitial prefers literal value over default` — var with both `value:'FIXED'` and a matching `default` + identity → returns `'FIXED'`.
  - `resolveInitial falls back to default when no value` — var with only `default`, matching identity → returns the regex capture.
  - `resolveInitial returns null when neither value nor resolvable default` — returns `null`.
  - `applyValue renders a value containing < as literal text` — `applyValue('x','<b>hi</b>')` on a `[data-tut-var="x"]` span → `span.textContent === '<b>hi</b>'` and `span.children.length === 0`.

- [ ] **Step 2: Run to verify fail** — `npx vitest run hugo-apps/src/tutorial-variables/__tests__/substitution.test.ts` → FAIL (`resolveInitial` undefined).

- [ ] **Step 3: Implement**:
  - `substitution.ts`: add `value?: string` and `display?: boolean` to `TutorialVariable` (keep `label?` optional to match build side). Add and export `resolveInitial`.
  - `TutorialVariables.vue`:
    - Add `import { resolveInitial } from './substitution'`.
    - Template: compute `const shown = computed(() => props.variables.filter(v => v.display !== false))`. Panel `<section v-if="shown.length">`; `v-for="v in shown"`.
    - `onMounted`: iterate **all** `props.variables` (not just shown). For each: initialise `fieldValues[v.name]=''`. Restore persisted (existing). Then if field still empty, set from `resolveInitial(v, identity)` when non-null and `applyValue`. A literal `value` must apply even for hidden vars — so order: persisted (only meaningful for shown/editable) then `resolveInitial`. Since `value` should win over a stale persisted entry for *fixed* vars, apply `value` unconditionally for `display === false` (hidden = author-owned, not reader-owned): if `v.display === false && typeof v.value === 'string'` set `fieldValues[v.name]=v.value` and `applyValue` regardless of stored.
  - Leave `onInput`/storage untouched (hidden vars have no input, so onInput never fires for them).

- [ ] **Step 4: Run to verify pass** — PASS.

- [ ] **Step 5: Commit** — `feat(#2852): island hides non-displayed vars, value overrides default`.

---

### Task 5: Documentation + example + full island build/manifest

**Files:**
- Modify: `scripts/parsers/variables.ts` top doc-comment (document `value`/`display`)
- Modify: relevant reference doc if one documents variable frontmatter (grep `docs/` for the variables schema; update the schema table if found)
- Build: rebuild the island bundle + island manifest so the shipped JS includes the island changes

**Interfaces:**
- Consumes: Tasks 1-4.

- [ ] **Step 1:** Update the doc-comment block in `variables.ts` to show `value:` and `display:` with a one-line each explanation and the precedence note.

- [ ] **Step 2:** `grep -rn "display\|value\|variables:" docs/ | grep -i variable` — if a schema doc exists for tutorial variables, add the two fields + precedence + default-display note. If none, skip (note in commit).

- [ ] **Step 3:** Rebuild island + manifest so the bundle isn't stale (gotcha: `ignore-scripts=true` means `postbuild:apps` won't auto-run). Run the island build the repo uses (`npm run build:apps` or the vite build for hugo-apps) and the island-manifest step, then confirm `hugo/data/island_manifest.json` points at the new `tutorial-variables-*.js` and the file exists under `hugo/static/js/`.

- [ ] **Step 4: Run full variable test suites** — `npx vitest run scripts/parsers/__tests__/variables.test.ts hugo-apps/src/tutorial-variables/__tests__/` → all PASS.

- [ ] **Step 5: Commit** — `docs(#2852): document value/display + rebuild variables island`.

---

## Notes for the executor

- The canonical demo tutorial `hugo/content/tutorials/use-variables-in-tutorials.md` is **generated** from the `sap-tutorials` source repo at build time — do NOT hand-edit it. Updating the live demo tutorial to exercise a hidden/fixed variable is a separate source-repo change (out of scope for this PR; mention in the PR body as a follow-up).
- PR targets **DEV**, not `main`. Branch is already reset onto `origin/DEV`.
- Keep each task's commit scoped; the whole-branch review runs after Task 5.
