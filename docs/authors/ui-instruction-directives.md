# UI Instruction Directives

Five inline directives for marking up tutorial prose that refers to UI elements, keyboard shortcuts, icons, and Joule prompts. They render with consistent styling in the HTML output, adapt to the reader's OS for keyboard shortcuts, and surface a "Ask Joule" affordance for quick AI assistance.

---

## Quick reference

| Directive | Use for | Example source |
|-----------|---------|----------------|
| `:menu[...]` | Menu paths, breadcrumb-style navigation | `:menu[File > New Project]` |
| `:kbd[...]` | Keyboard shortcuts | `:kbd[Mod+S]` |
| `:icon[...]` | UI5 icons referenced in prose | `:icon[add]` |
| `:ui[...]` | UI labels (buttons, fields, tabs, links) | `:ui[Save]{type=button}` |
| `:ask[...]` | Ask-Joule prompt button | `:ask[What is a CDS projection?]` |

---

## `:menu` — navigation paths

Use `:menu` for any sequence of menu items, toolbar entries, or breadcrumb paths the reader must follow.

**Syntax:** `:menu[Segment One > Segment Two > Segment Three]`

Separate segments with ` > ` (space-greater-than-space) or ` → ` (space-arrow-space). The directive renders each segment as a pill with a chevron separator.

**Examples:**

```markdown
Select :menu[File > New > Project] from the menu bar.

Navigate to :menu[SAP HANA Cloud Central → Connections → Add Connection].
```

**Accessibility:** The rendered element carries an `aria-label` that reads the full path with "then" between segments (e.g. "File, then New, then Project"), so screen readers announce it naturally.

---

## `:kbd` — keyboard shortcuts

Use `:kbd` for keyboard shortcuts the reader must press. The directive renders Windows/Linux keys by default and swaps to macOS symbols when the reader's OS preference is detected.

**Syntax:** `:kbd[key+key+...]`

Supported key tokens: `Mod`, `Alt`, `Shift`, `Ctrl`, `Enter`, `Esc`, `Tab`, `Space`, `ArrowLeft`, `ArrowRight`, `ArrowUp`, `ArrowDown`, `F1`–`F24`, and any single printable character (letters, digits, punctuation).

`Mod` is the smart modifier: it renders as `Ctrl` on Windows/Linux and `⌘` on macOS.

**Examples:**

```markdown
Save the file with :kbd[Mod+S].

Open the command palette with :kbd[Mod+Shift+P].

Press :kbd[Ctrl+Alt+T] to open a terminal.
```

### OS rendering

| Token | Windows / Linux | macOS |
|-------|----------------|-------|
| `Mod` | `Ctrl` | `⌘` |
| `Alt` | `Alt` | `⌥` |
| `Shift` | `Shift` | `⇧` |
| `Ctrl` | `Ctrl` | `⌃` |
| `Enter` | `Enter` | `↩` |

Tokens are joined with `+` on Windows/Linux and concatenated without separator on macOS (e.g. `⌘⇧P`).

### Explicit platform overrides

If a shortcut differs on a specific platform rather than just the modifier symbol, use the `win`, `mac`, or `linux` attributes to override the computed value for that platform:

```markdown
:kbd[Mod+T]{mac="Ctrl+Option+T"}
```

This renders `Ctrl+T` on Windows/Linux and `Ctrl+Option+T` on macOS (verbatim, not re-tokenized). Use overrides sparingly — `Mod` handles the common `Ctrl`/`⌘` substitution automatically.

---

## `:icon` — UI5 icons

Use `:icon` when referring to a UI5 icon that appears in the interface. The directive renders a small inline icon glyph.

**Syntax:** `:icon[icon-name]` or `:icon[icon-name]{label="Descriptive name"}`

The icon name must be a valid name from the `@ui5/webcomponents-icons` package. To find available names, look in `node_modules/@ui5/webcomponents-icons/dist/` — each `.js` file (minus the `.js` extension) is a valid icon name. Common examples: `add`, `accept`, `cancel`, `delete`, `edit`, `save`, `search`, `filter`.

If the label attribute is omitted, the platform generates a title-cased version of the icon name (e.g. `add` → "Add"). Use the label attribute when the generated title differs from what appears in the UI tooltip.

**Examples:**

```markdown
Click the :icon[add] button to add a new entry.

Select :icon[filter]{label="Filter"} in the toolbar to narrow the results.
```

**Build-time validation:** An unknown icon name is a build error. If you mistype a name, the build log will suggest the closest valid icon.

---

## `:ui` — UI labels

Use `:ui` for the exact text of a UI element the reader must interact with — button labels, field names, tab names, link text.

**Syntax:** `:ui[Label Text]` or `:ui[Label Text]{type=button|field|tab|link}`

The `type` attribute is optional but recommended. It adds a visual modifier class so buttons look slightly different from field labels.

| Type | Use for |
|------|---------|
| `button` | Clickable buttons |
| `field` | Form fields, input areas |
| `tab` | Tab strip items |
| `link` | Hyperlinks and navigation anchors |

**Examples:**

```markdown
Click :ui[Save]{type=button} to store your changes.

Enter a description in the :ui[Short Description]{type=field} field.

Switch to the :ui[Advanced]{type=tab} tab.
```

**Migration:** If you currently write `click **Save**`, replace it with `:ui[Save]{type=button}`. The lint tool will suggest this automatically.

---

## `:ask` — Ask Joule

Use `:ask` to embed an "Ask Joule" button inline with tutorial prose. When the reader clicks it, Joule opens pre-filled with your prompt so they can explore the concept without leaving the tutorial.

**Syntax:** `:ask[Your prompt text here]`

**Constraints:**
- Prompt text must be ≤ 300 characters.
- The button is hidden on the QA preview channel and in preview mode (it only appears in the live published tutorial).
- The button is hidden until Joule is available for that reader's session; if Joule is not enabled, the button is removed from the DOM entirely.

**Examples:**

```markdown
:ask[What is the difference between a CDS view and a CDS view entity?]

:ask[Explain how CAP handles authentication with @requires annotations]
```

Keep prompts concise and directly related to the surrounding prose. A good prompt completes the thought "I want Joule to explain..." — it should be something the reader could not answer just by re-reading the current step.

---

## Migration hints

The lint tool emits `notice`-level findings for these patterns:

| Old pattern | Suggested replacement |
|-------------|----------------------|
| `click **Save**` | `:ui[Save]{type=button}` |
| `Ctrl+S`, `Cmd+S`, `Alt+F4` (bare shortcut text) | `:kbd[Mod+S]` (or the appropriate keys) |

These are advisory only — the build does not fail on them. They appear in the lint report at the end of a build run.

---

## Accessibility notes

- `:menu` segments are wrapped in a `role="text"` span with a full `aria-label` that reads the path with "then" between segments.
- `:kbd` elements have an `aria-label` that spells out symbol names in English (e.g. `⌘⇧P` → "Command Shift P").
- `:icon` elements use `accessible-name` from the `label` attribute or the generated title-case name.
- `:ask` buttons carry `aria-label="Ask Joule"`.
- `:ui` elements are styled text only; they do not add ARIA roles.
