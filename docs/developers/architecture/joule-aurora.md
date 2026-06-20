# Joule Aurora Background

> Issue [#392](https://github.com/sap-tutorials/tutorials-ims/issues/392) — port the new Joule background animation from the production Joule Web Client (`com.sap.das.webclient v1.37.0`) into our `#joule-panel` so both the public Hugo tutorial site and the admin-shell present the same updated visual.

For the runtime side of Joule (chat panel state, ChatService, RAG, embeddings, tool calls), see [Joule Architecture](joule.md). This page covers only the visual.

## What it is

Four absolutely-positioned, blurred radial-gradient `<div>`s anchored to the bottom of `#joule-panel`'s hero (and header strip), each slowly translating horizontally on long-period keyframes. The Joule logo "bobs" up-down 2s while the panel is idle. Together they read as an aurora-style purple wash blooming up from the panel base.

The animation is 100% CSS — no canvas, no WebGL, no video, no extra HTTP requests.

## Where it lives

| Surface | Element | Source file |
| --- | --- | --- |
| Public site | `#joule-panel` | [`hugo/layouts/partials/joule-panel.html`](../../../hugo/layouts/partials/joule-panel.html) |
| Public site | `#joule-step-fab` (FAB) | [`hugo/layouts/partials/joule-step-help.html`](../../../hugo/layouts/partials/joule-step-help.html) |
| Admin shell | `#joule-panel` | [`app/admin-shell/webapp/index.html`](../../../app/admin-shell/webapp/index.html) |
| **All surfaces** | CSS | [`hugo/static/css/joule.css`](../../../hugo/static/css/joule.css) |

The CSS file is the **single source of truth**. At `mbt build` time, `hugo/public/css/joule.css` is copied into `approuter/static/css/joule.css`, and the admin-shell's `index.html` links to `/css/joule.css` directly — both surfaces resolve the same file at runtime.

The HTML inlines (Hugo partial vs. admin-shell `index.html`) are **hand-mirrored** — the admin-shell is plain HTML, not Hugo, so there's no template engine sharing the markup. They have drifted before, which is why the smoke test [`test/smoke/joule-aurora.test.js`](../../../test/smoke/joule-aurora.test.js) asserts that both surfaces ship the same four `.joule-aurora__layer` divs in their `__hero` and `__header` blocks.

## Markup

```html
<section class="joule-panel__hero">
  <div class="joule-aurora" aria-hidden="true">
    <div class="joule-aurora__layer joule-aurora__layer--a"></div>
    <div class="joule-aurora__layer joule-aurora__layer--b"></div>
    <div class="joule-aurora__layer joule-aurora__layer--c"></div>
    <div class="joule-aurora__layer joule-aurora__layer--d"></div>
  </div>
  <div class="joule-panel__hero-content">
    <!-- the existing logo, greeting, and starter prompts -->
  </div>
</section>
```

The same shape goes inside `.joule-panel__header`. The aurora wrapper is `position: absolute; inset: 0; pointer-events: none; z-index: 0;` so it covers the surface without intercepting clicks; the content wrapper sits at `z-index: 1`.

## Tokens

Existing Joule purples were already exact prod aurora matches, so the palette adds only four new tokens:

```css
--joule-purple-1: #5D36FF;   /* mesh-d1 (reused) */
--joule-purple-3: #A100C2;   /* mesh-c2 (reused) */
--joule-mesh-a:   #8000dc;
--joule-mesh-b:   #afd8ff;
--joule-mesh-c1:  #f1acff;
--joule-mesh-d2:  #cfc3ff;
```

To retune the palette, override these tokens at `:root` (or scoped to `#joule-panel`) — the four `.joule-aurora__layer--*` rules read them via `var(...)`.

## Animation

Four keyframes (`jouleFloatA/B/C/D`, periods 12-16s, all `ease-in-out infinite`) translate the layers horizontally with a slight scale ramp. The logo bobs on a 2s cycle (`jouleBob`). Layers paint at 0.18-0.5 opacity with a `filter: blur(50px)` so individual ellipses smear into a single soft wash. Long staggered periods avoid a visible "pulse" sync.

## Adding aurora to a new surface

1. Ensure the surface's outermost element has `position: relative; overflow: hidden;`.
2. Insert a `.joule-aurora` wrapper with four `.joule-aurora__layer--{a,b,c,d}` divs as the first child.
3. Wrap the surface's existing children in a `position: relative; z-index: 1;` content container so they paint above the layers.
4. Add a smoke assertion that the surface ships four mesh layers (mirror the pattern at [`test/smoke/joule-aurora.test.js`](../../../test/smoke/joule-aurora.test.js)).

## What this does NOT do

- No theme-aware dark variant. Production's `_dark` branch swaps only `--joule-bg` (to `#1d2d3e`) — our panel chrome is already dark for both site themes, so no need.
- No high-contrast `_hcb`/`_hcw` variants — we don't ship HC themes.
- No Sapphire/Quartz `--sapAssistant_Color1/2` integration — we don't ship those event themes via Joule.
- No JS — no `.fade-out` opacity transition or `bobSettle` snap; we hide the hero with `[hidden]` like the rest of the panel.

If any of those become necessary, the production reference can be extracted again from the live bootstrap.js at `https://sapit-home-prod-004.eu10.sapdas.cloud.sap/resources/public/webclient/bootstrap.js` (search for `getInnerHtml` and `mesh-layer`).

## Reduced motion

`@media (prefers-reduced-motion: reduce)` halts every aurora animation and the logo bob. The static linear-gradients on `.joule-panel__header` and `.joule-step-fab` remain as the visual fallback so neither surface goes blank — only the hero falls back to a solid `var(--joule-chrome)` background, which is the same color used elsewhere in the panel chrome.
