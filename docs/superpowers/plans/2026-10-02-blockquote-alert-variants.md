# Blockquote Alert Variants Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let tutorial authors opt into 4 SAP-semantic blockquote looks via GitHub alert syntax (`> [!TYPE]`), while plain `>` keeps today's blue default unchanged.

**Architecture:** Add a Hugo blockquote render hook that emits a bare `<blockquote>` for plain `>` (byte-identical to today) and `<blockquote class="alert alert-<type>">` for alerts. Add 4 color-only CSS variant classes mapped to Horizon semantic colors. Document the syntax for authors. No change to the default; no content migration.

**Tech Stack:** Hugo v0.147.7 (extended) blockquote render hooks (`.AlertType`), PostCSS (`build:css`), vitest.

**Spec:** `docs/superpowers/specs/2026-10-02-blockquote-alert-variants-design.md`

## Global Constraints

- **Plain `>` must render identically to today** — bare `<blockquote>…</blockquote>`, no class, no attribute changes. This is the one hard contract (keeps the global blue rule AND `single.html`'s `.generic-page__content blockquote` orange rule both matching).
- **Color-only** — variants set `border-left-color` + `background-color` only. No heading row, no icon, no other property.
- **5→4 type mapping (verbatim):** `[!NOTE]`→Information(blue), `[!IMPORTANT]`→Information(blue), `[!TIP]`→Success(green), `[!WARNING]`→Warning(amber), `[!CAUTION]`→Error(red).
- **CSS values** — reference the SAP token with the canonical Horizon-light hex as fallback (several semantic tokens are NOT declared in this project's theme-vars, so the fallback is load-bearing). Verified Horizon-light hex:
  - Information: border `#0070f2`, bg `#e1f4ff`
  - Success: border `#30914c`, bg `#f5fae5`
  - Warning: border `#dd6100`, bg `#fff8d6`
  - Error: border `#e90b0b`, bg `#ffeaf4`
- **No test harness renders Goldmark** — hook tests string-assert the `.html` file contents (pattern: `test/parsers/render-link-hook.test.ts`).
- Edit `sap-fundamental.src.css`, then regenerate `sap-fundamental.css` via `npm run build:css`; commit both (repo commits built CSS).
- Never edit generated `hugo/content/tutorials/`.

---

### Task 1: Blockquote render hook

**Files:**
- Create: `hugo/layouts/_default/_markup/render-blockquote.html`
- Test: `test/parsers/render-blockquote-hook.test.ts`

**Interfaces:**
- Consumes: Hugo blockquote render-hook context — `.AlertType` (string: `""` for plain `>`, else `note|tip|important|warning|caution`), `.Text` (rendered inner HTML, `template.HTML`).
- Produces: hook file at the fixed path above. No code symbols consumed by later tasks; Task 2 (CSS) depends only on the class names `alert-note`, `alert-tip`, `alert-important`, `alert-warning`, `alert-caution` emitted here.

- [ ] **Step 1: Write the failing test**

```ts
// test/parsers/render-blockquote-hook.test.ts
import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'

const p = 'hugo/layouts/_default/_markup/render-blockquote.html'

describe('render-blockquote hook', () => {
  it('exists', () => {
    expect(existsSync(p)).toBe(true)
  })

  it('has a plain-`>` passthrough branch (no class) preserving today’s default', () => {
    const t = readFileSync(p, 'utf8')
    // branches on an empty AlertType (plain blockquote)
    expect(t).toContain('.AlertType')
    expect(t).toMatch(/eq \.AlertType ""/)
    // plain path emits a bare blockquote with NO class attribute
    expect(t).toMatch(/<blockquote>\s*\{\{[-\s]*\.Text/)
  })

  it('emits a semantic alert class for alert blockquotes', () => {
    const t = readFileSync(p, 'utf8')
    expect(t).toContain('class="alert alert-{{ .AlertType }}"')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/parsers/render-blockquote-hook.test.ts`
Expected: FAIL — `exists` fails (file not created yet).

- [ ] **Step 3: Write the hook**

```go-html-template
{{- /* Blockquote render hook (#2595).
     Plain `>` (AlertType == "") renders byte-identical to Hugo's default so the
     global blue blockquote style and single.html's scoped style both keep
     matching. GitHub-style alerts (`> [!TYPE]`) get a semantic class; CSS in
     sap-fundamental.src.css maps each to a SAP MessageStrip color (color-only).
     Unknown designators resolve to AlertType "" and take the plain path. */ -}}
{{- if eq .AlertType "" -}}
<blockquote>{{ .Text }}</blockquote>
{{- else -}}
<blockquote class="alert alert-{{ .AlertType }}">{{ .Text }}</blockquote>
{{- end -}}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/parsers/render-blockquote-hook.test.ts`
Expected: PASS (3 passing).

- [ ] **Step 5: Commit**

```bash
git add hugo/layouts/_default/_markup/render-blockquote.html test/parsers/render-blockquote-hook.test.ts
git commit -m "feat(2595): blockquote render hook with semantic alert classes"
```

---

### Task 2: Semantic variant CSS

**Files:**
- Modify: `hugo/assets/css/sap-fundamental.src.css` (append after the base `blockquote` rule at ~line 873)
- Regenerate: `hugo/assets/css/sap-fundamental.css` (via `npm run build:css`)
- Test: `test/parsers/blockquote-alert-css.test.ts`

**Interfaces:**
- Consumes: class names `alert-note`, `alert-important`, `alert-tip`, `alert-warning`, `alert-caution` emitted by Task 1's hook.
- Produces: 4 CSS rule-sets in both `.src.css` and the built `.css`. No code symbols.

- [ ] **Step 1: Write the failing test**

```ts
// test/parsers/blockquote-alert-css.test.ts
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

const src = 'hugo/assets/css/sap-fundamental.src.css'
const built = 'hugo/assets/css/sap-fundamental.css'

describe('blockquote alert variant CSS', () => {
  it('source defines all four variant selectors', () => {
    const t = readFileSync(src, 'utf8')
    expect(t).toContain('blockquote.alert-note')
    expect(t).toContain('blockquote.alert-important')
    expect(t).toContain('blockquote.alert-tip')
    expect(t).toContain('blockquote.alert-warning')
    expect(t).toContain('blockquote.alert-caution')
  })

  it('tip maps to Horizon success green, caution to error red, warning to amber', () => {
    const t = readFileSync(src, 'utf8')
    expect(t).toContain('#30914c') // success border
    expect(t).toContain('#f5fae5') // success bg
    expect(t).toContain('#dd6100') // warning border
    expect(t).toContain('#fff8d6') // warning bg
    expect(t).toContain('#e90b0b') // error border
    expect(t).toContain('#ffeaf4') // error bg
  })

  it('built css was regenerated with the variant selectors', () => {
    const t = readFileSync(built, 'utf8')
    expect(t).toContain('.alert-tip')
    expect(t).toContain('.alert-warning')
    expect(t).toContain('.alert-caution')
  })

  it('does not alter the base blockquote default (blue Information still present)', () => {
    const t = readFileSync(src, 'utf8')
    expect(t).toContain('--sapInformationBackground')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/parsers/blockquote-alert-css.test.ts`
Expected: FAIL — variant selectors not present in `.src.css`.

- [ ] **Step 3: Append the variant CSS to `sap-fundamental.src.css`**

Insert immediately after the closing `}` of the base `blockquote { … }` rule (around line 880):

```css
/* Semantic alert callouts (#2595) — author opt-in via `> [!TYPE]`.
   Base `blockquote` (blue Information) remains the default for plain `>`.
   Color-only: override border + fill, nothing else. Horizon-light hex are
   fallbacks because several --sap*Background/BorderColor tokens are not
   declared in this project's theme-vars. */
blockquote.alert-note,
blockquote.alert-important {
  border-left-color: var(--sapInformationBorderColor, #0070f2);
  background-color: var(--sapInformationBackground, #e1f4ff);
}
blockquote.alert-tip {
  border-left-color: var(--sapSuccessBorderColor, #30914c);
  background-color: var(--sapSuccessBackground, #f5fae5);
}
blockquote.alert-warning {
  border-left-color: var(--sapWarningBorderColor, #dd6100);
  background-color: var(--sapWarningBackground, #fff8d6);
}
blockquote.alert-caution {
  border-left-color: var(--sapErrorBorderColor, #e90b0b);
  background-color: var(--sapErrorBackground, #ffeaf4);
}
```

- [ ] **Step 4: Regenerate the built CSS**

Run: `npm run build:css`
Expected: exit 0; `hugo/assets/css/sap-fundamental.css` now contains the `.alert-*` selectors.

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run test/parsers/blockquote-alert-css.test.ts`
Expected: PASS (4 passing).

- [ ] **Step 6: Commit**

```bash
git add hugo/assets/css/sap-fundamental.src.css hugo/assets/css/sap-fundamental.css test/parsers/blockquote-alert-css.test.ts
git commit -m "feat(2595): color-only CSS for blockquote alert variants"
```

---

### Task 3: Author documentation

**Files:**
- Modify: `docs/authors/writing-tutorials.md` (add an "Alert callouts" subsection)

**Interfaces:**
- Consumes: nothing (docs only).
- Produces: nothing consumed by later tasks.

- [ ] **Step 1: Add the "Alert callouts" subsection**

Add after section 3.3 (Steps) — before the code-block section (~line 285). Content:

````markdown
### Alert callouts

A plain blockquote (`>`) renders as the default blue **Information** callout.
To signal a different kind of emphasis, start the blockquote with a
GitHub-style alert designator on its own first line:

```markdown
> [!TIP]
> Prefer the frontmatter `video:` field over an inline iframe.
```

| You write | Rendered emphasis | Color |
|---|---|---|
| `> text` (no designator) | Information (default) | blue |
| `> [!NOTE]` | Information | blue |
| `> [!IMPORTANT]` | Information | blue |
| `> [!TIP]` | Success | green |
| `> [!WARNING]` | Warning | amber |
| `> [!CAUTION]` | Error | red |

Pick the designator by *intent*, not loudness: use `[!TIP]` for helpful
asides, `[!WARNING]`/`[!CAUTION]` only for genuine risk. An ordinary
"additional note" can stay a plain `>` (blue) or use `[!NOTE]`. The callout is
color-only — there is no icon or heading label.
````

- [ ] **Step 2: Verify the doc renders (manual, no test)**

Confirm the table and fenced example are well-formed markdown (GitHub preview or `npx markdownlint docs/authors/writing-tutorials.md` if available — do not fail the task on pre-existing lint in untouched lines).

- [ ] **Step 3: Commit**

```bash
git add docs/authors/writing-tutorials.md
git commit -m "docs(2595): document blockquote alert callout syntax for authors"
```

---

### Task 4: Visual verification + full-suite check

**Files:** none (verification task).

**Interfaces:** none.

- [ ] **Step 1: Create a throwaway fixture tutorial**

Create `hugo/content/tutorials/_alert-smoke.md` (leading underscore → Hugo treats as draft/non-list; delete before commit) with frontmatter copied from any existing tutorial plus a body containing a plain `>`, and one of each `[!NOTE]`, `[!TIP]`, `[!IMPORTANT]`, `[!WARNING]`, `[!CAUTION]`.

- [ ] **Step 2: Run the dev server and eyeball**

Run: `npm run dev`
Expected in browser at the fixture URL:
- plain `>` = blue (identical to before this change)
- `[!NOTE]`, `[!IMPORTANT]` = blue
- `[!TIP]` = green
- `[!WARNING]` = amber
- `[!CAUTION]` = red

- [ ] **Step 3: Delete the fixture**

```bash
rm hugo/content/tutorials/_alert-smoke.md
```

- [ ] **Step 4: Run the full relevant test subset**

Run: `npx vitest run test/parsers/`
Expected: PASS, including the two new test files and no regression in existing parser tests.

- [ ] **Step 5: Confirm nothing staged from the fixture**

Run: `git status --porcelain`
Expected: no `_alert-smoke.md`; only committed work from Tasks 1–3 present.

---

## Self-Review

**1. Spec coverage:**
- Render hook (spec §Components.1) → Task 1 ✓
- 4 variant CSS + 5→4 mapping (spec §Components.2, §Decision) → Task 2 ✓
- Author docs (spec §Components.3) → Task 3 ✓
- No migration (spec §Components.4) → honored (no content edits) ✓
- Plain-`>` invariant (spec §Invariants) → Task 1 Step 1 test + Task 4 Step 2 visual ✓
- Testing approach (spec §Testing) → Tasks 1,2 string-assert hooks/CSS; Task 4 visual ✓

**2. Placeholder scan:** No TBD/TODO; all code blocks concrete; hex values resolved from authoritative Horizon source. ✓

**3. Type consistency:** Class names `alert-note/important/tip/warning/caution` identical across Task 1 (emitter) and Task 2 (CSS). Hex values in Task 2 CSS match the test assertions in Task 2 Step 1 and the Global Constraints table. ✓

**Correction logged vs. spec:** spec's draft fallback hex for success-bg/warning were approximate; this plan uses the verified Horizon-light values (`#f5fae5`, `#dd6100`/`#fff8d6`). The spec will be updated to match.
