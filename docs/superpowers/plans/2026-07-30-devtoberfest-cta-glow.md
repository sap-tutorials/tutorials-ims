# Devtoberfest CTA Joule Glow — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restyle the Devtoberfest "Join the Fest!" button as a glowing Joule aurora-gradient pill with an energetic pulsing ring so it clearly reads as the primary CTA.

**Architecture:** CSS-only change to the `.dtf-cta` rule block in the Devtoberfest Vue island's plain stylesheet. Reuse Joule brand colors (declared as self-contained local custom properties) and a `box-shadow` pulse keyframe. No markup or logic changes.

**Tech Stack:** Vue 3 island bundled by Vite, plain CSS (`styles.css` imported in `main.ts`), Hugo static site host.

## Global Constraints

- Only edit `hugo-apps/src/devtoberfest/styles.css`. No changes to `DevtoberfestHome.vue`, layout, or the hero image.
- Joule brand colors (verbatim): pill gradient `#5D36FF` → `#7B42F0` → `#A100C2`; mesh accents `#8000dc`, `#afd8ff`, `#f1acff`; glow rgb `123, 66, 240` (= `#7B42F0`).
- Registered green (verbatim, existing): `#1ea672`.
- Do NOT depend on the global `hugo/static/css/joule.css` being loaded on this route — declare needed color tokens locally on `.dtf-cta`.
- Motion must be disabled under `@media (prefers-reduced-motion: reduce)`, leaving a static glow.
- Preserve existing `:focus-visible` outline and `:disabled` opacity/cursor behavior.
- Pulse intensity: "energetic" = ~1.6s loop, ring travel to ~18px.

---

### Task 1: Restyle `.dtf-cta` as a pulsing Joule glow pill

**Files:**
- Modify: `hugo-apps/src/devtoberfest/styles.css:149-182`

**Interfaces:**
- Consumes: existing markup `<button class="dtf-cta">` inside `.dtf-cta-wrap`, and the state hook `.dtf-home[data-state="registered"] .dtf-cta` (already present at line 179).
- Produces: no new selectors consumed elsewhere; purely visual.

- [ ] **Step 1: Replace the `.dtf-cta` base rule (lines 149-162)**

Replace the existing block:

```css
.dtf-cta {
  appearance: none;
  border: 0;
  background: #fff;
  color: #0a4ea8;
  font-weight: 600;
  font-size: 1rem;
  line-height: 1.2;
  padding: 0.7rem 1.4rem;
  border-radius: 999px;
  cursor: pointer;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.18);
  transition: transform 120ms ease, box-shadow 120ms ease, background-color 120ms ease;
}
```

with:

```css
.dtf-cta {
  /* Self-contained Joule tokens (do not rely on global joule.css). */
  --dtf-joule-1: #5D36FF;
  --dtf-joule-2: #7B42F0;
  --dtf-joule-3: #A100C2;
  --dtf-joule-glow: 123, 66, 240; /* rgb of #7B42F0 */

  appearance: none;
  position: relative;
  border: 0;
  color: #fff;
  background:
    radial-gradient(ellipse at 0% 130%,  #8000dc, transparent 50%),
    radial-gradient(ellipse at 100% 130%, #afd8ff, transparent 50%),
    radial-gradient(ellipse at 50% 0%,    #f1acff, transparent 60%),
    linear-gradient(165deg, var(--dtf-joule-1) 0%, var(--dtf-joule-2) 45%, var(--dtf-joule-3) 100%);
  background-blend-mode: screen, screen, screen, normal;
  font-weight: 700;
  font-size: 1.05rem;
  line-height: 1.2;
  padding: 0.85rem 1.8rem;
  border-radius: 999px;
  cursor: pointer;
  box-shadow: 0 6px 18px rgba(var(--dtf-joule-glow), 0.45),
              0 0 0 1px rgba(255, 255, 255, 0.12);
  animation: ctaPulseJoule 1.6s ease-out infinite;
  transition: transform 120ms ease, box-shadow 120ms ease, background-color 120ms ease;
}
```

- [ ] **Step 2: Update the `:hover` rule (lines 164-167)**

Replace:

```css
.dtf-cta:hover:not(:disabled) {
  transform: translateY(-1px);
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.22);
}
```

with (intensified purple glow on hover):

```css
.dtf-cta:hover:not(:disabled) {
  transform: translateY(-1px);
  box-shadow: 0 10px 24px rgba(var(--dtf-joule-glow), 0.6),
              0 0 0 1px rgba(255, 255, 255, 0.18);
}
```

- [ ] **Step 3: Leave `:focus-visible` (lines 169-172) unchanged**

Confirm this block still reads (keyboard accessibility — do not remove):

```css
.dtf-cta:focus-visible {
  outline: 2px solid #fff;
  outline-offset: 2px;
}
```

- [ ] **Step 4: Update the `:disabled` rule (lines 174-177) to stop the pulse**

Replace:

```css
.dtf-cta:disabled {
  cursor: default;
  opacity: 0.7;
}
```

with:

```css
.dtf-cta:disabled {
  cursor: default;
  opacity: 0.7;
  animation: none;
}
```

- [ ] **Step 5: Update the registered-state rule (lines 179-182) — green glow, no pulse**

Replace:

```css
.dtf-home[data-state="registered"] .dtf-cta {
  background: #1ea672;
  color: #fff;
}
```

with:

```css
.dtf-home[data-state="registered"] .dtf-cta {
  background: #1ea672;
  color: #fff;
  box-shadow: 0 6px 18px rgba(30, 166, 114, 0.45),
              0 0 0 1px rgba(255, 255, 255, 0.12);
  animation: none;
}
```

- [ ] **Step 6: Add the pulse keyframe and reduced-motion guard**

Immediately after the registered-state rule (before the `.dtf-cta-hint` rule at line 184), add:

```css
@keyframes ctaPulseJoule {
  0%   { box-shadow: 0 6px 18px rgba(var(--dtf-joule-glow), 0.45),
                     0 0 0 0    rgba(var(--dtf-joule-glow), 0.55); }
  70%  { box-shadow: 0 6px 18px rgba(var(--dtf-joule-glow), 0.45),
                     0 0 0 18px rgba(var(--dtf-joule-glow), 0); }
  100% { box-shadow: 0 6px 18px rgba(var(--dtf-joule-glow), 0.45),
                     0 0 0 0    rgba(var(--dtf-joule-glow), 0); }
}

@media (prefers-reduced-motion: reduce) {
  .dtf-cta { animation: none; }
}
```

- [ ] **Step 7: Verify the build compiles**

Run (from repo root of the worktree):

```bash
cd hugo-apps && npx vite build 2>&1 | tail -20
```

Expected: build succeeds, `devtoberfest` entry emits without CSS errors. (If the full build is slow or has unrelated failures, at minimum confirm no error references `styles.css` / the `.dtf-cta` block.)

- [ ] **Step 8: Commit**

```bash
git add hugo-apps/src/devtoberfest/styles.css
git commit -m "feat(devtoberfest): make Join the Fest CTA a glowing Joule pill"
```

---

### Task 2: Visual verification of all states

**Files:** none (verification only).

- [ ] **Step 1: Serve or preview the built page and open in Playwright**

Load the Devtoberfest page (live URL, or a local Hugo/preview serve of the built bundle). Confirm visually:

- [ ] **Step 2: Unregistered state** — button is a purple Joule gradient pill with white bold text and a visible expanding purple pulse ring. It is the clear focal point of the hero (no longer a flat white chip).
- [ ] **Step 3: Reduced motion** — with `prefers-reduced-motion: reduce` emulated, the pulse stops but a static purple glow remains.
- [ ] **Step 4: Registered state** — with `.dtf-home[data-state="registered"]`, the button is green with a soft green glow and no pulse.
- [ ] **Step 5: Disabled state** — disabled button shows reduced opacity and no pulse.
- [ ] **Step 6: Focus** — keyboard-focusing the button shows the white outline.

Take a before/after screenshot for the PR description.

---

## Self-Review

**Spec coverage:**
- Pill gradient + white text → Task 1 Step 1 ✓
- Energetic pulse (~1.6s, 18px) → Task 1 Step 1 + Step 6 ✓
- Hover/focus/disabled → Task 1 Steps 2–4 ✓
- Registered green + green glow, no pulse → Task 1 Step 5 ✓
- Reduced-motion static fallback → Task 1 Step 6 ✓
- Self-contained tokens (no joule.css dependency) → Task 1 Step 1 ✓
- All success criteria → Task 2 verification steps ✓

**Placeholder scan:** No TBD/TODO; all CSS shown verbatim.

**Type/name consistency:** Keyframe name `ctaPulseJoule` and custom props `--dtf-joule-*` are used identically in the base rule, keyframe, and hover/registered rules. Line numbers reference the current `styles.css`.
