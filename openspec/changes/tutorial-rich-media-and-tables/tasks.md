## 1. Shared media plumbing

- [ ] 1.1 Extract a shared relative-source resolver from `images.ts`/`attachment-links.ts` for directive `src` attributes (`.png/.svg/.cast`)
- [ ] 1.2 Extend `image-dimensions.ts` to cover directive-referenced images
- [ ] 1.3 Image proxy: serve SVG with `script-src 'none'` CSP; allow `.cast` via attachment route

## 2. Figures and inline images

- [ ] 2.1 Register `figure` container and `image` inline directives; per-tutorial figure numbering and anchors
- [ ] 2.2 `tut-figure.html` (grid, caption, gallery grouping in lightbox) and `tut-image.html` reusing the render-image partial logic

## 3. Compare and hotspots

- [ ] 3.1 Register `compare`; `tut-compare.html` + `compare.ts` (range input, clip-path, no-JS side-by-side); aspect-ratio lint
- [ ] 3.2 `hotspots` attribute in `render-image.html`; parser validation of following ordered list; `hotspots.ts` bidirectional highlight

## 4. Recordings and diagrams

- [ ] 4.1 Vendor asciinema-player (license check, REUSE.toml), lazy-load bundle
- [ ] 4.2 Register `cast`; build-time asciicast validation, poster frame and transcript extraction; `tut-cast.html`
- [ ] 4.3 Register `diagram`; `tut-diagram.html` with `src-dark`/`theme`; extend `lightbox.ts` with SVG zoom/pan

## 5. Tables

- [ ] 5.1 `table-enhance.ts` for `.sortable`/`.filterable`/`.sticky` (aria-sort, locale/numeric sort, filter)
- [ ] 5.2 CSS for all media/table features (light/dark, print)

## 6. Fallbacks, docs, tests

- [ ] 6.1 Plain-text fallbacks (figure captions, compare as two images, cast transcript, diagram alt)
- [ ] 6.2 Author docs §3.4 Images expansion + cookbook examples
- [ ] 6.3 Unit tests and e2e specs (compare keyboard, hotspot highlight, table sort/filter, cast lazy-load)
