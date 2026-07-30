# Devtoberfest Joule × Retro-Arcade Pass

**Date:** 2026-07-30
**Status:** Approved (design)

## Problem / Goal

The Devtoberfest home page (`/devtoberfest/`) now has a glowing Joule primary
CTA in the hero, but two gaps remain:

1. A user reading the body copy "Click **Join the Fest** to accept the terms and
   start playing." has no button next to that instruction — the only button is
   up in the hero, which may be scrolled away.
2. The page mixes a retro-arcade motif (CRT scanlines, a `READY_PLAYER_1 /
   INSERT_COIN` monospace strip) with a Joule purple CTA, but the hero itself
   still uses the older Horizon blue→violet gradient, so the theme reads as
   half-committed.

**Goal:** Add a second, in-sync "Join the Fest" button below the welcome
sentence, and unify the page around a Joule-purple + retro-arcade neon
aesthetic — reusing assets already in the repo, CSS-only except the one new
button element, and fully reduced-motion safe.

## Scope

- **In scope:**
  - One new `<button class="dtf-cta dtf-cta-body">` in the body, reusing the
    existing handler/label/disabled logic.
  - CSS for: the body-button light-background variant, neon arcade strip +
    blink, true-Joule hero gradient + aurora glow, mascot bob, neon rail hover.
- **Out of scope:** Changing button click logic, the terms dialog, event data,
  copy text, dark-mode-specific redesign beyond keeping it functional, the
  Sapphire theme variant.

## Affected files

- `hugo-apps/src/devtoberfest/DevtoberfestHome.vue` — insert the body CTA button
  after the `unregistered`-state welcome sentence (~line 225), inside
  `.dtf-content`.
- `hugo-apps/src/devtoberfest/styles.css` — all new/updated CSS.

## Existing assets reused (no new palette)

- Joule tokens: purple `#5D36FF` / `#7B42F0` / `#A100C2`; mesh `#8000dc`,
  `#afd8ff`, `#f1acff`; glow rgb `123, 66, 240`.
- Existing CRT scanline overlay: `.dtf-header::before` (`styles.css:35-50`).
- Existing arcade strip: `.dtf-arcade-strip` / `.dtf-arcade-chunk`
  (`styles.css:229-247`), markup `DevtoberfestHome.vue:207-211`.
- Existing pulse keyframe `ctaPulseJoule` (`styles.css:203-210`).
- Blink cadence mirrors Joule's `jouleBlink`; bob mirrors `jouleBob`
  (`hugo/static/css/joule.css`). Because the Devtoberfest island does not load
  `joule.css`, equivalent keyframes are declared locally in `styles.css`.
- Brand accent colors for rail: Devtoberfest orange `#ff6b35`, TechEd navy
  `#003b71` (from `hugo/static/images/devtoberfest/*.svg`).

## Design

### 1. Cloned body CTA

Insert, directly after the `unregistered` welcome `<p class="dtf-msg">` and
inside `.dtf-content`:

```html
<div v-if="state === 'unregistered'" class="dtf-cta-body-wrap">
  <button
    type="button"
    class="dtf-cta dtf-cta-body"
    :disabled="ctaDisabled"
    @click="onCtaClick"
  >
    {{ ctaLabel }}
  </button>
</div>
```

- Reuses `onCtaClick`, `ctaLabel`, `ctaDisabled` — no new script. It stays in
  sync with the header button automatically.
- Gated on `state === 'unregistered'` so it appears exactly when the "Click Join
  the Fest…" sentence appears (that sentence is itself `unregistered`-only).
- Inherits `.dtf-cta` (purple pill + pulse). The `.dtf-cta-body` modifier adapts
  it to the light `.dtf-content` background:

```css
.dtf-cta-body-wrap {
  display: flex;
  justify-content: flex-start;
  margin-top: 0.25rem;
}

/* Light-background variant: drop the white inset ring, fix the focus color. */
.dtf-cta-body {
  box-shadow: 0 6px 18px rgba(var(--dtf-joule-glow), 0.45);
}
.dtf-cta-body:focus-visible {
  outline: 2px solid var(--dtf-joule-1);
  outline-offset: 2px;
}
```

The pulse still animates (it inherits `.dtf-cta`), and it stops in the
registered/disabled/reduced-motion cases via the existing rules. Because
`--dtf-joule-*` custom properties are declared on `.dtf-cta`, they are available
to `.dtf-cta-body` rules.

### 2. Neon arcade strip + blink

```css
.dtf-arcade-strip {
  color: #A100C2;
  text-shadow: 0 0 6px rgba(161, 0, 194, 0.7), 0 0 12px rgba(123, 66, 240, 0.5);
  border-top-color: rgba(123, 66, 240, 0.5);
  border-bottom-color: rgba(123, 66, 240, 0.5);
}

@keyframes dtfArcadeBlink {
  0%, 80%, 100% { opacity: 0.3; }
  40%           { opacity: 1; }
}
/* Blink the INSERT_COIN chunk (always the last chunk). */
.dtf-arcade-chunk:last-child {
  animation: dtfArcadeBlink 1.2s infinite ease-in-out;
}
```

Note: keep the existing `color` fallback token behavior in mind — this overrides
the muted gray with neon purple. The `text-shadow` values reuse the Joule
purples.

### 3. True-Joule hero + aurora glow

Replace the hero's Horizon gradient (`styles.css:29`, currently
`linear-gradient(135deg, #0070f2 0%, #7858ff 100%)`) with true Joule purple, and
add a drifting aurora glow layer behind the brand content, beneath the existing
scanline overlay:

```css
.dtf-header {
  background: linear-gradient(165deg, #5D36FF 0%, #7B42F0 45%, #A100C2 100%);
}

/* Aurora glow — sits above the base gradient, below content (z-index:1). */
.dtf-header::after {
  content: "";
  position: absolute;
  inset: 0;
  z-index: 0;
  pointer-events: none;
  background:
    radial-gradient(ellipse at 15% 120%, rgba(128, 0, 220, 0.55), transparent 55%),
    radial-gradient(ellipse at 85% -10%, rgba(241, 172, 255, 0.35), transparent 55%),
    radial-gradient(ellipse at 55% 60%,  rgba(175, 216, 255, 0.25), transparent 60%);
  filter: blur(30px);
  opacity: 0.9;
  animation: dtfHeroAurora 14s ease-in-out infinite alternate;
}

@keyframes dtfHeroAurora {
  from { transform: translate3d(-3%, 0, 0) scale(1.05); }
  to   { transform: translate3d(3%, -2%, 0) scale(1.15); }
}
```

Constraints:
- `.dtf-header` is already `position: relative` and its children (`.dtf-brand`,
  `.dtf-cta-wrap`) are `z-index: 1`, so the `::after` at `z-index: 0` sits behind
  them. The existing `::before` scanline overlay is `z-index: 0` too; both are
  decorative and `pointer-events: none`. Verify the scanlines still read over the
  aurora (they use `mix-blend-mode: overlay`).
- The image-banner variant is `.dtf-header[data-has-banner="true"]`
  (`styles.css:53-58`), which already sets `background: none` and hides
  `::before`. Add `.dtf-header[data-has-banner="true"]::after { display: none; }`
  so the aurora never covers the photo, exactly mirroring line 58.

### 4. Mascot bob

```css
@keyframes dtfBob {
  0%, 100% { transform: translateY(0); }
  50%      { transform: translateY(-10px); }
}
.dtf-kasimir {
  animation: dtfBob 3s ease-in-out infinite;
}
```

(Confirm `.dtf-kasimir` is the mascot selector, `styles.css:~286`.)

### 5. Neon rail hover

The rail items (`.dtf-rail-item`, `styles.css:301-325`) already carry per-item
accent colors via `--rail-color` nth-child rules (lines 317-320, currently
Horizon colors `#0070f2` / `#7858ff` / `#1ea672` / `#f5a623`) and already have a
`transition` (line 314) and a `:hover` rule (lines 322-324). **Modify** the
existing `:hover` (do not add a duplicate) to add the purple glow, and add
`box-shadow` to the existing `transition` list:

```css
/* Existing line 314 transition gains box-shadow (it lacks it today). */
.dtf-rail-item {
  transition: transform 120ms ease, box-shadow 120ms ease, border-color 120ms ease;
}
/* Replace the existing :hover (lines 322-324). */
.dtf-rail-item:hover {
  transform: translateX(2px);
  box-shadow: 0 0 0 1px rgba(123, 66, 240, 0.5), 0 6px 16px rgba(123, 66, 240, 0.35);
}
```

Optionally re-map the four `--rail-color` nth-child accents (lines 317-320) to a
neon set (Joule purple `#5D36FF`, Joule magenta `#A100C2`, Devtoberfest orange
`#ff6b35`, TechEd navy `#003b71`) if the current Horizon accents look muted next
to the new purple hero — decide during implementation by eye; the glow-on-hover
is the required part.

### 6. Reduced motion

Extend the existing `@media (prefers-reduced-motion: reduce)` block so all new
animations stop, leaving static styling:

```css
@media (prefers-reduced-motion: reduce) {
  .dtf-cta,
  .dtf-arcade-chunk:last-child,
  .dtf-header::after,
  .dtf-kasimir {
    animation: none;
  }
}
```

## Success criteria

1. In the `unregistered` state, a purple Joule "Join the Fest" pill appears
   directly below the welcome sentence, left-aligned, pulsing, with a
   purple-not-white focus outline. It opens the same terms dialog as the header
   button.
2. The body button disappears / is not shown in registered, anonymous, loading,
   event-missing, and error states (matching the sentence's own visibility).
3. The arcade strip text glows neon purple and `INSERT_COIN` blinks.
4. The hero is Joule purple with a gently drifting aurora glow; the CRT
   scanlines still read; the image-banner header variant shows NO aurora over
   the photo.
5. Kasimir bobs gently.
6. Rail items glow purple on hover.
7. With `prefers-reduced-motion: reduce`, no animations run but all elements
   remain legible and styled.
8. No layout regressions; no console errors; dark mode remains functional.

## Verification

- Visual check in Playwright against the deployed page (inject final CSS + clone
  the button) for: unregistered (body button pulsing), reduced motion,
  registered (no body button), rail hover glow, arcade blink, hero aurora.
- Confirm CSS parses (esbuild) and, if practical, the Vite `devtoberfest` build
  succeeds.
