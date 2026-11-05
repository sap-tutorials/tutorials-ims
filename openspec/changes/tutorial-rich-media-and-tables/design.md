## Context

`render-image.html` already reads `{width height caption}` from Goldmark attributes on standalone images, looks up intrinsic dimensions from `site.Data.image_dimensions`, adds lightbox affordances (`lightbox.ts`, ui5-dialog, zoom, filmstrip) and routes `raw.githubusercontent.com` images through `/img-cdn/`. Inline images can't take attributes. `images.ts` rewrites relative image paths to raw GitHub URLs; `attachment-links.ts` does the same for attachment extensions. Mermaid is supported via a shortcode + `mermaid-bootstrap.ts`. Goldmark block attributes are enabled (`markup.goldmark.parser.attribute`), so a `{.sortable}` line after a table applies to the table.

## Goals / Non-Goals

**Goals:** media authors can produce from existing tools (screenshots, asciinema, draw.io), progressive enhancement, accessible alternatives for every interactive element, safe handling of SVG and recordings, lazy loading.

**Non-Goals:** video hosting changes (frontmatter `video:` stays), image editing/annotation tools, server-side table data.

## Decisions

### D1 — Figures
`:::figure[Caption]{width align columns}` container; body = images (and optionally a code fence/table). Auto-numbered per tutorial in source order ("Figure N"), with anchor `#figure-N` and optional `#id`. Captions accept inline markdown. Grid when >1 image (`columns` default = image count up to 3). Each image inside still uses the lightbox (grouped as a gallery). `:image[alt]{src width height}` inline directive renders through the same image partial as render-image so CDN routing and dims stay consistent. Relative `src` values are resolved by the same rules as `images.ts` (shared helper extracted).

### D2 — Compare slider
`::compare{before after labels}`; renders both images stacked with a `<input type="range">` overlay controlling a CSS clip-path — fully keyboard accessible, no library. Without JS: images shown side by side with labels. Both images must have identical intrinsic aspect ratio (lint warning otherwise, using image-dimensions data).

### D3 — Hotspots
Attribute on standalone images: `hotspots="N:x%,y% …"`. render-image emits positioned `<a class="hotspot" href="#hs-<img>-N" aria-label="Callout N">N</a>` markers. `hotspots.ts` binds marker N to the N-th item of the immediately following ordered list (parser validates the list exists and has ≥ max(N) items). Plain-text fallback: the list stands on its own; image alt text gets "(numbered callouts 1–N)".

### D4 — Terminal recordings
`::cast[file.cast]{rows cols speed poster idle-limit}` → `tut-cast` shortcode renders a poster `<pre>` (the frame at `poster` time, extracted at build) and lazy-loads asciinema-player (vendored, ~100 KB, loaded only on pages that use it, on interaction/visibility). Cast files resolved like attachments (raw GitHub URL → proxied). Build validation: file exists, is valid asciicast v2, ≤ 2 MB. Plain-text fallback: the final terminal text extracted at build (useful for MCP/AI and accessibility, linked as "Show transcript").

### D5 — Diagrams
`::diagram[file.svg]{alt caption}`; SVG served via image proxy and rendered with `<img>` (scripts inert). Dark mode: CSS `filter: invert(1) hue-rotate(180deg)` on diagrams flagged `{theme=auto}` (default for draw.io/Excalidraw exports with white background), `theme=none` to opt out; `src-dark=` lets authors supply a dark variant (preferred). Zoom/pan through lightbox (extend `lightbox.ts` with wheel/pinch zoom up to 4× for SVG). `alt` required (validation error) — diagrams carry meaning.

### D6 — Tables
`{.sortable}` / `{.filterable}` / `{.sticky}` on the line after a table (Goldmark block attribute). `table-enhance.ts` adds header buttons (`aria-sort`), a filter input (`aria-controls`), numeric/locale-aware sort. Tables without classes untouched. Plain-text fallback unaffected (still a markdown table). Lint warns if `.sortable` table has merged-looking/empty header cells.

## Risks / Trade-offs

- [Vendor bundle weight] → per-page lazy load; only cast pages pay.
- [SVG security] → `<img>` rendering only, never inline; proxy sets `Content-Security-Policy: script-src 'none'` on SVG responses.
- [Invert filter makes colourful diagrams wrong] → `src-dark` preferred; `theme=none` opt-out; docs guidance.
- [Hotspot positions drift when screenshot replaced] → percentages; lint can't detect, docs advise updating together.

## Migration Plan

Additive, no flags; each directive independently shippable. Rollback by reverting registration (directives then render as literal text — acceptable for an unreleased feature).

## Open Questions

- Should figure numbering reset per step ("Figure 3.2")? Proposed: per tutorial.
- Host-side `.cast` → GIF/MP4 fallback for email/print? Deferred.
