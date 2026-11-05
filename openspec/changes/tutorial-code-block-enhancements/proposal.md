## Why

Code is the heart of a developer tutorial, and the most common reader frustrations are code-related: copying a terminal block also copies the `$` prompt and the sample output, "change line 12 to…" instructions that force readers to diff by eye, `<YOUR_SUBACCOUNT>` placeholders that must be hand-replaced in every block, ASCII-art project trees, and long code dumps with explanations scattered below. Authors work around each of these with prose. Small, markdown-native conventions can fix all of them.

## What Changes

- **Console blocks**: in fences tagged `console`, `shell-session`, or with `{prompt}`, lines starting with a prompt (`$ `, `> `, `PS> `, `# `) are commands and other lines are output. Output is visually dimmed and the copy button copies commands only (without prompts). Multi-line commands with trailing `\` / `` ` `` / `^` continuation stay grouped.
- **Diff / change markers**: inline comment markers `[!code ++]`, `[!code --]`, `[!code focus]`, `[!code highlight]` (Shiki/VitePress convention) at the end of a line in any language, plus ```` ```js {diff} ```` for unified-diff input. Added lines are highlighted green, removed red, focus dims the rest. Copy yields the **final** code (removed lines and markers stripped).
- **Fill-in placeholders**: tokens like `<YOUR_SUBACCOUNT>` / `<your-space-name>` inside code are detected by a strict pattern and rendered as clickable chips; filling one fills all occurrences on the page, persisted like variables. Authors opt in per tutorial via frontmatter `placeholders: auto` or declare them explicitly (lightweight sugar over the existing `variables:` runtime).
- **File trees**: a ```` ```tree ```` fence with indentation renders as an accessible tree with folder/file icons; `+` prefix marks new files, `~` modified, `-` deleted; trailing `# comment` becomes an annotation.
- **Code walkthrough**: `:::walkthrough` container wrapping one code fence followed by a numbered list whose items start with `{lines}` (e.g. `1. {3-5} Defines the entity…`). Clicking/focusing a note highlights its line range; on narrow screens notes render below the code.
- All features have plain-text fallbacks for MCP/AI consumers.

## Capabilities

### New Capabilities
- `tutorial-code-block-enhancements`: console prompt/output separation, diff markers, fill-in placeholders, file-tree fences, and code walkthroughs.

### Modified Capabilities
<!-- none -->

## Impact

- `hugo/layouts/_default/_markup/render-codeblock.html` (new `console`/`tree` handling, diff/focus classes, data attributes for copy), `hugo/assets/js/code-copy.ts` and `copy-clean.ts` (copy rules), new `hugo/assets/js/code-walkthrough.ts`, placeholder chips reuse the `variables` client runtime from #2811.
- `scripts/parsers/`: placeholder detection pass (fence-aware, after `wrapTokens`), `walkthrough` directive registered on `tutorial-directive-grammar`.
- CSS in `hugo/assets/css/sap-fundamental.src.css` (Horizon + dark mode).
- `srv-mcp` step output via `renderDirectivesAsText()` and a code-marker stripper.
- Depends on `tutorial-directive-grammar` (walkthrough only); the other features are fence-level and can ship independently.
