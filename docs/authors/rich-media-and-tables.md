# Rich Media and Tables

Tutorial authors can use these directives and attributes to embed rich visual content and interactive tables. All features are additive — existing tutorial markdown continues to work without any changes.

---

## Overview — when to use each feature

| Feature | When to use |
|---------|-------------|
| [Figures](#figures) | Grouping related images together under a single auto-numbered caption |
| [Inline images](#inline-images) | Sized icons, badges, or small images inside a sentence |
| [Before/after compare](#beforeafter-compare) | Showing a UI change, a refactoring, or a before/after state side by side |
| [Hotspot images](#hotspot-images) | Annotating a screenshot with numbered callouts tied to a description list |
| [Terminal recordings](#terminal-recordings) | Demonstrating a CLI workflow with selectable, copyable terminal text |
| [Diagrams](#diagrams) | Embedding draw.io or Excalidraw SVG exports, with zoom and dark-mode support |
| [Interactive tables](#interactive-tables) | Large reference tables (service plans, parameters) that benefit from sorting or filtering |

---

## Figures

Use `:::figure[Caption]` to group one or more images under an auto-numbered, linkable caption ("Figure 1", "Figure 2", …). When a figure contains more than one image the images are displayed in a grid (up to three columns by default).

**Syntax:**

```markdown
:::figure[The SAP BTP Cockpit overview]{width=80% align=center}
![BTP Cockpit main screen](cockpit-main.png)
![BTP Cockpit subaccount detail](cockpit-subaccount.png)
:::
```

**Attributes:**

| Attribute | Default | Notes |
|-----------|---------|-------|
| `width` | `100%` | CSS width applied to the figure block |
| `align` | `left` | `left`, `center`, or `right` |
| `columns` | image count (max 3) | Force a specific grid column count |
| `id` | _(auto)_ | Override the anchor; default is `figure-N` |

**Captions** accept inline Markdown (bold, links, inline code). Figure numbers are assigned in source order across the whole tutorial.

Each image inside a figure still opens in the lightbox, and multiple images are grouped as a gallery.

---

## Inline Images

Standard Markdown inline image syntax (`![alt](src)`) does not support sizing attributes in most parsers, including Goldmark. Use the `:image[alt]{src=…}` inline directive to embed a sized inline image — for icons, badges, or small UI elements that appear mid-sentence.

**Syntax:**

```markdown
Click :image[settings icon]{src=gear.png width=16} to open the settings panel.
```

**Attributes:**

| Attribute | Notes |
|-----------|-------|
| `src` | Required. Relative path (resolved the same way as block images). |
| `width` | CSS width in px (unitless) or any CSS length (`16`, `2rem`, `24px`). |
| `height` | CSS height; omit to preserve aspect ratio. |

Relative `src` values are resolved to raw GitHub URLs by the same rules as block images — no extra configuration needed.

---

## Before/After Compare

Use `::compare{before=… after=…}` to render a drag-handle slider that reveals one image on the left and another on the right. Both images must have the same intrinsic dimensions (a lint warning is emitted if they differ).

**Syntax:**

```markdown
::compare{before=before-refactor.png after=after-refactor.png labels="Before refactoring|After refactoring"}
```

**Attributes:**

| Attribute | Notes |
|-----------|-------|
| `before` | Required. Path to the "before" image. |
| `after` | Required. Path to the "after" image. |
| `labels` | Optional. Pipe-separated label pair, e.g. `"Before|After"`. Defaults to none. |

**Accessibility:** the slider is keyboard-accessible (arrow keys move the divider). Without JavaScript, both images are shown side by side with their labels.

---

## Hotspot Images

Add a `{hotspots="N:x%,y% …"}` attribute to a standalone block image to overlay numbered circular markers at percentage-based positions. Each marker is linked to the corresponding item in the **immediately following ordered list** — hovering or focusing either the marker or the list item highlights the other.

**Syntax:**

```markdown
![System architecture diagram](architecture.png){hotspots="1:15%,30% 2:65%,45% 3:45%,75%"}

1. The **Application Router** handles authentication and routes requests.
2. The **CAP service** provides OData endpoints for the frontend.
3. The **SAP HANA Cloud** database persists business data.
```

**Hotspot coordinate format:** `N:x%,y%` where `N` is the marker number (1-based), `x%` is the horizontal position from the left, and `y%` is the vertical position from the top.

**Important constraints:**

- The ordered list **must immediately follow** the image — no blank lines, no other content between them.
- If the number of hotspot markers and the number of list items do not match, markers render but cross-highlighting is skipped. A lint rule for this mismatch is planned for a future release.
- When you replace a screenshot, update the `hotspots` coordinates — they are percentages tied to the image composition.

**Accessibility fallback:** the image `alt` text is automatically appended with "(numbered callouts 1–N)". The ordered list stands on its own and is always readable without JavaScript.

---

## Terminal Recordings

Use `::cast[file.cast]{…}` to embed an interactive asciinema terminal recording. Text is **selectable and copyable** by the reader. The player loads lazily (only pages that include a `::cast` directive load the player bundle, and even then only when the recording is visible or interacted with).

**Syntax:**

```markdown
::cast[deploy-demo.cast]{rows=24 cols=80 speed=1.2 poster="0:03"}
```

**Attributes:**

| Attribute | Default | Notes |
|-----------|---------|-------|
| `rows` | `24` | Player height in terminal rows |
| `cols` | `80` | Player width in terminal columns |
| `speed` | `1.0` | Playback speed multiplier (`1.5` = 50% faster) |
| `poster` | `"0:0"` | Time (mm:ss) of the frame shown before play |
| `idle-limit` | _(none)_ | Collapse gaps longer than this many seconds |

**Recording tools:** use `asciinema rec` or `agg` to produce `.cast` files (asciicast v2 format). The build validates that the file exists and is valid asciicast v2. **File size limit: 2 MB.**

**Accessibility fallback:** the final terminal text is extracted at build time and linked as "Show transcript", which is readable by screen readers and search indexers.

---

## Diagrams

Use `::diagram[file.svg]{alt="…"}` to embed an SVG diagram. The diagram opens in the lightbox with zoom/pan support. Dark-mode adaptation is applied automatically (CSS invert + hue-rotate) for diagrams that have a white background, which covers most draw.io and Excalidraw exports.

**Syntax:**

```markdown
::diagram[cap-architecture.svg]{alt="CAP application architecture showing the three-tier structure" caption="CAP three-tier architecture"}
```

**Attributes:**

| Attribute | Required | Notes |
|-----------|----------|-------|
| `alt` | **Yes** | Accessible description; the build **fails** if `alt` is missing |
| `caption` | No | Visible caption below the diagram |
| `src-dark` | No | Path to a dark-mode variant (preferred over the auto-invert filter for colourful diagrams) |
| `theme` | `auto` | `auto` = apply CSS invert for white-background SVGs; `none` = no dark-mode adaptation |

**Recommended source formats:** draw.io SVG (export as SVG from draw.io), Excalidraw SVG. Plain SVG is also accepted.

**SVG security:** SVGs are served through the image proxy with `Content-Type: image/svg+xml` and rendered via `<img>` (scripts are never executed). Do not attempt to embed SVGs with `<script>` tags — they will not run, and the proxy sets `Content-Security-Policy: script-src 'none'` on SVG responses.

**Dark-mode tip:** if your diagram has colourful fills, the auto-invert filter can make colours look wrong. Preferred approach: export a separate dark-mode version and pass it as `src-dark=dark-variant.svg`.

---

## Interactive Tables

Add one or more CSS class attributes after a Markdown table to enable sorting, filtering, and sticky headers. Tables without these classes are rendered exactly as before.

**Syntax:**

```markdown
| Feature | Free Tier | Standard | Premium |
|---------|-----------|----------|---------|
| Users | 10 | 100 | Unlimited |
| Storage (GB) | 5 | 50 | 500 |
| Support | Community | Email | 24/7 |
{.sortable .filterable}
```

**Available classes:**

| Class | Behaviour |
|-------|-----------|
| `.sortable` | Adds clickable sort buttons to each column header. Sort is locale-aware and numeric-aware. |
| `.filterable` | Adds a text input above the table that filters all rows as the reader types. |
| `.sticky` | Makes the header row stick to the top of the viewport when scrolling through a long table. |

Classes can be combined: `{.sortable .filterable .sticky}`.

**Limitations:**

- No merged header cells (colspan/rowspan) — sorting and filtering assume a single-row header.
- No multi-column sort.
- The filter input matches any column; per-column filtering is not supported.
- A lint warning is emitted if `.sortable` is applied to a table with empty or ambiguous header cells.

**Accessibility:** sort state is communicated via `aria-sort` on column headers; the filter input has `aria-controls` pointing to the table. Without JavaScript the table renders as a plain static Markdown table — fully readable.
