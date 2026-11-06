## Why

Screenshots and diagrams carry much of a tutorial's meaning, but authors have few tools: block images can take `{width caption}` attributes (render-image.html), but inline images can't be sized, several images can't be grouped into one captioned figure, UI changes can't be shown side by side, and readers must match "click the button in the top right" to a busy screenshot. Terminal sessions are shown as videos (heavy, not copyable) or screenshots (not copyable). Architecture diagrams are pasted as PNGs that are illegible in dark mode and can't be zoomed. Large reference tables (service plans, parameters) can't be sorted or filtered.

## What Changes

- **Figures**: `:::figure[Caption]{width=60% align=center}` containing one or more images (grid layout for several) with a numbered, linkable caption ("Figure 3"). Inline images get sizing via the `:image[alt]{src=… width=…}` directive, because Goldmark emits `{…}` after inline images as literal text. Existing standalone block-image attributes (`{width height caption}`) keep working.
- **Before/after compare**: `::compare{before="old.png" after="new.png" labels="Before|After"}` slider with keyboard control.
- **Image hotspots**: a standalone image with `{hotspots="1:12%,8% 2:70%,40%"}` places numbered markers on the image that are linked to the following ordered list (marker N ↔ list item N); hovering/focusing either highlights the other.
- **Terminal recordings**: `::cast[setup.cast]{rows=20 speed=1.5 poster=0:05}` embeds an asciinema-compatible player; text is selectable/copyable; lazy-loaded.
- **Diagram embeds**: `::diagram[arch.drawio.svg]{alt="…"}` (SVG, draw.io SVG, Excalidraw SVG) with zoom/pan in the existing lightbox and dark-mode adaptation; mermaid stays as-is.
- **Sortable/filterable tables**: a `{.sortable}` and/or `{.filterable}` attribute line after a markdown table (Goldmark table attributes) enables column sorting, a filter box and sticky headers.

## Capabilities

### New Capabilities
- `tutorial-rich-media-and-tables`: figures, compare slider, image hotspots, terminal recordings, diagram embeds, and interactive tables.

### Modified Capabilities
<!-- none -->

## Impact

- Directive registrations (`figure`, `image`, `compare`, `cast`, `diagram`) on `tutorial-directive-grammar`; shortcodes `tut-figure`, `tut-compare`, `tut-cast`, `tut-diagram`.
- `render-image.html` (hotspots), `images.ts` / `attachment-links.ts` (resolve relative `.cast`/`.svg` sources to raw GitHub URLs, image-CDN routing), `image-dimensions.ts` (dims for new sources).
- `hugo/assets/js/lightbox.ts` (diagram zoom/pan), new `compare.ts`, `hotspots.ts`, `table-enhance.ts`; asciinema-player as a lazily loaded vendor bundle (new dependency, Apache-2.0).
- Security: SVG served through the existing image proxy with `Content-Type: image/svg+xml` and rendered via `<img>` (no inline SVG script execution); `.cast` files fetched as data, never executed.
