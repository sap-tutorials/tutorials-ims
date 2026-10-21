# Design: Fix OPTION-block rendering (issue #2820)

**Date:** 2026-10-20
**Issue:** sap-tutorials/tutorials-ims#2820
**Status:** Draft v2 — awaiting approval (HARD GATE, no code until approved)

> v1 of this design (switch shortcodes to percent-delimited) was **disproven by
> real Hugo renders** before any code was written: a block-`<div>`-emitting
> shortcode closes the surrounding tight list at *any* indent, so percent-delimiting
> relocated the same column-0 requirement to the body and reproduced the leak. v2
> below is verified against production-pinned Hugo 0.147.7.

## Intent and why

Tutorial steps containing an `[OPTION BEGIN]…[OPTION END]` block followed by
shared content (prose, image, `> [!TIP]` alerts) render **raw, unparsed markdown
inside a code block** on the live site (e.g. `hana-clients-install` step 3). This
is a regression worse than the original #2820 report. Three PRs (#2822, #2826,
#2842) each tried to fix it in place and slid the breakage sideways; #2842
(`19db8d027`) tipped it into the raw-markdown leak. All three are in deployed
v1.40.2.

Fix it once, structurally, so the class of bug cannot recur.

## Two proven facts that constrain any fix (real Hugo 0.147.7 renders)

1. **A Hugo shortcode that emits a block-level `<div>` closes the surrounding
   tight Markdown list, regardless of source indentation** (verified at 3/4/5
   spaces). Therefore the OPTION block **cannot be a child of the `<li>`**. #2820's
   original premise ("keep it nested in the list item") is unachievable with the
   current shortcode shape. The OPTION block is inherently a **sibling** of the
   numbered list.

2. **Once the list closes, every following line's block type is measured from
   column 0**, where CommonMark's ≥4-space rule makes anything at the authored
   4-space substep indent an **indented code block**. This is why the panel bodies
   are already dedented to column 0 today (#2703) — and why the **trailing shared
   tail must be too**.

The regression: commit `19db8d027` **removed** the "Bug B" tail-dedent that used
to push the trailing shared content to column 0. Without it, the tail stays at
4-space, the (already-closed) list measures it from column 0, and it leaks as
indented code — the SHELL box of raw markdown in the screenshot.

## The fix (verified)

**Restore the trailing-tail dedent to column 0 in `scripts/parsers/options.ts`,
and leave the shortcodes and panel-body dedent exactly as they are.**

Concretely: after `convertOptionBlocks` splices the OPTION shortcode for a group,
dedent the shared substep content that trails the group (up to the next top-level
numbered item or step boundary) to column 0, the same way panel bodies are
dedented. No shortcode changes, no CSS double-pass changes to the render path.

The author's own numbered ordinals do the rest: a bare `4.` after the col-0 tail
renders as `<ol start="4">` automatically (Goldmark reads the source ordinal — no
parser injection needed). The result is: list items 1–N, then the OPTION block +
tail as siblings, then `<ol start="N+1">` resuming the numbering.

### Proof (verbatim, production-pinned Hugo 0.147.7, real shortcodes + render hooks)

Input: `3.` substep with an OS OPTION group (```Shell``` bodies) + trailing prose
+ captioned image + two `> [!TIP]`, all dedented to column 0, followed by a bare
`4.`. Rendered output:

- fence → `<div class="code-block">` (real code block, not literal backticks) ✅
- image → `<figure class="tutorial-figure">` + `<figcaption>` ✅
- `> [!TIP]` → `<blockquote class="alert alert-tip">` ✅
- following substep → `<ol start="4">` (numbering continues) ✅
- **no `` ```Shell ``, no `![...]`, no `> [!TIP]` literal text anywhere** ✅

A second probe confirmed `<ol start="3">` resumes automatically from a bare `3.`
after column-0 intervening content.

## Why this is the right altitude (not the prior attempts)

The three prior fixes all tried to keep the OPTION block *inside* the list — which
the Hugo renders prove is impossible. This design accepts the honest DOM: the
block is a **sibling**, numbering continues via `<ol start>`, and the only thing
that must hold is "everything after the list-closing shortcode is at column 0."
That is a single, local, well-understood invariant — the exact one `19db8d027`
violated by deleting the tail-dedent.

## Visual contract to preserve (anti-goal: no visible change)

Rendered output must match a correct render:

- `> [!TIP]` green alert blockquote; captioned image left-aligned `<figure>`
  (#2820), single-line `<img>` (#1591); fences as `.code-block` with copy button.
- OS panels: all visible as no-JS fallback; `os-toggle.ts` shows only active OS.
- Substep numbering continuous across the OPTION block via `<ol start="N">`.

### CSS: one latent clobber must be fixed (the parser fix EXPOSES it)

The #2703/#2820 rules in `sap-fundamental.src.css` (~1347-1373) push
`.step-content > .os-options` and its `~ p/figure/pre/blockquote` siblings to
`margin-left: 1.5rem`, plus `.step-content > ol { margin-left: 0 }`. These are
built for exactly the sibling structure this fix produces. For the trailing
**prose** and **`> [!TIP]` blockquotes** they match and do their job (verified by
real-Hugo render + computed-style measurement: both land at 24px / 1.5rem).

**But the trailing captioned IMAGE is wrong** (measured: `margin-left: 0`, jammed
at the far-left column, out of alignment with the prose/tips around it). Root
cause — two equal-specificity rules both match the figure, so source order wins:

- line 1358: `.step-content > .os-options ~ figure { margin-left: 1.5rem }`
- line 1389: `.step-content > .os-options ~ .tutorial-figure { margin: 0.5rem 0 }`
  — **the later `margin` shorthand resets `margin-left` back to 0**, clobbering the
  indent above it.

This is a **pre-existing latent CSS bug**: today the trailing image leaks as raw
code, so it never renders as a `.tutorial-figure` in the tail and the clobber is
invisible. The parser fix makes the image render correctly as a figure, which
**exposes** the clobber. So the fix is **two parts**:

1. Parser: restore the Bug-B tail-dedent (stops the leak).
2. CSS: change line 1389's rhythm rule from the `margin: 0.5rem 0` shorthand to
   `margin-top`/`margin-bottom` (or re-assert `margin-left: 1.5rem`) so it sets
   vertical rhythm **without** resetting the horizontal indent. Apply to both the
   `~ .tutorial-figure` (os-options and option-tabs) selectors.

The `.os-panel .tutorial-figure` / `.option-tabs .tutorial-figure` entries on the
same rule (figures *inside* a panel) do NOT need the 1.5rem indent (the panel
already provides the column), so splitting that selector list is cleanest: keep
the shorthand for in-panel figures, use margin-top/bottom + margin-left:1.5rem for
the trailing (`~`) figures. Edit the `.src.css` SOURCE; the `.css` artifact is
generated by the build.

This corrects design v1's wrong assumption (that content moves *inside* the `<li>`)
AND the first draft of v2's over-optimistic "keep them, they just work" — the prose
and tips just work; the figure needs the shorthand clobber fixed.

## Non-goals / anti-goals

- Not changing tutorial markdown **source** (the Windows-variant additions from
  the issue thread are a separate tutorial-repo concern, tracked separately).
- Not changing the shortcode delimiters or `os-panel.html`'s `markdownify`.
- Not touching `os-toggle.ts` hydration / OS picker.
- Not touching the VitePress target branch.
- A pre-existing `<p>` wrapping the `<figure>` (invalid-ish but cosmetic, present
  in all working paths today) is **out of scope** — do not try to fix it here.

## Plan of work (failing-test-first; TDD)

1. **Reproducing test first** — render-level (real `convertOptionBlocks` + real
   Hugo shortcodes, mirroring `option-figure-list-nesting.test.ts`). Fixture = the
   exact #2820 shape (4-space-authored substep, OS OPTION group with fence body,
   trailing prose + captioned image + two `> [!TIP]`, then a `4.`). Assert no raw
   leak (`not.toContain('```Shell')`, no raw `![`/`> [!TIP]`), tip→`alert-tip`,
   image→`tutorial-figure`, fence→`.code-block`, and numbering resumes
   (`<ol start="4">`). Must **fail** on current `main`.
2. Restore the tail-dedent in `options.ts`; make the test pass. One change.
3. Update tests that encode the old (buggy) contract:
   `options-hugo.test.ts:425-468` (asserts the 4-space tail — now must assert
   col-0 tail) and `option-figure-list-nesting.test.ts` as needed. Keep
   `corpus-stepcount.test.ts` and `v2-fenced-h3.test.ts` green.
4. Fix the CSS figure-indent clobber (line ~1389) and confirm all trailing
   children (prose, figure, tips) land at the 1.5rem content column; reopened
   `<ol start>` not double-indented. Measure computed styles, don't eyeball.
5. Full render verification on real OPTION-heavy tutorials: `hana-clients-install`,
   `-hdbsql`, `-jdbc`, `-golang`, `deploy-to-kyma` — build + visual check.
6. PR targeting **DEV** (never direct-merge; PR review required).

## Golden reference for step 5

"Correct" = a render with no raw-markdown leak and the visual contract above. Since
deployed v1.40.2 and all three prior PRs are broken, the reference is the
**pre-#2822 behavior for the non-leaking parts** plus the proven render in this
doc for the OPTION region. Screenshots in issue #2820 define the user-visible
"wrong"; the step-1 test defines machine-checkable "right."

## Left to the builder

- Exact dedent boundary logic (where the "trailing tail" ends: next top-level
  `N.`, next `### `/step boundary, or EOF) — follow how the old Bug-B loop scoped
  it (`git show` the deletion in `19db8d027`) and the panel-body dedent.
- Test fixture wording/placement per existing conventions.
- Whether to reinstate the old loop verbatim or re-express it more clearly.

## Risks

- **Regular (non-OS) OPTION groups** use the same `convertOptionBlocks` splice, so
  the tail-dedent must cover them too (not just OS groups). The reproducing test
  should include a non-OS variant, or a second test. Confirm scope in step 1.
- **Tail scoping**: dedenting too far (past the next numbered item) would pull a
  genuinely-nested sub-list to column 0. The boundary must stop at the next
  top-level ordinal. Covered by the corpus gate + step 5.
- **A step with an OPTION block but no trailing tail** must be a no-op — verify.
