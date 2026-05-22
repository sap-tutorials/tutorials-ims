# U16 Mission Side-Navigation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the right-column Vue mini-navigator on tutorial pages with a `<ui5-side-navigation>` rendered statically from Hugo frontmatter, hydrated at runtime with per-tutorial progress bars and per-mission expand-state persistence.

**Architecture:** Hugo partial emits the full mission tree from frontmatter (no FOUC; full list visible on first paint). A small TS module hydrates progress bars from `/api/missions/<id>/navigation` and persists group expand/collapse state to localStorage keyed by mission. The Vue mini-navigator is deleted entirely — no half-finished migration.

**Tech Stack:** Hugo (Go templates), TypeScript, UI5 Web Components v2.x (`@ui5/webcomponents-fiori` SideNavigation), localStorage, PostCSS.

**Spec:** [docs/superpowers/specs/2026-05-22-u16-mission-side-nav-design.md](../specs/2026-05-22-u16-mission-side-nav-design.md)

---

## Pre-flight

### Task 0: Verify UI5 SideNavigation v2.x API ✅ DONE

Researched via UI5 MCP. Findings (these are baked into Tasks 1, 2, 4 below):

- **`selected`** is the correct attribute on both `ui5-side-navigation-item` and `ui5-side-navigation-sub-item`.
- **`expanded`** is the correct attribute on `ui5-side-navigation-item`.
- **No `slot="items"` exists.** Sub-items go in the *default* slot of the parent item. The plan below does NOT use `slot="items"`.
- **Sub-items expose no slot for additional content.** Light-DOM children of `<ui5-side-navigation-sub-item>` will be discarded. Progress bar is therefore rendered as a CSS `::after` pseudo on the host element, with width driven by an inline CSS custom property `--msn-progress` set by JS.
- **`selection-change` event** on `ui5-side-navigation` fires only on selection (not expand/collapse). There is no dedicated group-toggle event — `expanded` is mutated internally when a user clicks a parent item's chevron. Persistence reads `expanded` attributes via a delegated `click` + microtask handler on the nav root.

### Task 0.5: Set up worktree

**Files:** none (worktree setup)

- [ ] **Step 1: Create worktree using using-git-worktrees skill**

Branch: `ui-pilot/u16-mission-side-nav`
Directory: project-local `.worktrees/u16-mission-side-nav` (consistent with prior U-series pilots)

Verify `.worktrees` is gitignored before creating.

- [ ] **Step 2: Run baseline check**

```bash
cd .worktrees/u16-mission-side-nav
npm install
npm test
```

Expected: same baseline as main. Park any pre-existing failures (do not block pilot on them; see [[project_main_test_failures]]).

---

## Implementation

### Task 1: Hugo partial — `mission-side-nav.html`

**Files:**
- Create: `hugo/layouts/partials/mission-side-nav.html`

- [ ] **Step 1: Write the partial**

```go-html-template
{{/* mission-side-nav.html — U16

Renders <ui5-side-navigation> from the current tutorial's mission frontmatter.

Per Task 0 findings (UI5 v2.x):
  - sub-items use the default slot (no slot="items")
  - sub-items expose no slot for additional content; progress bar is rendered
    as a CSS ::after pseudo on the host with width driven by --msn-progress
    (set inline by mission-side-nav.ts at runtime)

Inputs (page params expected on tutorial pages):
  .Params.missionId    — required; if empty, partial renders nothing
  .Params.missionSlug  — used to look up the mission page and emit links
  .Params.slug         — current tutorial slug (for `selected` highlight)
*/}}
{{ $missionId   := .Params.missionId }}
{{ $missionSlug := .Params.missionSlug }}
{{ $current     := .Params.slug }}

{{ if and $missionId $missionSlug }}
  {{ with site.GetPage (printf "/tutorials/mission-%s" $missionSlug) }}
    {{ $missionTitle := .Params.missionTitle | default .Title }}
    <aside class="mission-side-nav-wrap">
      <div class="msn-header">
        <a href="/tutorials/mission-{{ $missionSlug }}/">{{ $missionTitle }}</a>
      </div>
      <ui5-side-navigation
        data-mission-nav
        data-mission-id="{{ $missionId }}"
        data-mission-slug="{{ $missionSlug }}"
        data-current-slug="{{ $current }}">
        {{ range .Params.groups }}
          {{ $groupSlug  := .slug }}
          {{ $groupTitle := .title }}
          {{ if .tutorials }}
            <ui5-side-navigation-item
              text="{{ $groupTitle }}"
              data-group-slug="{{ $groupSlug }}">
              {{ range .tutorials }}
                <ui5-side-navigation-sub-item
                  text="{{ .title }}"
                  href="/tutorials/{{ .slug }}/"
                  data-tutorial-slug="{{ .slug }}"
                  data-progress="0"
                  {{ if eq .slug $current }}selected{{ end }}>
                </ui5-side-navigation-sub-item>
              {{ end }}
            </ui5-side-navigation-item>
          {{ end }}
        {{ end }}
      </ui5-side-navigation>
    </aside>
  {{ end }}
{{ end }}
```

NOTE: `slot="items"` is intentionally absent — sub-items go in the parent item's default slot per UI5 v2.x.

- [ ] **Step 2: Commit**

```bash
git add hugo/layouts/partials/mission-side-nav.html
git commit -m "feat(u16): add mission side-nav Hugo partial"
```

---

### Task 2: CSS — `mission-side-nav.css`

**Files:**
- Create: `hugo/assets/css/mission-side-nav.css`

- [ ] **Step 1: Write the CSS**

```css
/* mission-side-nav.css — U16 */

.mission-side-nav-wrap {
  display: flex;
  flex-direction: column;
  background: var(--sapBackgroundColor, #fff);
  border: 1px solid var(--sapGroup_ContentBorderColor, #e5e7eb);
  border-radius: 4px;
  max-height: calc(100vh - 200px);
  overflow: hidden;
}

.msn-header {
  padding: 0.5rem 0.75rem;
  font-weight: 600;
  font-size: 0.875rem;
  background: var(--sapList_HeaderBackground, #f5f6f7);
  border-bottom: 1px solid var(--sapGroup_ContentBorderColor, #e5e7eb);
}

.msn-header a {
  color: var(--sapLinkColor, #0a6ed1);
  text-decoration: none;
}

.msn-header a:hover { text-decoration: underline; }

.mission-side-nav-wrap ui5-side-navigation {
  flex: 1;
  overflow-y: auto;
}

/* Per Task 0: sub-items have no slot for child content, so the progress bar
   is rendered as a ::after pseudo on the host element. Width is driven by
   the inline custom property --msn-progress, set by mission-side-nav.ts. */
.mission-side-nav-wrap ui5-side-navigation-sub-item {
  position: relative;
}

.mission-side-nav-wrap ui5-side-navigation-sub-item::after {
  content: '';
  position: absolute;
  left: 0;
  bottom: 0;
  height: 2px;
  width: var(--msn-progress, 0%);
  background: var(--sapButton_Emphasized_Background, #0a6ed1);
  transition: width 200ms ease-out;
  pointer-events: none;
}

@media (max-width: 960px) {
  .mission-side-nav-wrap { max-height: none; }
}
```

- [ ] **Step 2: Commit**

```bash
git add hugo/assets/css/mission-side-nav.css
git commit -m "feat(u16): add mission side-nav stylesheet"
```

---

### Task 3: Bootstrap imports + runtime stub

**Files:**
- Modify: `hugo/assets/js/ui5-bootstrap.ts`
- Create: `hugo/assets/js/mission-side-nav.ts` (stub only — full impl in Task 4)

- [ ] **Step 1: Add the stub module**

Create `hugo/assets/js/mission-side-nav.ts`:

```ts
// mission-side-nav.ts — U16
// Hydrates progress bars and persists group expand state for the mission side-nav.
// Loaded site-wide via ui5-bootstrap; gated on DOM presence.

export {};

const nav = document.querySelector<HTMLElement>('[data-mission-nav]');
if (nav) {
  // wired up in Task 4
}
```

- [ ] **Step 2: Wire imports in `ui5-bootstrap.ts`**

Add side-effect imports for the SideNavigation modules and the new TS module + CSS:

```ts
import '@ui5/webcomponents-fiori/dist/SideNavigation.js';
import '@ui5/webcomponents-fiori/dist/SideNavigationItem.js';
import '@ui5/webcomponents-fiori/dist/SideNavigationSubItem.js';
import './mission-side-nav';
import '../css/mission-side-nav.css';
```

Place these alongside the existing UI5 component imports in the order they appear in the file.

- [ ] **Step 3: Run dev server, verify no build errors**

```bash
npm run dev
```

Expected: Hugo serves at :1313 with no esbuild errors. The stub does nothing yet (nav element doesn't exist on any page).

- [ ] **Step 4: Commit**

```bash
git add hugo/assets/js/mission-side-nav.ts hugo/assets/js/ui5-bootstrap.ts
git commit -m "feat(u16): wire mission-side-nav module + UI5 SideNavigation imports"
```

---

### Task 4: Runtime hydration logic

**Files:**
- Modify: `hugo/assets/js/mission-side-nav.ts`

- [ ] **Step 1: Replace stub with full implementation**

```ts
// mission-side-nav.ts — U16

type NavTutorial = { slug: string; title: string; progress: number };
type NavGroup = { title: string; children: NavTutorial[] };
type NavRoot = { children: NavGroup[] };
type NavResponse = { context: NavRoot[] };

const STORAGE_PREFIX = 'mission-nav-expanded:';

function readExpandedState(missionId: string): Record<string, boolean> {
  try {
    const raw = localStorage.getItem(STORAGE_PREFIX + missionId);
    return raw ? (JSON.parse(raw) as Record<string, boolean>) : {};
  } catch {
    return {};
  }
}

function writeExpandedState(missionId: string, state: Record<string, boolean>): void {
  try {
    localStorage.setItem(STORAGE_PREFIX + missionId, JSON.stringify(state));
  } catch {
    // quota / private mode — silently fall back to defaults
  }
}

function applyInitialExpansion(nav: HTMLElement, currentSlug: string): void {
  const missionId = nav.dataset.missionId || '';
  const stored = readExpandedState(missionId);
  const items = nav.querySelectorAll<HTMLElement>('ui5-side-navigation-item');
  items.forEach((item) => {
    const groupSlug = item.dataset.groupSlug || '';
    let expanded: boolean;
    if (groupSlug in stored) {
      expanded = stored[groupSlug];
    } else {
      // First visit default: expand only the group containing the current tutorial.
      expanded = !!item.querySelector(`ui5-side-navigation-sub-item[data-tutorial-slug="${currentSlug}"]`);
    }
    if (expanded) {
      item.setAttribute('expanded', '');
    } else {
      item.removeAttribute('expanded');
    }
  });
}

function paintProgress(nav: HTMLElement, slug: string, progress: number): void {
  const sub = nav.querySelector<HTMLElement>(`ui5-side-navigation-sub-item[data-tutorial-slug="${slug}"]`);
  if (!sub) return;
  const clamped = Math.max(0, Math.min(100, Math.round(progress)));
  sub.dataset.progress = String(clamped);
  // Per Task 0: sub-items expose no slot — paint via inline CSS custom property
  // consumed by the ::after pseudo defined in mission-side-nav.css.
  sub.style.setProperty('--msn-progress', clamped + '%');
}

function isNavResponse(value: unknown): value is NavResponse {
  if (!value || typeof value !== 'object') return false;
  const ctx = (value as { context?: unknown }).context;
  return Array.isArray(ctx);
}

async function hydrateProgress(nav: HTMLElement): Promise<void> {
  const missionId = nav.dataset.missionId;
  if (!missionId) return;
  try {
    const res = await fetch(`/api/missions/${encodeURIComponent(missionId)}/navigation`, {
      credentials: 'include',
    });
    if (!res.ok) return;
    const body: unknown = await res.json();
    if (!isNavResponse(body)) return;
    for (const root of body.context) {
      if (!root || !Array.isArray(root.children)) continue;
      for (const group of root.children) {
        if (!group || !Array.isArray(group.children)) continue;
        for (const tut of group.children) {
          if (tut && typeof tut.slug === 'string' && typeof tut.progress === 'number') {
            paintProgress(nav, tut.slug, tut.progress);
          }
        }
      }
    }
  } catch {
    // network / parse error — leave progress at 0%
  }
}

function wireExpandPersistence(nav: HTMLElement): void {
  const missionId = nav.dataset.missionId || '';
  const persist = (): void => {
    const state: Record<string, boolean> = {};
    nav.querySelectorAll<HTMLElement>('ui5-side-navigation-item').forEach((item) => {
      const slug = item.dataset.groupSlug || '';
      if (slug) state[slug] = item.hasAttribute('expanded');
    });
    writeExpandedState(missionId, state);
  };
  // Per Task 0: no dedicated group-toggle event exists in UI5 v2.x.
  // selection-change fires only on selection. Read expanded state via a
  // delegated click + microtask, so we capture the toggle after UI5 applies it.
  nav.addEventListener('click', () => queueMicrotask(persist));
  nav.addEventListener('selection-change', persist);
}

function init(nav: HTMLElement): void {
  const currentSlug = nav.dataset.currentSlug || '';
  applyInitialExpansion(nav, currentSlug);
  wireExpandPersistence(nav);
  void hydrateProgress(nav);
}

const nav = document.querySelector<HTMLElement>('[data-mission-nav]');
if (nav) {
  if (customElements.get('ui5-side-navigation')) {
    init(nav);
  } else {
    void customElements.whenDefined('ui5-side-navigation').then(() => init(nav));
  }
}

export {};
```

- [ ] **Step 2: Commit**

```bash
git add hugo/assets/js/mission-side-nav.ts
git commit -m "feat(u16): hydrate side-nav progress + persist expand state"
```

---

### Task 5: Swap layouts to use the new partial

**Files:**
- Modify: `hugo/layouts/tutorials/u1-object-page.html`
- Modify: `hugo/layouts/tutorials/single.html`

- [ ] **Step 1: Replace partial reference in u1-object-page.html**

Find: `{{ partial "mini-navigator.html" . }}`
Replace with: `{{ partial "mission-side-nav.html" . }}`

Find: `<script type="module" src="/js/mini-navigator.js"></script>`
Delete the line.

- [ ] **Step 2: Same swap in single.html**

Same two edits as above.

- [ ] **Step 3: Browser verify**

```bash
npm run dev
```

Open a tutorial that's part of a mission. Confirm:
- Side-nav renders with mission title + groups + tutorials
- Current tutorial shows `selected` (visible highlight)
- Only the current group is expanded on first load
- No console errors

- [ ] **Step 4: Commit**

```bash
git add hugo/layouts/tutorials/u1-object-page.html hugo/layouts/tutorials/single.html
git commit -m "feat(u16): swap mini-navigator partial for mission-side-nav"
```

---

### Task 6: Drop dead code in tutorial.ts

**Files:**
- Modify: `hugo/assets/js/tutorial.ts`

- [ ] **Step 1: Delete `initMiniNavProgress` function**

Remove the function definition (around lines 446–476) and its call site (around line 531). Verify no other references remain in the file.

- [ ] **Step 2: Commit**

```bash
git add hugo/assets/js/tutorial.ts
git commit -m "refactor(u16): drop initMiniNavProgress (replaced by mission-side-nav)"
```

---

### Task 7: Remove `.mini-nav*` CSS + regen build artifact

**Files:**
- Modify: `hugo/assets/css/sap-fundamental.css`
- Regen: `hugo/static/css/sap-fundamental.css`

- [ ] **Step 1: Delete `.mini-nav` rules**

Remove the entire block of selectors starting with `.mini-nav` (around lines 754–881 in the source CSS). Save.

- [ ] **Step 2: Rebuild CSS artifact**

```bash
npm run build:css
```

Confirm `hugo/static/css/sap-fundamental.css` updated and no `.mini-nav` selectors remain in either file.

- [ ] **Step 3: Commit**

```bash
git add hugo/assets/css/sap-fundamental.css hugo/static/css/sap-fundamental.css
git commit -m "refactor(u16): drop .mini-nav CSS (replaced by mission-side-nav)"
```

---

### Task 8: Delete Vue mini-navigator files

**Files:**
- Delete: `hugo/layouts/partials/mini-navigator.html`
- Delete: `hugo/static/js/mini-navigator.js`

- [ ] **Step 1: Verify no other references**

```bash
git grep -n "mini-navigator" -- hugo/
git grep -n "MiniNavigator" -- .
```

Expected: no matches. If any are found, resolve them before deleting (most likely just self-references already removed in Tasks 5–7).

- [ ] **Step 2: Delete files**

```bash
git rm hugo/layouts/partials/mini-navigator.html hugo/static/js/mini-navigator.js
```

- [ ] **Step 3: Run dev server end-to-end**

```bash
npm run dev
```

Reload tutorial → still works. Reload mission page → still works. No 404s in network tab for `mini-navigator.js`.

- [ ] **Step 4: Commit**

```bash
git commit -m "chore(u16): delete Vue mini-navigator (replaced by ui5-side-navigation)"
```

---

### Task 9: Manual verification

**Files:** none

- [ ] **Step 1: Run hybrid dev server**

```bash
npm run dev:hybrid
```

- [ ] **Step 2: Walk the verification matrix from the spec**

Run through all 10 manual checks from the spec's "Verification plan" section:
1. Tutorial inside mission → side-nav renders, current selected
2. First visit (cleared localStorage) → only current group expanded
3. Toggle different group → reload → state preserved
4. Switch missions → independent localStorage entries
5. Progress bars hydrate after auth
6. Sub-item click → navigates
7. Tutorial outside mission → no side-nav
8. Resize <960px → stacks; resize back → returns
9. Theme toggle → side-nav follows
10. Logged-out → static structure renders, progress at 0%

Console: no errors, no 4xx/5xx from `/api/missions/<id>/navigation` for authed user, localStorage entry visible after toggling.

- [ ] **Step 3: Run unit tests**

```bash
npm test
```

Expected: same baseline as main (no new failures).

- [ ] **Step 4: Open PR**

```bash
git push -u origin ui-pilot/u16-mission-side-nav
gh pr create --title "U16: Mission side-navigation (UI5 SideNavigation)" --body "$(cat <<'EOF'
## Summary
- Replace right-column Vue mini-navigator with `<ui5-side-navigation>` rendered statically from Hugo frontmatter
- Hydrate per-tutorial progress bars from `/api/missions/<id>/navigation`
- Persist per-mission group expand/collapse to localStorage
- Delete the Vue mini-navigator entirely

## Test plan
- [ ] Hybrid dev: tutorial inside a mission renders full mission tree on first paint
- [ ] First visit: only current group expanded
- [ ] Toggle different group → reload → state preserved
- [ ] Switch missions → independent state per mission
- [ ] Progress bars hydrate post-auth, stay at 0% logged-out
- [ ] Resize <960px → stacks; >960px → right column
- [ ] Theme toggle (light/dark) follows Horizon
- [ ] No console errors; no 4xx from `/api/missions/<id>/navigation` for authed user
- [ ] `npm test` matches main baseline
EOF
)"
```

---

## Risks and mitigations (carry-over from spec)

| Risk | Mitigation |
|---|---|
| `<ui5-side-navigation-sub-item>` doesn't expose a slot for the progress bar | Light-DOM `<div class="msn-progress">` overlay (already in plan); CSS positioning handles layout |
| UI5 v2.x API drift on `selected` attribute name or toggle event name | Task 0 verifies via UI5 MCP; defensive event listeners on multiple candidate names |
| Vue mini-navigator deletion breaks an unknown caller | `git grep` step in Task 8 surfaces any remaining references |
| `/api/missions/<id>/navigation` response shape diverges from expected | Runtime guard (`isNavResponse`) skips hydration silently if shape mismatches |
| FOUC: side-nav renders unstyled before UI5 hydration | Pattern matches existing U1 components (tabcontainer, rating, message-strip) — same outcome |
