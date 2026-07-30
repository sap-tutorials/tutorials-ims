# Devtoberfest "Join the Fest!" — Joule Glow CTA

**Date:** 2026-07-30
**Status:** Approved (design)

## Problem

On the Devtoberfest home page (`/devtoberfest/`), the primary call-to-action
button "Join the Fest!" is a flat white pill sitting in the bottom-right corner
of the dark hero banner. Against the busy hero image (person, gem motifs,
gradient) it reads like a caption chip rather than *the* primary action. It
needs to stand out unmistakably as the primary CTA.

## Goal

Make "Join the Fest!" the clear focal point of the hero by restyling it in the
site's existing **Joule** visual language — an aurora-mesh gradient pill with an
energetic pulsing glow ring — while respecting accessibility and keeping the
existing registered / disabled behavior intact.

## Scope

- **In scope:** CSS-only changes to the `.dtf-cta` button styling.
- **Out of scope:** Markup/logic changes to `DevtoberfestHome.vue`, changes to
  the hero image or layout, changes to any other button on the site.

## Affected files

- `hugo-apps/src/devtoberfest/styles.css` — the `.dtf-cta` rule block
  (~lines 149–182) and a new `@keyframes` + `prefers-reduced-motion` block.

No changes to `DevtoberfestHome.vue` markup — it already renders
`<button class="dtf-cta">` inside `.dtf-cta-wrap`.

## Design

### Source of inspiration (existing Joule assets)

Reuse the Joule design tokens and effects already in the codebase:

- `hugo/static/css/joule.css` — aurora-mesh gradient and glowing `.joule-step-fab`
  pill. Brand colors: `#5D36FF`, `#7B42F0`, `#A100C2`; mesh accents `#8000dc`,
  `#afd8ff`, `#f1acff`.
- `hugo-apps/src/event-display/EventDisplay.vue` — the `cardPulseJoule`
  box-shadow pulse keyframe (purple expanding ring, `rgba(123,66,240,…)`).

Because the Devtoberfest island does not guarantee `joule.css` is loaded, the
required color values are declared as local custom properties scoped to the CTA
(self-contained; no dependency on the global Joule stylesheet).

### 1. The pill (unregistered / anonymous state)

Replace the flat white background with the Joule aurora-mesh gradient in white
bold text:

```css
.dtf-cta {
  /* self-contained Joule tokens */
  --dtf-joule-1: #5D36FF;
  --dtf-joule-2: #7B42F0;
  --dtf-joule-3: #A100C2;
  --dtf-joule-glow: 123, 66, 240; /* rgb of #7B42F0, for rgba() glow */

  position: relative;
  color: #fff;
  border: 0;
  background:
    radial-gradient(ellipse at 0% 130%,  #8000dc, transparent 50%),
    radial-gradient(ellipse at 100% 130%, #afd8ff, transparent 50%),
    radial-gradient(ellipse at 50% 0%,    #f1acff, transparent 60%),
    linear-gradient(165deg, var(--dtf-joule-1) 0%, var(--dtf-joule-2) 45%, var(--dtf-joule-3) 100%);
  background-blend-mode: screen, screen, screen, normal;
  font-weight: 700;
  font-size: 1.05rem;
  padding: 0.85rem 1.8rem;
  border-radius: 999px;
  cursor: pointer;
  /* resting glow */
  box-shadow: 0 6px 18px rgba(var(--dtf-joule-glow), 0.45),
              0 0 0 1px rgba(255, 255, 255, 0.12);
  /* energetic pulse */
  animation: ctaPulseJoule 1.6s ease-out infinite;
  transition: transform 120ms ease, box-shadow 120ms ease;
}
```

### 2. The pulse ("more energetic")

An expanding purple ring that loops continuously. "More energetic" = faster loop
(~1.6s) and a larger ring travel (up to ~18px) than the subtle baseline.

```css
@keyframes ctaPulseJoule {
  0%   { box-shadow: 0 6px 18px rgba(var(--dtf-joule-glow), 0.45),
                     0 0 0 0    rgba(var(--dtf-joule-glow), 0.55); }
  70%  { box-shadow: 0 6px 18px rgba(var(--dtf-joule-glow), 0.45),
                     0 0 0 18px rgba(var(--dtf-joule-glow), 0); }
  100% { box-shadow: 0 6px 18px rgba(var(--dtf-joule-glow), 0.45),
                     0 0 0 0    rgba(var(--dtf-joule-glow), 0); }
}
```

### 3. Hover / focus / disabled

- Hover: lift (`translateY(-1px)`) and intensify the resting glow.
- `:focus-visible`: keep a visible outline (white outline, 2px, offset 2px) for
  keyboard accessibility.
- `:disabled`: keep `opacity: 0.7`, `cursor: default`, and **stop the pulse**
  (`animation: none`).

### 4. Registered state

After the user has joined (`.dtf-home[data-state="registered"] .dtf-cta`):

- Keep the existing green (`#1ea672`) solid background and white text.
- Replace the aurora gradient (set `background: #1ea672`).
- Add a matching **soft green static glow**
  (`box-shadow: 0 6px 18px rgba(30, 166, 114, 0.45)`).
- **Stop the pulse** (`animation: none`). Rationale: the pulse is a "join now"
  nudge; once someone has joined, it should stop nagging.

### 5. Accessibility — reduced motion

Wrap the pulse so users who prefer reduced motion get a calm static glow instead
of a looping animation:

```css
@media (prefers-reduced-motion: reduce) {
  .dtf-cta { animation: none; }
}
```

The static resting glow (defined on `.dtf-cta`) remains, so the button still
stands out without motion.

## Success criteria

1. On the live hero, "Join the Fest!" is immediately the most prominent element
   — a glowing purple Joule pill, not a flat white chip.
2. The pulse animates continuously in the unregistered state and reads as
   energetic (fast, visible ring travel).
3. With `prefers-reduced-motion: reduce`, no animation runs but the button still
   has a clear static glow.
4. After joining, the button is green with a soft green glow and no pulse.
5. Disabled state shows no pulse and reduced opacity.
6. Keyboard focus shows a visible outline.
7. No regressions to layout, the hint text, or other page elements.

## Verification

- Visual check in Playwright against the live/local page: unregistered
  (pulsing), reduced-motion (static), registered (green, no pulse), disabled.
- Confirm the Vite build of `devtoberfest` entry still succeeds.
