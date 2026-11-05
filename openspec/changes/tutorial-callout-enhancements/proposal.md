## Why

Callouts are the main way authors add context, warnings and troubleshooting. Today `> [!TIP]` etc. (#2595) render as color-only boxes with no title or icon, so a reader can't tell a warning from a tip without relying on color (an accessibility gap) and authors can't name a callout ("Costs money"). Long "why does this work" explanations and troubleshooting notes clutter the main path, there's no standard "you should now see…" checkpoint, and exercise solutions are visible before readers try.

## What Changes

- **Alert titles + icons**: `> [!WARNING] Costs money` — text after the designator becomes a title. Every alert type gets an icon and a visually hidden type label, so meaning no longer relies on color alone. Untitled alerts keep today's body-only layout, plus the icon.
- **New alert types** (same `> [!TYPE]` syntax, rendered by the blockquote render hook):
  - `[!DETAILS]` — collapsible, closed by default, title required (`> [!DETAILS] Why does this work?`); `[!DETAILS+]` starts open.
  - `[!TROUBLESHOOT]` — collapsible "If something goes wrong" box; also collected into a per-tutorial "Troubleshooting" index at the end of the tutorial with links back to steps.
  - `[!RESULT]` — "You should see" checkpoint box (success styling) that may contain a screenshot; if the step has an `[ASSERT_N]`, a "Verify automatically" link points to it.
  - `[!HINT]` — collapsed "Show hint" reveal for exercises; multiple consecutive hints reveal progressively (Hint 1, Hint 2…). `[!SOLUTION]` same, labelled "Show solution", with optional confirmation.
- **Inline spoiler**: `:spoiler[answer]` directive renders blurred text revealed on click/keyboard.
- Equivalent container directives (`:::details[Title]`, `:::hint`) registered on the directive grammar for authors who need nesting (code fences, lists) without `>` prefixes on every line.

## Capabilities

### New Capabilities
- `tutorial-callout-enhancements`: titled and iconified alerts, collapsible details/troubleshooting, result checkpoints, hints/solutions, and spoilers.

### Modified Capabilities
<!-- none (alert behaviour is not yet captured in an openspec spec) -->

## Impact

- `hugo/layouts/_default/_markup/render-blockquote.html` (title extraction, icons, `<details>` for collapsible types), CSS in `sap-fundamental.src.css`.
- Goldmark only recognises GitHub's five alert types natively — a small parser pre-pass (`scripts/parsers/blockquote-alerts.ts`) normalises the new designators and `+` suffix into a form the render hook can read (e.g. a data marker line), fence-aware.
- Troubleshooting index: collected at parse time into step frontmatter, rendered by `tutorial-step`/single layout.
- Directive registrations (`details`, `hint`, `solution`, `spoiler`) depend on `tutorial-directive-grammar`; the `> [!TYPE]` forms do not.
- MCP/AI plain-text fallback, author docs "Alert callouts" section update.
