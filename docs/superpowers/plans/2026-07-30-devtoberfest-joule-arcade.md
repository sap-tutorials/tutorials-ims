# Devtoberfest Joule × Retro-Arcade — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a second in-sync "Join the Fest" CTA below the welcome sentence and unify the Devtoberfest page around a Joule-purple + retro-arcade neon look, reusing repo assets.

**Architecture:** One new `<button>` in `DevtoberfestHome.vue` reusing existing handler/label/disabled logic, plus CSS-only effects in `styles.css`: light-bg button variant, neon arcade strip + blink, true-Joule hero gradient + aurora, mascot bob, neon rail hover. All motion reduced-motion guarded.

**Tech Stack:** Vue 3 island (Vite), plain CSS imported in `main.ts`, Hugo host.

## Global Constraints

- Edit only `hugo-apps/src/devtoberfest/DevtoberfestHome.vue` and `hugo-apps/src/devtoberfest/styles.css`.
- Reuse Joule colors verbatim: `#5D36FF`, `#7B42F0`, `#A100C2`; mesh `#8000dc`, `#afd8ff`, `#f1acff`; glow rgb `123, 66, 240`. Brand accents: Devtoberfest orange `#ff6b35`, TechEd navy `#003b71`.
- Do NOT change button click logic, copy text, the terms dialog, or event data.
- The body CTA reuses `onCtaClick` / `ctaLabel` / `ctaDisabled` — no new script.
- Aurora must NOT render on the image-banner header (`.dtf-header[data-has-banner="true"]`).
- Modify the EXISTING `.dtf-rail-item:hover` (styles.css:322-324) — do not add a duplicate.
- All new keyframes are `dtf`-prefixed and declared locally in `styles.css` (the island does not load `joule.css`).
- Every new animation must be disabled under `@media (prefers-reduced-motion: reduce)`.

---

### Task 1: Add the cloned body CTA (markup + light-bg CSS)

**Files:**
- Modify: `hugo-apps/src/devtoberfest/DevtoberfestHome.vue` (after the `unregistered` welcome `<p class="dtf-msg">`, ~line 225)
- Modify: `hugo-apps/src/devtoberfest/styles.css` (add rules after the `ctaPulseJoule` / reduced-motion block, ~line 214)

**Interfaces:**
- Consumes: existing `onCtaClick()`, `ctaLabel` computed, `ctaDisabled` computed, `state` ref, and the `.dtf-cta` rule block (which declares `--dtf-joule-*` custom props).
- Produces: new selectors `.dtf-cta-body-wrap`, `.dtf-cta-body` (visual only).

- [ ] **Step 1: Insert the body CTA markup**

In `DevtoberfestHome.vue`, immediately after the `unregistered` welcome paragraph:

```html
        <p v-else-if="state === 'unregistered'" class="dtf-msg">
          Click <strong>Join the Fest</strong> to accept the terms and start playing.
        </p>
```

add:

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

- [ ] **Step 2: Add the light-background variant CSS**

In `styles.css`, after the `@media (prefers-reduced-motion: reduce)` block that ends at line 214, add:

```css
/* ------------------- Body CTA (light background) -------------------- */

.dtf-cta-body-wrap {
  display: flex;
  justify-content: flex-start;
  margin-top: 0.25rem;
}

/* Drop the white inset ring (invisible on light bg); fix focus color. */
.dtf-cta-body {
  box-shadow: 0 6px 18px rgba(var(--dtf-joule-glow), 0.45);
}
.dtf-cta-body:focus-visible {
  outline: 2px solid var(--dtf-joule-1);
  outline-offset: 2px;
}
```

- [ ] **Step 3: Verify CSS parses**

Run:

```bash
node -e "require('esbuild').buildSync({entryPoints:['D:/projects/tutorials-poc/.claude/worktrees/devtoberfest-joule-arcade/hugo-apps/src/devtoberfest/styles.css'],bundle:false,write:false,minify:true,loader:{'.css':'css'}}); console.log('CSS OK')"
```

(Run from a directory that has `esbuild`, e.g. `D:/projects/tutorials-poc/hugo-apps`. Windows-style path required.)
Expected: `CSS OK`.

- [ ] **Step 4: Commit**

```bash
git add hugo-apps/src/devtoberfest/DevtoberfestHome.vue hugo-apps/src/devtoberfest/styles.css
git commit -m "feat(devtoberfest): add second Join the Fest CTA below welcome text"
```

---

### Task 2: Neon arcade strip + blink

**Files:**
- Modify: `hugo-apps/src/devtoberfest/styles.css` (`.dtf-arcade-strip` at lines 229-247; add keyframe + blink rule)

**Interfaces:**
- Consumes: existing `.dtf-arcade-strip`, `.dtf-arcade-chunk` selectors.
- Produces: `dtfArcadeBlink` keyframe.

- [ ] **Step 1: Recolor the strip to neon purple**

In `.dtf-arcade-strip` (lines 229-247), replace the `color` line:

```css
  color: var(--sapNeutralColor, #6a6d70);
```

with:

```css
  color: #A100C2;
  text-shadow: 0 0 6px rgba(161, 0, 194, 0.7), 0 0 12px rgba(123, 66, 240, 0.5);
```

and replace the two dashed-border color lines:

```css
  border-top: 1px dashed var(--sapPageHeader_BorderColor, #d5dadc);
  border-bottom: 1px dashed var(--sapPageHeader_BorderColor, #d5dadc);
```

with:

```css
  border-top: 1px dashed rgba(123, 66, 240, 0.5);
  border-bottom: 1px dashed rgba(123, 66, 240, 0.5);
```

- [ ] **Step 2: Add the blink keyframe + apply to the last chunk (INSERT_COIN)**

After the `.dtf-arcade-chunk` rule (line 247), add:

```css
@keyframes dtfArcadeBlink {
  0%, 80%, 100% { opacity: 0.3; }
  40%           { opacity: 1; }
}
.dtf-arcade-chunk:last-child {
  animation: dtfArcadeBlink 1.2s infinite ease-in-out;
}
```

- [ ] **Step 3: Verify CSS parses**

Run the esbuild command from Task 1 Step 3. Expected: `CSS OK`.

- [ ] **Step 4: Commit**

```bash
git add hugo-apps/src/devtoberfest/styles.css
git commit -m "feat(devtoberfest): neon-glow arcade strip with blinking INSERT_COIN"
```

---

### Task 3: True-Joule hero gradient + aurora glow

**Files:**
- Modify: `hugo-apps/src/devtoberfest/styles.css` (`.dtf-header` at line 29; add `::after` + keyframe; add banner guard after line 58)

**Interfaces:**
- Consumes: `.dtf-header` (already `position: relative; overflow: hidden; isolation: isolate`), `.dtf-header[data-has-banner="true"]` (line 53), existing `::before` scanline (z-index 0), content children at z-index 1.
- Produces: `dtfHeroAurora` keyframe.

- [ ] **Step 1: Swap the hero gradient to true Joule purple**

In `.dtf-header` (line 29), replace:

```css
  background: linear-gradient(135deg, #0070f2 0%, #7858ff 100%);
```

with:

```css
  background: linear-gradient(165deg, #5D36FF 0%, #7B42F0 45%, #A100C2 100%);
```

- [ ] **Step 2: Add the aurora `::after` glow layer + keyframe**

Immediately after the `.dtf-header::before { ... }` rule (ends line 50), add:

```css
/* Drifting Joule aurora glow — behind content (z-index 1), above base gradient. */
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

- [ ] **Step 3: Suppress the aurora on the image-banner variant**

Immediately after line 58 (`.dtf-header[data-has-banner="true"]::before { display: none; }`), add:

```css
.dtf-header[data-has-banner="true"]::after { display: none; }
```

- [ ] **Step 4: Verify CSS parses**

Run the esbuild command from Task 1 Step 3. Expected: `CSS OK`.

- [ ] **Step 5: Commit**

```bash
git add hugo-apps/src/devtoberfest/styles.css
git commit -m "feat(devtoberfest): true-Joule hero gradient with drifting aurora glow"
```

---

### Task 4: Mascot bob + neon rail hover

**Files:**
- Modify: `hugo-apps/src/devtoberfest/styles.css` (`.dtf-kasimir` at 286-291; `.dtf-rail-item` transition line 314; `.dtf-rail-item:hover` lines 322-324; add `dtfBob` keyframe)

**Interfaces:**
- Consumes: `.dtf-kasimir`, `.dtf-rail-item`, `.dtf-rail-item:hover`.
- Produces: `dtfBob` keyframe.

- [ ] **Step 1: Add the bob keyframe and apply to the mascot**

After the `.dtf-kasimir { ... }` rule (ends line 291), add:

```css
@keyframes dtfBob {
  0%, 100% { transform: translateY(0); }
  50%      { transform: translateY(-10px); }
}
.dtf-kasimir {
  animation: dtfBob 3s ease-in-out infinite;
}
```

- [ ] **Step 2: Add box-shadow to the rail transition**

In `.dtf-rail-item` (line 314), replace:

```css
  transition: transform 120ms ease, box-shadow 120ms ease;
```

with:

```css
  transition: transform 120ms ease, box-shadow 120ms ease, border-color 120ms ease;
```

- [ ] **Step 3: Replace the existing rail `:hover` with a purple glow**

Replace the existing `.dtf-rail-item:hover` (lines 322-324):

```css
.dtf-rail-item:hover {
  transform: translateX(2px);
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.08);
}
```

with:

```css
.dtf-rail-item:hover {
  transform: translateX(2px);
  box-shadow: 0 0 0 1px rgba(123, 66, 240, 0.5), 0 6px 16px rgba(123, 66, 240, 0.35);
}
```

- [ ] **Step 4: Verify CSS parses**

Run the esbuild command from Task 1 Step 3. Expected: `CSS OK`.

- [ ] **Step 5: Commit**

```bash
git add hugo-apps/src/devtoberfest/styles.css
git commit -m "feat(devtoberfest): bob the mascot and add neon glow to rail hover"
```

---

### Task 5: Reduced-motion guard for all new animations

**Files:**
- Modify: `hugo-apps/src/devtoberfest/styles.css` (the existing `@media (prefers-reduced-motion: reduce)` block, lines 212-214)

**Interfaces:**
- Consumes: `.dtf-cta`, `.dtf-arcade-chunk:last-child`, `.dtf-header::after`, `.dtf-kasimir`.

- [ ] **Step 1: Extend the reduced-motion block**

Replace the existing block (lines 212-214):

```css
@media (prefers-reduced-motion: reduce) {
  .dtf-cta { animation: none; }
}
```

with:

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

- [ ] **Step 2: Verify CSS parses**

Run the esbuild command from Task 1 Step 3. Expected: `CSS OK`.

- [ ] **Step 3: Commit**

```bash
git add hugo-apps/src/devtoberfest/styles.css
git commit -m "feat(devtoberfest): disable new arcade/aurora animations under reduced motion"
```

---

### Task 6: Visual verification of all states

**Files:** none (verification only).

Load the Devtoberfest page in Playwright (deployed URL, or a local serve of the built bundle). Because the deployed site won't have these changes yet, inject the FINAL CSS from `styles.css` and clone the body button to verify, OR verify against a local `vite build` + Hugo serve if available.

- [ ] **Step 1: Unregistered** — a purple Joule pill "Join the Fest" appears below the welcome sentence, left-aligned, pulsing, opens the terms dialog on click.
- [ ] **Step 2: Registered / other states** — the body button is absent (only the `unregistered` state shows it).
- [ ] **Step 3: Arcade strip** — neon purple glow; `INSERT_COIN` (last chunk) blinks.
- [ ] **Step 4: Hero** — Joule purple gradient with a gently drifting aurora; CRT scanlines still visible.
- [ ] **Step 5: Banner variant** — if a header banner image is present (`data-has-banner="true"`), NO aurora renders over the photo.
- [ ] **Step 6: Mascot** — Kasimir bobs.
- [ ] **Step 7: Rail hover** — items glow purple on hover.
- [ ] **Step 8: Reduced motion** — with `prefers-reduced-motion: reduce`, no animations run; everything stays legible.

Capture a full-page screenshot for the PR.

---

## Self-Review

**Spec coverage:**
- Cloned body CTA (markup + light-bg variant) → Task 1 ✓
- Neon arcade strip + blink → Task 2 ✓
- True-Joule hero + aurora + banner guard → Task 3 ✓
- Mascot bob → Task 4 Steps 1 ✓
- Neon rail hover (modify existing) → Task 4 Steps 2-3 ✓
- Reduced-motion for all new animations → Task 5 ✓
- All success criteria → Task 6 ✓

**Placeholder scan:** No TBD/TODO; all CSS and markup shown verbatim. The optional rail `--rail-color` re-map is explicitly optional in the spec and omitted from required steps (glow-on-hover is the required part) — not a placeholder.

**Type/name consistency:** Keyframes `dtfArcadeBlink`, `dtfHeroAurora`, `dtfBob` are each defined once and referenced by the same name in their apply rule and in the Task 5 reduced-motion block. `.dtf-cta-body` / `.dtf-cta-body-wrap` used consistently in Task 1 markup and CSS. `--dtf-joule-glow` / `--dtf-joule-1` are inherited from the existing `.dtf-cta` block (confirmed present at styles.css:151-154). Line numbers reference the current merged `styles.css`.
