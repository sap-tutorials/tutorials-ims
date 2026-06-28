# Homepage refinement — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land a single PR that (1) renders all six homepage verb tile + shellbar menu icons, (2) makes the EventsBand empty-vs-error states honest, and (3) closes the static-icon-guard gap that let the `<ui5-icon name="…">` form slip past.

**Architecture:** Pure frontend + build-tooling change. Three production files (`ui5-bootstrap.ts`, `header.html`, `EventsBand.vue`), one build-guard file (`scripts/check-icon-imports.ts`), one existing test file (extended), one new test file. No backend, no schema, no new dependencies.

**Tech Stack:** Hugo (templates) · TypeScript (UI5 bootstrap + check script) · Vue 3 SFC (EventsBand) · Vitest + @vue/test-utils + happy-dom (tests, already installed at root) · UI5 Web Components 2.x icons

**Working directory:** `D:\projects\tutorials-poc\.claude\worktrees\homepage-refinement` (branch `worktree-homepage-refinement`). All commands assume this CWD unless stated otherwise.

**Spec:** [`docs/superpowers/specs/2026-06-28-homepage-icon-events-refinement-design.md`](../specs/2026-06-28-homepage-icon-events-refinement-design.md)

---

## Pre-flight (one-time, must run first)

### Task 0: Worktree readiness

**Files:** none (read-only)

- [ ] **Step 0.1: Confirm branch + clean state**

```bash
git rev-parse --show-toplevel
git branch --show-current
git status -sb
```

Expected:
- toplevel ends with `\.claude\worktrees\homepage-refinement`
- branch is `worktree-homepage-refinement`
- status shows only `## worktree-homepage-refinement` (clean) or the already-committed spec

If branch is not `worktree-homepage-refinement`, STOP and surface to user — do not proceed on the wrong branch (memory: `feedback_verify_branch_before_commit`).

- [ ] **Step 0.2: Ensure `npm install` + `npm run setup` have run in this worktree**

Fresh worktrees need both because the global npmrc has `ignore-scripts=true` (memory: `feedback_npm_ignore_scripts_native_modules`).

```bash
# Cheap probe: does node_modules exist and is better-sqlite3's native binding built?
test -d node_modules && echo "node_modules: ok" || echo "node_modules: MISSING — run: npm install"
test -f node_modules/better-sqlite3/build/Release/better_sqlite3.node && \
  echo "better-sqlite3 native: ok" || echo "better-sqlite3 native: MISSING — run: npm run setup"
test -d hugo-apps/node_modules && \
  echo "hugo-apps/node_modules: ok" || echo "hugo-apps/node_modules: MISSING — run: npm run setup"
```

If anything reports MISSING:

```bash
npm install
npm run setup
```

Expected (after, if needed): all three probes return `ok`.

- [ ] **Step 0.3: Verify the check-icon-imports guard fails as expected**

This locks in our starting point. Confirms the same FAIL signature Tom saw, so the later "now passes" assertion is meaningful.

```bash
npx tsx scripts/check-icon-imports.ts 2>&1 | head -30
echo "---exit: $?"
```

Expected:
- Stderr lists exactly four unregistered icons:
  - `learning-assistant` at `hugo/layouts/partials/header.html:19`
  - `action` at `hugo/layouts/partials/header.html:20`
  - `chain-link` at `hugo/layouts/partials/header.html:21`
  - `discussion` at `hugo/layouts/partials/header.html:24`
- Exit code 1.

If the failure list differs, the codebase has drifted since the spec was written — STOP and surface to user.

- [ ] **Step 0.4: Confirm only one file uses `<ui5-icon name="…">` in layouts**

```bash
grep -rn '<ui5-icon\s\+name=' hugo/layouts/
```

Expected: exactly one hit, `hugo/layouts/partials/homepage/verb-spine.html:27`.

If more than one file matches, list them and STOP — the broadened guard will trip on every unregistered icon in those files. Tom will need to triage them before we proceed.

---

## File map

| File | Action | Why |
|---|---|---|
| `hugo/assets/js/ui5-bootstrap.ts` | Modify | Register 3 icons that the layouts already reference. |
| `hugo/layouts/partials/header.html` | Modify | Align Build + Connect shellbar icons with verb-tile icons. |
| `hugo-apps/src/homepage-bands/EventsBand.vue` | Modify | Split combined empty-OR-error branch into two distinct states. |
| `scripts/check-icon-imports.ts` | Modify | Add second regex for `<ui5-icon name="…">`; update header comment. |
| `test/unit/check-icon-imports.test.ts` | Modify | Two new cases proving the new regex catches the verb-spine pattern. |
| `hugo-apps/src/homepage-bands/EventsBand.test.ts` | Create | Vue Test Utils test for 4 component states. |

Tasks are ordered to commit each change in a self-contained step. The icon-import additions land first because they're the user-visible win; the guard-broadening lands last because it'd otherwise reject our intermediate commits (a tile naming `learning-assistant` with no import).

Actually — let me re-check that. We're adding the imports FIRST (Task 1), so after Task 1 the static guard is green. The guard-broadening in Task 4 then adds the verb-spine icon names (`learning-assistant`, `developer-settings`, `chain-link`, `settings`, `da`, `customer-and-contacts`) to the usage list. All six are now imported (3 from Task 1 + 3 already present), so the broadened guard also passes. Safe ordering.

---

## Task 1: Register missing UI5 icons

**Files:**
- Modify: `hugo/assets/js/ui5-bootstrap.ts:124` (append after the `customer-and-contacts.js` import)

- [ ] **Step 1.1: Read the existing icon-import block**

```bash
sed -n '80,130p' hugo/assets/js/ui5-bootstrap.ts
```

Confirm line 124 reads:
```
import "@ui5/webcomponents-icons/dist/customer-and-contacts.js";
```

(Line numbers may have drifted; the anchor is the exact import string, not the line number.)

- [ ] **Step 1.2: Insert the three new imports**

Use the Edit tool with this exact old/new pair (preserves surrounding context, makes review easy):

```
old_string:
import "@ui5/webcomponents-icons/dist/customer-and-contacts.js";
import "@ui5/webcomponents-icons/dist/favorite.js";

new_string:
import "@ui5/webcomponents-icons/dist/customer-and-contacts.js";
// Verb tile + shellbar menu icons (homepage refinement, spec 2026-06-28).
// The matching `<ui5-icon name="…">` / `icon="…"` callsites live in
// hugo/layouts/partials/homepage/verb-spine.html and
// hugo/layouts/partials/header.html. Without these imports the icon
// slots paint but the glyph never renders (silent UX regression).
import "@ui5/webcomponents-icons/dist/learning-assistant.js";
import "@ui5/webcomponents-icons/dist/developer-settings.js";
import "@ui5/webcomponents-icons/dist/chain-link.js";
import "@ui5/webcomponents-icons/dist/favorite.js";
```

- [ ] **Step 1.3: Run the existing guard to confirm three FAIL entries dropped**

```bash
npx tsx scripts/check-icon-imports.ts 2>&1 | head -30
echo "---exit: $?"
```

Expected: stderr now lists exactly TWO unregistered icons (`action` and `discussion`), exit code 1. The `learning-assistant`, `chain-link` errors are gone. (`developer-settings` was never in the FAIL list because verb-spine uses the `<ui5-icon name="…">` form the old regex didn't see.)

- [ ] **Step 1.4: Commit**

```bash
git add hugo/assets/js/ui5-bootstrap.ts
git -c core.autocrlf=false commit -m "feat(homepage): register missing UI5 icons for verb tiles + menu

Adds three icons referenced by hugo/layouts/partials/header.html and
hugo/layouts/partials/homepage/verb-spine.html that were not yet
imported in the UI5 bootstrap. Without these, UI5 allocates the slot
but never paints the glyph — silent UX regression.

- learning-assistant (Learn tile + shellbar item)
- developer-settings (Build tile)
- chain-link        (Integrate tile + shellbar item)

Refs spec 2026-06-28-homepage-icon-events-refinement-design.md"
```

Verify branch first:
```bash
test "$(git branch --show-current)" = "worktree-homepage-refinement" || { echo "WRONG BRANCH"; exit 1; }
```

---

## Task 2: Align shellbar menu icons with verb tiles

**Files:**
- Modify: `hugo/layouts/partials/header.html:20,24`

- [ ] **Step 2.1: Sanity-check the two target lines**

```bash
sed -n '18,26p' hugo/layouts/partials/header.html
```

Confirm:
- Line 20: `    <ui5-li icon="action" data-href="/build/">Build</ui5-li>`
- Line 24: `    <ui5-li icon="discussion" data-href="/connect/">Connect</ui5-li>`

- [ ] **Step 2.2: Swap the two icon names**

Two Edit calls (each unique, so no `replace_all` risk):

```
File: hugo/layouts/partials/header.html

Edit 1:
old: <ui5-li icon="action" data-href="/build/">Build</ui5-li>
new: <ui5-li icon="developer-settings" data-href="/build/">Build</ui5-li>

Edit 2:
old: <ui5-li icon="discussion" data-href="/connect/">Connect</ui5-li>
new: <ui5-li icon="customer-and-contacts" data-href="/connect/">Connect</ui5-li>
```

- [ ] **Step 2.3: Confirm grep shows zero leftover references to the dropped names**

```bash
grep -rn 'icon="action"\|icon="discussion"' hugo/ hugo-apps/ 2>&1
```

Expected: no matches. (If any appear, they're in some other layout we missed — STOP and triage.)

- [ ] **Step 2.4: Re-run the guard — should now be GREEN**

```bash
npx tsx scripts/check-icon-imports.ts 2>&1 | head -5
echo "---exit: $?"
```

Expected: `OK — <N> unique icon(s) referenced, all registered (...).` Exit code 0.

This proves all four originally-flagged icons are resolved. The verb-spine icons aren't yet seen by the guard (Task 4 fixes that), but `developer-settings` is now imported anyway, so when the broadened guard kicks in it'll still pass.

- [ ] **Step 2.5: Commit**

```bash
git add hugo/layouts/partials/header.html
git -c core.autocrlf=false commit -m "feat(homepage): align Build + Connect menu icons with verb tiles

Verb-spine tile and shellbar menu disagreed on the icon for Build
(developer-settings vs action) and Connect (customer-and-contacts
vs discussion). The menu now matches the tile in both cases —
one icon per verb across the system.

As a side effect 'action' and 'discussion' are no longer referenced
anywhere in hugo/ or hugo-apps/, so the guard which previously
flagged both as missing imports now passes.

Refs spec 2026-06-28-homepage-icon-events-refinement-design.md"
```

---

## Task 3: Distinguish empty-state from error-state in EventsBand

**Files:**
- Modify: `hugo-apps/src/homepage-bands/EventsBand.vue:59-70` (the empty/error block)

- [ ] **Step 3.1: Re-read the current block**

```bash
sed -n '58,72p' hugo-apps/src/homepage-bands/EventsBand.vue
```

Confirm the structure matches what the spec shows.

- [ ] **Step 3.2: Apply the split**

```
File: hugo-apps/src/homepage-bands/EventsBand.vue

old_string:
    <!-- Error / empty state -->
    <div v-else-if="error || !events.length" class="hb-events-band__empty">
      <p class="hb-events-band__empty-msg">
        {{ error ? 'Could not load upcoming events.' : 'No upcoming events.' }}
      </p>
      <a
        href="https://community.sap.com/t5/sap-events/ct-p/events"
        target="_blank"
        rel="noopener noreferrer"
        class="hb-events-band__fallback-link"
      >View all SAP events &rarr;</a>
    </div>

new_string:
    <!-- Error state: fetch rejected / non-2xx -->
    <div v-else-if="error" class="hb-events-band__empty">
      <p class="hb-events-band__empty-msg">Could not load upcoming events.</p>
      <a
        href="https://community.sap.com/t5/sap-events/ct-p/events"
        target="_blank"
        rel="noopener noreferrer"
        class="hb-events-band__fallback-link"
      >View all SAP events &rarr;</a>
    </div>

    <!-- Empty state: fetch succeeded but DB returned zero rows -->
    <div v-else-if="!events.length" class="hb-events-band__empty">
      <p class="hb-events-band__empty-msg">No upcoming events scheduled.</p>
      <a
        href="https://community.sap.com/t5/sap-events/ct-p/events"
        target="_blank"
        rel="noopener noreferrer"
        class="hb-events-band__fallback-link"
      >View all SAP events &rarr;</a>
    </div>
```

- [ ] **Step 3.3: Commit (Task 6 will add the test; this commit is the production change alone)**

```bash
git add hugo-apps/src/homepage-bands/EventsBand.vue
git -c core.autocrlf=false commit -m "fix(homepage): distinguish events empty-state from error-state

The combined v-else-if='error || !events.length' branch read
'Could not load upcoming events' whenever the array was empty —
even on a clean fetch returning []. That made a freshly-deployed
environment (no events seeded) look broken.

Split into two branches with distinct copy:
- error           → 'Could not load upcoming events.'
- !events.length  → 'No upcoming events scheduled.'

Fallback link preserved in both states.

Refs spec 2026-06-28-homepage-icon-events-refinement-design.md"
```

---

## Task 4: Broaden the icon-imports guard to also catch `<ui5-icon name="…">`

**Files:**
- Modify: `scripts/check-icon-imports.ts` (regex constant + `parseIconUsages()` + header block comment)

- [ ] **Step 4.1: Add the new regex constant after `ICON_RE`**

```
File: scripts/check-icon-imports.ts

old_string:
const ICON_RE = /(?<![-\w:])icon="([a-z][a-z0-9-]*)"/g;

export function parseIconUsages(file: string, content: string): IconUsage[] {

new_string:
const ICON_RE = /(?<![-\w:])icon="([a-z][a-z0-9-]*)"/g;

/**
 * Match `<ui5-icon name="…">` — the embedded-glyph form used by
 * hugo/layouts/partials/homepage/verb-spine.html (verb tile icons).
 *
 * The leading `<ui5-icon\b` element anchor prevents matching unrelated
 * `name="…"` attributes (e.g. <input name="x">, <a name="anchor">).
 * The intervening `[^>]*` allows other attributes before `name=`, and
 * `\s` before `name=` ensures we don't match an attribute that just
 * happens to end in `name` (e.g. `data-display-name="…"`).
 */
const UI5_ICON_NAME_RE = /<ui5-icon\b[^>]*\sname="([a-z][a-z0-9-]*)"/g;

export function parseIconUsages(file: string, content: string): IconUsage[] {
```

- [ ] **Step 4.2: Extend `parseIconUsages()` to run both patterns**

```
File: scripts/check-icon-imports.ts

old_string:
export function parseIconUsages(file: string, content: string): IconUsage[] {
  const stripped = stripComments(content);
  const lines = stripped.split('\n');
  const out: IconUsage[] = [];
  for (let i = 0; i < lines.length; i++) {
    for (const m of lines[i].matchAll(ICON_RE)) {
      out.push({ name: m[1], file, line: i + 1 });
    }
  }
  return out;
}

new_string:
export function parseIconUsages(file: string, content: string): IconUsage[] {
  const stripped = stripComments(content);
  const lines = stripped.split('\n');
  const out: IconUsage[] = [];
  for (let i = 0; i < lines.length; i++) {
    for (const m of lines[i].matchAll(ICON_RE)) {
      out.push({ name: m[1], file, line: i + 1 });
    }
    for (const m of lines[i].matchAll(UI5_ICON_NAME_RE)) {
      out.push({ name: m[1], file, line: i + 1 });
    }
  }
  return out;
}
```

- [ ] **Step 4.3: Update the header block comment**

```
File: scripts/check-icon-imports.ts

old_string:
// Scope (deliberate): STATIC literals only.
//   - `icon="some-name"` in .html (Hugo layouts) and .vue (islands)
//   - Names matching /^[a-z][a-z0-9-]*$/ (the UI5 icon-name shape;
//     skips `icon=""`, `icon="1"`, `icon="{{ .Foo }}"`, `:icon="x"`)
//   - HTML comments + Hugo `{{/* … */}}` are stripped before scanning
//   - Test fixture HTML under hugo-apps/src/**/__tests__/ is skipped —
//     it's a snapshot of layouts we already lint

new_string:
// Scope (deliberate): STATIC literals only.
//   - `icon="some-name"` in .html (Hugo layouts) and .vue (islands)
//   - `<ui5-icon name="some-name">` element in .html and .vue (verb-spine
//     pattern, hugo/layouts/partials/homepage/verb-spine.html). Anchored
//     on `<ui5-icon\b` so unrelated name="…" attributes don't match.
//   - Names matching /^[a-z][a-z0-9-]*$/ (the UI5 icon-name shape;
//     skips `icon=""`, `icon="1"`, `icon="{{ .Foo }}"`, `:icon="x"`)
//   - HTML comments + Hugo `{{/* … */}}` are stripped before scanning
//   - Test fixture HTML under hugo-apps/src/**/__tests__/ is skipped —
//     it's a snapshot of layouts we already lint
```

- [ ] **Step 4.4: Run the guard against the live tree to prove it still passes**

```bash
npx tsx scripts/check-icon-imports.ts 2>&1 | head -5
echo "---exit: $?"
```

Expected: `OK — N unique icon(s) referenced, all registered (…).` Exit 0.

The number of unique icons should INCREASE compared to Step 2.4 (the broadened regex now sees the six verb-spine icons: `learning-assistant`, `developer-settings`, `chain-link`, `settings`, `da`, `customer-and-contacts`). All six were already imported by end of Task 1, so still green.

- [ ] **Step 4.5: Run the existing test suite for the script (unchanged tests must still pass)**

```bash
npx vitest run test/unit/check-icon-imports.test.ts 2>&1 | tail -25
```

Expected: all 9 (or however many) existing tests pass. No new failures from the regex addition.

- [ ] **Step 4.6: Commit the script-only change (tests added next task)**

```bash
git add scripts/check-icon-imports.ts
git -c core.autocrlf=false commit -m "feat(build-guard): catch <ui5-icon name='…'> usages too

scripts/check-icon-imports.ts previously only matched the icon='…'
attribute form. The verb-spine homepage tile uses the embedded form
<ui5-icon name='…'></ui5-icon>, which the regex missed — that's how
the verb-tile icons shipped unregistered without the guard catching
it.

Adds UI5_ICON_NAME_RE anchored on <ui5-icon\\b to avoid matching
unrelated name= attributes (e.g. <input name='x'>, <a name='anchor'>).
parseIconUsages() now runs both regexes per line and unions results.

Existing tests unchanged; new tests covering the broadened pattern
land in the next commit.

Refs spec 2026-06-28-homepage-icon-events-refinement-design.md"
```

---

## Task 5: Test cases for the broadened guard

**Files:**
- Modify: `test/unit/check-icon-imports.test.ts` (append two cases inside the existing `describe` block, before the closing `});` on line 179)

- [ ] **Step 5.1: Write the two failing cases first (TDD)**

Insert before the closing `});` of the `describe(...)` block (currently line 179 — verify by reading first):

```bash
tail -5 test/unit/check-icon-imports.test.ts
```

Then use Edit to insert. Pick the unique closing context:

```
File: test/unit/check-icon-imports.test.ts

old_string:
    expect(r.stderr).toMatch(/header\.html:1/);
    expect(r.stderr).toMatch(/footer\.html:1/);
  });
});

new_string:
    expect(r.stderr).toMatch(/header\.html:1/);
    expect(r.stderr).toMatch(/footer\.html:1/);
  });

  // The `<ui5-icon name="…">` form (the verb-spine pattern). The original
  // regex only matched `icon="…"` attributes, so the homepage verb-tile
  // icons slipped past the guard and shipped unregistered. These two
  // cases lock in the broadened behaviour.
  it('passes when <ui5-icon name="..."> has a matching import', () => {
    writeFile(root, 'hugo/layouts/partials/homepage/verb-spine.html',
      `<ui5-icon name="learning-assistant"></ui5-icon>\n`);
    writeFile(root, 'hugo/assets/js/ui5-bootstrap.ts',
      `import "@ui5/webcomponents-icons/dist/learning-assistant.js";\n`);
    const r = run(root);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/1 unique icon\(s\) referenced/);
  });

  it('fails when <ui5-icon name="..."> has no matching import', () => {
    writeFile(root, 'hugo/layouts/partials/homepage/verb-spine.html',
      `<ui5-icon name="learning-assistant"></ui5-icon>\n`);
    writeFile(root, 'hugo/assets/js/ui5-bootstrap.ts',
      `import "@ui5/webcomponents-icons/dist/dark-mode.js";\n`);
    const r = run(root);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/icon="learning-assistant" is not imported/);
    expect(r.stderr).toMatch(/verb-spine\.html:1/);
    expect(r.stderr).toMatch(/import "@ui5\/webcomponents-icons\/dist\/learning-assistant\.js"/);
  });
});
```

Note the error message keeps the `icon="…"` shape even though the source was `name="…"` — that's a downstream simplification (existing code emits `icon="${name}"` from the IconUsage record). Confirming this from [check-icon-imports.ts:231](../../../scripts/check-icon-imports.ts#L231): the loop writes `icon="${name}"`, regardless of which regex matched. So the assertion `icon="learning-assistant" is not imported` is correct even for the `<ui5-icon name=...>` form.

- [ ] **Step 5.2: Run just the new cases (they should PASS — Task 4 already shipped the implementation)**

```bash
npx vitest run test/unit/check-icon-imports.test.ts -t "ui5-icon" 2>&1 | tail -15
```

Expected: 2 passing tests under that filter.

This is "test-after-implementation" rather than strict TDD because the implementation landed in Task 4. That's deliberate — Task 4's commit needed to leave the script green-on-live-tree, and the regex addition stands on its own. Treat Task 5 as proving the implementation is correctly scoped (the second case fails on missing-import; the first case passes on present-import).

- [ ] **Step 5.3: Run the full existing test file to confirm no regressions**

```bash
npx vitest run test/unit/check-icon-imports.test.ts 2>&1 | tail -15
```

Expected: all tests pass (9 existing + 2 new = 11 typically).

- [ ] **Step 5.4: Commit**

```bash
git add test/unit/check-icon-imports.test.ts
git -c core.autocrlf=false commit -m "test(build-guard): cases for <ui5-icon name='…'> matching

Two fixture-based cases lock in the regex broadening from the
previous commit:

- Passes when <ui5-icon name='learning-assistant'> has a matching import
- Fails (with correct file:line + suggested fix) when the import is missing

Refs spec 2026-06-28-homepage-icon-events-refinement-design.md"
```

---

## Task 6: EventsBand component test

**Files:**
- Create: `hugo-apps/src/homepage-bands/EventsBand.test.ts`

Matches the convention used by `hugo-apps/src/advocate-profile/App.test.ts` (adjacent to the component, not in a `__tests__/` subdir). The Vitest unit project glob `hugo-apps/src/**/*.test.{js,ts}` (vitest.config.ts:20) picks both patterns up.

- [ ] **Step 6.1: Write the failing test first**

```
File: hugo-apps/src/homepage-bands/EventsBand.test.ts (CREATE)

content:
// @vitest-environment happy-dom

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import EventsBand from './EventsBand.vue';

// Spec: docs/superpowers/specs/2026-06-28-homepage-icon-events-refinement-design.md
//
// Locks in the empty-vs-error split. The combined branch shipped to DEV
// said "Could not load upcoming events" whenever the array was empty,
// even on a clean fetch — so a fresh environment looked broken. These
// tests fail if anyone collapses the two branches back together.

interface EventCard {
  title: string;
  startsAt: string;
  location: string;
  format: string;
  register: string | null;
}

const FALLBACK_LINK_HREF = 'https://community.sap.com/t5/sap-events/ct-p/events';

describe('EventsBand.vue', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('renders four loading skeleton placeholders while the fetch is in flight', async () => {
    // Fetch never resolves during this assertion window — we check
    // the synchronous initial render before any await.
    globalThis.fetch = vi.fn(() => new Promise(() => { /* pending forever */ })) as unknown as typeof globalThis.fetch;

    const wrapper = mount(EventsBand);
    // No flushPromises — we want the loading state.
    const skeletons = wrapper.findAll('.hb-events-band__skel');
    expect(skeletons).toHaveLength(4);
  });

  it('shows "Could not load upcoming events." when the fetch rejects', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('network')) as unknown as typeof globalThis.fetch;

    const wrapper = mount(EventsBand);
    await flushPromises();

    const text = wrapper.text();
    expect(text).toContain('Could not load upcoming events.');
    expect(text).not.toContain('No upcoming events scheduled.');
    expect(wrapper.find(`a[href="${FALLBACK_LINK_HREF}"]`).exists()).toBe(true);
    expect(wrapper.findAll('.hb-events-band__card')).toHaveLength(0);
  });

  it('shows "No upcoming events scheduled." when the fetch returns an empty array', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ value: [] }),
    } as unknown as Response) as unknown as typeof globalThis.fetch;

    const wrapper = mount(EventsBand);
    await flushPromises();

    const text = wrapper.text();
    expect(text).toContain('No upcoming events scheduled.');
    expect(text).not.toContain('Could not load upcoming events.');
    expect(wrapper.find(`a[href="${FALLBACK_LINK_HREF}"]`).exists()).toBe(true);
    expect(wrapper.findAll('.hb-events-band__card')).toHaveLength(0);
  });

  it('renders one card per event with the correct format chip class', async () => {
    const events: EventCard[] = [
      { title: 'SAP Sapphire',  startsAt: '2030-05-15T09:00:00Z', location: 'Orlando',  format: 'in-person', register: 'https://example.test/sapphire' },
      { title: 'Virtual Bytes', startsAt: '2030-06-01T13:00:00Z', location: 'Zoom',     format: 'virtual',   register: null },
      { title: 'TechEd Hybrid', startsAt: '2030-09-20T10:00:00Z', location: 'Barcelona', format: 'hybrid',    register: 'https://example.test/teched' },
    ];
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ value: events }),
    } as unknown as Response) as unknown as typeof globalThis.fetch;

    const wrapper = mount(EventsBand);
    await flushPromises();

    const cards = wrapper.findAll('.hb-events-band__card');
    expect(cards).toHaveLength(3);

    // Verify format → chip-class mapping per EventsBand.vue formatChipClass()
    expect(cards[0].find('.hb-chip--inperson').exists()).toBe(true);
    expect(cards[1].find('.hb-chip--virtual').exists()).toBe(true);
    expect(cards[2].find('.hb-chip--hybrid').exists()).toBe(true);

    // Title + location render
    expect(cards[0].text()).toContain('SAP Sapphire');
    expect(cards[0].text()).toContain('Orlando');

    // Register link present when URL is provided; "Registration TBD" placeholder when null
    expect(cards[0].find('a.hb-events-band__register').attributes('href')).toBe('https://example.test/sapphire');
    expect(cards[1].text()).toContain('Registration TBD');
    expect(cards[2].find('a.hb-events-band__register').attributes('href')).toBe('https://example.test/teched');
  });
});
```

- [ ] **Step 6.2: Run the new test file**

```bash
npx vitest run hugo-apps/src/homepage-bands/EventsBand.test.ts 2>&1 | tail -20
```

Expected: all four tests pass.

If the loading-skeleton test is flaky (e.g. mount() awaits something internally), the fix is to mount with `attachTo: document.body` and inspect before `flushPromises` — but typically a synchronous skeleton render under happy-dom is stable. If still flaky, replace with: `expect(wrapper.html()).toContain('hb-events-band__skel');` which doesn't need the find() pass.

- [ ] **Step 6.3: Run the full unit suite as a final regression check**

```bash
npx vitest run --project unit 2>&1 | tail -30
```

Expected: all tests pass, including the two new check-icon-imports cases and the four new EventsBand cases. Run-time should be under ~60 s.

If anything fails that's unrelated to this PR's changes (memory: `feedback_check_scripts_pool_flake_on_windows`, `feedback_worktree_tests_hang`), retry once. If it fails again, investigate — don't push through flake.

- [ ] **Step 6.4: Commit**

```bash
git add hugo-apps/src/homepage-bands/EventsBand.test.ts
git -c core.autocrlf=false commit -m "test(homepage): EventsBand covers loading/error/empty/populated

Vue Test Utils + happy-dom (already in root devDeps), follows the
hugo-apps/src/advocate-profile/App.test.ts idiom. Four cases:

- Loading state renders 4 skeleton placeholders
- Fetch rejection → 'Could not load upcoming events.' + fallback link
- Empty array → 'No upcoming events scheduled.' + fallback link
- Populated array → one card per event with correct format chip class
  and Register link / TBD placeholder behaviour

Locks in the empty-vs-error split against future regression.

Refs spec 2026-06-28-homepage-icon-events-refinement-design.md"
```

---

## Task 7: Final verification + open PR

**Files:** none (verification + git operations only)

- [ ] **Step 7.1: Confirm worktree is clean**

```bash
git status -sb
```

Expected: `## worktree-homepage-refinement` with no unstaged or untracked files (the spec + 6 implementation commits are all committed).

- [ ] **Step 7.2: Re-run the full guard chain end-to-end**

```bash
npx tsx scripts/check-icon-imports.ts && echo "guard: OK"
npx vitest run test/unit/check-icon-imports.test.ts hugo-apps/src/homepage-bands/EventsBand.test.ts 2>&1 | tail -10
```

Expected: guard prints `OK`; both test files pass entirely.

- [ ] **Step 7.3: Push the branch**

```bash
git push -u origin worktree-homepage-refinement 2>&1 | tail -5
```

- [ ] **Step 7.4: Open the PR**

```bash
gh pr create \
  --title "fix(homepage): register missing icons, refine events empty-state, broaden icon guard" \
  --body "## What

Three coupled fixes for the new developer-portal homepage (#446):

1. **Register missing UI5 icons** — \`learning-assistant\`, \`developer-settings\`, \`chain-link\` were referenced by [verb-spine.html](hugo/layouts/partials/homepage/verb-spine.html) and [header.html](hugo/layouts/partials/header.html) but never imported in [ui5-bootstrap.ts](hugo/assets/js/ui5-bootstrap.ts). UI5 was allocating the icon slot but never painting the glyph — silent UX regression.
2. **Align Build + Connect icons** between verb tiles and the shellbar menu. Tile says \`developer-settings\` for Build; menu was saying \`action\`. Tile says \`customer-and-contacts\` for Connect; menu was saying \`discussion\`. Now matches. \`action\` and \`discussion\` are no longer referenced anywhere in hugo/ or hugo-apps/.
3. **EventsBand empty-vs-error split** — the combined \`v-else-if=\"error || !events.length\"\` rendered \"Could not load upcoming events\" whenever the array was empty, even on a clean fetch. Split into two branches with honest copy.

Also broadens [scripts/check-icon-imports.ts](scripts/check-icon-imports.ts) to match the \`<ui5-icon name=\"…\">\` element form (the verb-spine pattern). The original regex only saw \`icon=\"…\"\` attributes, which is why the verb-tile icons slipped past the guard.

## Why now

Tom flagged it on DEV. Screenshots showed Learn / Build / Integrate tiles + shellbar items with empty icon slots, and the events band reading \"Could not load upcoming events\" against an empty DB.

## Test plan

- \`npx tsx scripts/check-icon-imports.ts\` → exits 0 (verified locally)
- \`npm test\` → all unit tests pass, including 2 new guard cases + 4 new EventsBand cases
- After merge: CI smoke run covers the rest. No deploy from worktree.

## Follow-ups (separate issues)

- #700 Seed events for the EventsBand
- #701 Configure YOUTUBE_API_KEY + Developer News playlist ID for VideoBand
- #702 Verify HomepageShelves seed populated on deployed envs
- #703 Probe community-lane RSS reachability from CF egress
- #704 Configure notifications/alerts for the shellbar bell
- #705 Seed LegacyRedirects from AEM URL set
- #706 Investigate why postbuild:apps icon guard didn't catch this in the deploy that shipped it

## Spec

[2026-06-28-homepage-icon-events-refinement-design.md](docs/superpowers/specs/2026-06-28-homepage-icon-events-refinement-design.md) — approved by spec-document-reviewer on iteration 1." 2>&1 | tail -3
```

The PR URL goes to stdout — capture it and surface to Tom.

- [ ] **Step 7.5: Hand off**

Report to Tom:
- PR URL
- Summary of the seven commits (one per task)
- Reminder that the seven follow-ups (#700–#706) are still owed but tracked
- Pointer to the design spec for review reference

Do NOT deploy from this worktree (memory: `feedback_always_deploy_from_main_primary_tree`). Tom deploys from primary tree on `main` after the PR merges.

---

## Decision log

- **Why imports first, guard-broadening last:** The broadened guard would reject any intermediate commit where verb-spine names lack their imports. Task 1 lands all three needed imports first, so the broadening in Task 4 stays green on live tree.
- **Why test file lives at `hugo-apps/src/homepage-bands/EventsBand.test.ts`, not in a `__tests__/` subdir:** Matches the convention in [hugo-apps/src/advocate-profile/App.test.ts](../../../hugo-apps/src/advocate-profile/App.test.ts) — adjacent file. Both patterns are picked up by the Vitest unit glob `hugo-apps/src/**/*.test.{js,ts}` (vitest.config.ts:20).
- **Why not add the icon imports as one commit and the header.html change as a second:** They're conceptually one refinement (icon consistency) but their commits are clean enough on their own that splitting makes review easier. Each commit leaves the tree in a working state.
- **Why no separate test for the post-Task-2 grep result:** That's a verification step within Task 2, not a permanent regression test. The static guard (which Task 4 broadens) IS the permanent check.

## Out-of-scope reminder

Filed as separate GitHub issues — DO NOT touch in this PR:
- #700 seed events · #701 YouTube config · #702 shelves seed verify · #703 RSS probe · #704 alerts setup · #705 legacy redirects · #706 postbuild bypass investigation
