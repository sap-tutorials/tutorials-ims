# `/browse/` Discovery-Center-style Alternative Homepage — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship an alternative homepage layout at `/browse/` modeled after the SAP Discovery Center IA — left filter rail + curation rails + sortable filterable grid, full Hugo SSR with Vue island hydration — coexisting with the current `/` for an A/B test.

**Architecture:** Three independent PRs in order. PR 1 refactors `TutorialNavigator.vue` to extract a `useNavigatorFilters()` composable + shared card components, with no behavior change. PR 2 adds the `/browse/` Hugo route with Hugo SSR for catalog data and a Vue island that hydrates over it (per-user data CSR). PR 3 wires admin writes to debounced GitHub workflow_dispatch so `/browse/` content stays fresh. Reuses `urlSync.ts` from #195 verbatim; `?sort=` is `/browse/`-only and lives in a small `browseUrl.ts`.

**Tech Stack:** Hugo (static SSR), Vue 3 SFC + Vite (hugo-apps), TypeScript, Vitest + happy-dom + @vue/test-utils, CAP Node.js (srv), GitHub Actions (workflow_dispatch), `@octokit/rest` (already in deps).

**Spec:** [docs/superpowers/specs/2026-06-02-browse-layout-design.md](../specs/2026-06-02-browse-layout-design.md)

**Issue:** [#174](https://github.com/sap-tutorials/tutorials-ims/issues/174) (parent), spec PR [#198](https://github.com/sap-tutorials/tutorials-ims/pull/198)

---

## Pre-flight

This plan assumes:

- You have read the spec.
- You're working in a worktree off `main` (per [[parallel-agents-need-worktrees]]).
- Node ≥ 20 is installed and `npm install` has run (so `better-sqlite3` postinstall completes — see [[npm-ignore-scripts-blocks-native-builds]]).
- You have `cf login` authenticated to the DEV space (only needed for hybrid-mode tests in PR 1 / PR 3 verification).
- You can read but don't need to write to the `sap-tutorials` GitHub org (PR 3's manual smoke uses a fine-grained PAT you'll generate).
- Tests will run via `npm test` — be aware [[worktree-tests-hang]] and cap with hard timeouts if the run sits silently for >2 minutes.

**Branch strategy.** Each PR (1, 2, 3) is its own feature branch off `main`. PR 2 starts from a fresh `main` (after PR 1 merges); PR 3 starts from a fresh `main` (after PR 2 merges). No long-lived integration branch.

---

## PR 1 — Extract `useNavigatorFilters` + Shared Cards

**Goal:** No behavior change on `/`. Move the 1,596-line `TutorialNavigator.vue`'s filter state and card markup into reusable modules. This is the foundation for PR 2.

**Branch:** `refactor/issue-174-extract-navigator-filters`

**Files (PR 1 scope):**

- Create: `hugo-apps/src/shared/composables/useNavigatorFilters.ts`
- Create: `hugo-apps/src/shared/composables/useNavigatorFilters.test.ts`
- Create: `hugo-apps/src/shared/cards/MissionCard.vue`
- Create: `hugo-apps/src/shared/cards/GroupCard.vue`
- Create: `hugo-apps/src/shared/cards/TutorialCard.vue`
- Create: `hugo-apps/src/shared/cards/ProgressOverlay.vue`
- Create: `hugo-apps/src/shared/cards/cards.test.ts`
- Create: `hugo-apps/src/shared/ClientOnly.vue`
- Create: `hugo-apps/src/shared/ClientOnly.test.ts`
- Create: `hugo-apps/src/navigator/__tests__/navigator-regression.test.ts`
- Modify: `hugo-apps/src/navigator/TutorialNavigator.vue` (thin out)

### Task 1.1: Snapshot-lock `displayedItems` for ten filter combinations BEFORE refactoring

This task is the regression-protection safety net for the rest of PR 1. It locks the *current* behavior of the navigator's filtering pipeline so the refactor cannot silently change it.

**Files:**
- Create: `hugo-apps/src/navigator/__tests__/navigator-regression.test.ts`
- Test fixture: `hugo-apps/src/navigator/__tests__/fixtures/sample-tutorials.json` (~30 representative tutorials covering all types/levels/products/topics)

- [ ] **Step 1: Create the test fixture.** Pull a real subset from `/build/navigator` running locally (or copy ~30 entries from `hugo/public/tutorials/_nav.json` if a recent build exists). Save as `hugo-apps/src/navigator/__tests__/fixtures/sample-tutorials.json`. Cover: every level (beginner/intermediate/advanced), at least 3 distinct products, at least one tutorial each in `software-product>sap-build-apps`, `software-product>sap-cloud-application-programming-model`, and `topic>artificial-intelligence`, at least one `tutorial>license` tagged item, at least one `isNew=true` item.

- [ ] **Step 2: Write the regression test stub.** Create `navigator-regression.test.ts` with one `describe.skip` block and ten `it.skip` cases enumerating the filter combinations:

```ts
import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import sample from './fixtures/sample-tutorials.json'

// This file pins the current TutorialNavigator behavior for the ten
// filter combinations below. PR 1 (composable extraction) MUST NOT
// change any of these snapshots. PR 2 (the /browse/ build) is allowed
// to extend the test suite, but cannot weaken any assertion here.

describe('navigator regression — filter combinations', () => {
  it.skip('no filters → all 30 cards', async () => {})
  it.skip('type=mission → only mission cards', async () => {})
  it.skip('type=tutorial + level=beginner → only beginner tutorials', async () => {})
  it.skip('product=sap-build-apps → tutorials tagged sap-build-apps', async () => {})
  it.skip('topic=Artificial Intelligence → AI-tagged items', async () => {})
  it.skip('isNew=true → only items within new-window', async () => {})
  it.skip('noLicense=true → license-tagged items removed', async () => {})
  it.skip('search "cap" → cards whose title/desc/tags include cap', async () => {})
  it.skip('combined: type=tutorial + product=cap + level=beginner', async () => {})
  it.skip('clearFilters → resets to all 30 cards', async () => {})
})
```

- [ ] **Step 3: Implement the first un-skipped test ("no filters → all 30 cards").** Mount the current `TutorialNavigator.vue` with the fixture stubbing both `/build/navigator` and `/tutorials/_nav.json` via `vi.stubGlobal('fetch', ...)`. Wait for `onMounted` async work to settle. Read the rendered card titles from the DOM and assert the count + the first three titles match an expected list.

- [ ] **Step 4: Run the test.** `npx vitest run hugo-apps/src/navigator/__tests__/navigator-regression.test.ts -t "no filters"`. Expect: PASS.

- [ ] **Step 5: Implement the remaining nine tests.** For each: programmatically toggle filters via the rendered `<input type="checkbox">` elements (or directly set `wrapper.vm.filters.X` if the `<script setup>` exposes it via `defineExpose` — if not, drive via `await wrapper.find('input[value="mission"]').setValue(true)`). After each filter change, await `nextTick()` and read the rendered card titles. Assert the rendered set matches the expected pre-refactor set. **Tip:** capture the asserted set as a snapshot via `expect(titles).toMatchInlineSnapshot()` so future refactors produce a clear diff.

- [ ] **Step 6: Run all ten.** `npx vitest run hugo-apps/src/navigator/__tests__/navigator-regression.test.ts`. Expect: 10 PASS.

- [ ] **Step 7: Verify the test catches deliberate breakage.** Temporarily change one line in `TutorialNavigator.vue`'s `filteredItems` computed (e.g. `if (filters.types.length > 0 && !filters.types.includes(item.type))` → swap `!filters.types.includes` to `filters.types.includes`). Re-run the test. Expect: at least 3 tests FAIL. Revert the change. Re-run: 10 PASS.

- [ ] **Step 8: Commit.**

```bash
git add hugo-apps/src/navigator/__tests__/
git commit -m "test(navigator): regression snapshot for ten filter combos (#174)

Pre-refactor snapshot lock. This test pins the current behavior of
TutorialNavigator's filtering pipeline so PR 1's composable
extraction can be verified to introduce no behavior change.

Refs #174 / spec section 'Test plan / Regression protection'"
```

### Task 1.2: Create the `<ClientOnly>` wrapper

Trivial-on-purpose wrapper for CSR-only subtrees. Used in PR 1 by `<ProgressOverlay>` so progress rings don't render during SSR. Spec section "Hydration boundary / `<ClientOnly>` implementation note".

**Files:**
- Create: `hugo-apps/src/shared/ClientOnly.vue`
- Create: `hugo-apps/src/shared/ClientOnly.test.ts`

- [ ] **Step 1: Write the failing test.**

```ts
// hugo-apps/src/shared/ClientOnly.test.ts
import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import { renderToString } from 'vue/server-renderer'
import { createSSRApp, h } from 'vue'
import ClientOnly from './ClientOnly.vue'

describe('<ClientOnly>', () => {
  it('renders nothing in SSR', async () => {
    const html = await renderToString(createSSRApp({
      render: () => h(ClientOnly, null, { default: () => h('span', 'should-not-ssr') }),
    }))
    expect(html).not.toContain('should-not-ssr')
  })

  it('renders slot after onMounted on the client', async () => {
    const wrapper = mount(ClientOnly, {
      slots: { default: '<span>visible-after-mount</span>' },
    })
    // happy-dom synchronously fires onMounted; flush microtasks.
    await wrapper.vm.$nextTick()
    expect(wrapper.html()).toContain('visible-after-mount')
  })
})
```

- [ ] **Step 2: Run the test to verify it fails.** `npx vitest run hugo-apps/src/shared/ClientOnly.test.ts`. Expect: FAIL (file does not exist).

- [ ] **Step 3: Implement `ClientOnly.vue`.**

```vue
<!-- hugo-apps/src/shared/ClientOnly.vue
     Renders its slot only after the component has mounted on the
     client. During SSR (renderToString), the slot is not rendered.
     This is the "<ClientOnly>" pattern from Nuxt/VitePress, written
     trivially so vanilla Vue 3 (createSSRApp) can use it without a
     framework dependency.
-->
<script setup lang="ts">
import { onMounted, ref } from 'vue'
const mounted = ref(false)
onMounted(() => { mounted.value = true })
</script>

<template>
  <slot v-if="mounted" />
</template>
```

- [ ] **Step 4: Run the test to verify it passes.** `npx vitest run hugo-apps/src/shared/ClientOnly.test.ts`. Expect: 2 PASS.

- [ ] **Step 5: Commit.**

```bash
git add hugo-apps/src/shared/ClientOnly.vue hugo-apps/src/shared/ClientOnly.test.ts
git commit -m "feat(shared): add ClientOnly wrapper for CSR-only subtrees (#174)

Vanilla Vue 3 doesn't ship <ClientOnly>. This 10-line wrapper covers
the same use case for the /browse/ SSR work in PR 2, and is reused
by ProgressOverlay in PR 1.

Refs #174"
```

### Task 1.3: Extract `<ProgressOverlay>` from inline `<ProgressRing>` usage

Today, `TutorialNavigator.vue` renders progress directly inline (line 881-885: `<ProgressRing v-if="cardProgress(item, progress)" ...>`). This task moves that into a tiny standalone component that takes `{ item, progress }` and handles both the conditional render and the `<ClientOnly>` boundary. No `/`-visible change.

**Files:**
- Create: `hugo-apps/src/shared/cards/ProgressOverlay.vue`
- Create: `hugo-apps/src/shared/cards/cards.test.ts` (will grow with later tasks)

- [ ] **Step 1: Write the failing test.**

```ts
// hugo-apps/src/shared/cards/cards.test.ts
import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import { renderToString } from 'vue/server-renderer'
import { createSSRApp, h } from 'vue'
import ProgressOverlay from './ProgressOverlay.vue'
import { emptyProgress, type ProgressPayload } from '../../navigator/cardProgress'
import type { CardItem } from '@shared/types'

const tutorialItem: CardItem = {
  type: 'tutorial', id: 't1', title: 'A', description: '', time: 5, level: 'beginner',
  tutorialCount: 1, primaryTag: '', displayTags: [], displayTagSlugs: [],
  href: '/tutorials/a', stepCount: 3,
}

describe('<ProgressOverlay>', () => {
  it('renders nothing during SSR even when progress is set', async () => {
    const progress: ProgressPayload = { ...emptyProgress(), tutorials: { a: { stepIndex: 1, total: 3 } } }
    const html = await renderToString(createSSRApp({
      render: () => h(ProgressOverlay, { item: tutorialItem, progress }),
    }))
    expect(html).not.toContain('progress-ring')
  })

  it('renders progress ring on the client when progress exists', async () => {
    const progress: ProgressPayload = { ...emptyProgress(), tutorials: { a: { stepIndex: 1, total: 3 } } }
    const wrapper = mount(ProgressOverlay, { props: { item: { ...tutorialItem, id: 'a', href: '/tutorials/a' }, progress } })
    await wrapper.vm.$nextTick()
    expect(wrapper.find('.nav-card__progress').exists()).toBe(true)
  })

  it('renders nothing when there is no progress for this item', async () => {
    const wrapper = mount(ProgressOverlay, { props: { item: tutorialItem, progress: emptyProgress() } })
    await wrapper.vm.$nextTick()
    expect(wrapper.find('.nav-card__progress').exists()).toBe(false)
  })
})
```

- [ ] **Step 2: Run the test, verify it fails.** Expect: FAIL (component does not exist).

- [ ] **Step 3: Implement `ProgressOverlay.vue`.**

```vue
<!-- hugo-apps/src/shared/cards/ProgressOverlay.vue
     CSR-only progress decoration on a card. SSR renders nothing;
     client mounts the ring after onMounted. Used by all three
     shared card components (Mission/Group/Tutorial).
-->
<script setup lang="ts">
import { computed } from 'vue'
import ClientOnly from '../ClientOnly.vue'
import ProgressRing from '../ProgressRing.vue'
import { cardProgress, type ProgressPayload } from '../../navigator/cardProgress'
import type { CardItem } from '@shared/types'

const props = defineProps<{
  item: CardItem
  progress: ProgressPayload
}>()

const ringProps = computed(() => cardProgress(props.item, props.progress))
</script>

<template>
  <ClientOnly>
    <ProgressRing
      v-if="ringProps"
      class="nav-card__progress nav-card__progress--animate-in"
      v-bind="ringProps"
    />
  </ClientOnly>
</template>
```

The `nav-card__progress--animate-in` class is added here for the spec's "animated draw-in on hydration" requirement (decision #13). The CSS for it lands in PR 2 (`hugo/assets/css/browse.css`). PR 1 ships the marker class but no animation; the existing static look is preserved.

- [ ] **Step 4: Run the test, verify it passes.** Expect: 3 PASS.

- [ ] **Step 5: Commit.**

```bash
git add hugo-apps/src/shared/cards/
git commit -m "feat(shared): extract ProgressOverlay for CSR-only progress (#174)

Wraps the existing ProgressRing in a ClientOnly boundary so SSR'd
cards on /browse/ render without progress decoration; the ring
animates in after hydration. Marker class for the animation lands
in PR 1; the actual @keyframes lands with the rest of /browse/'s
CSS in PR 2.

Refs #174"
```

### Task 1.4: Extract `<TutorialCard>` shared component

Move the `<a class="nav-card">` block (currently lines 870-916 of `TutorialNavigator.vue`) into a standalone component for `type: 'tutorial'` items. The other two types share the same outer markup but differ in the meta row (no "X tutorials" sub-line); we'll handle them in their own tasks.

**Files:**
- Create: `hugo-apps/src/shared/cards/TutorialCard.vue`
- Modify: `hugo-apps/src/shared/cards/cards.test.ts` (add tests)

- [ ] **Step 1: Add the test for TutorialCard.**

```ts
// Append to hugo-apps/src/shared/cards/cards.test.ts
import TutorialCard from './TutorialCard.vue'

describe('<TutorialCard>', () => {
  const tut: CardItem = {
    type: 'tutorial', id: 'cap-getting-started', title: 'CAP Getting Started',
    description: 'Build a CAP service in 30 min',
    time: 30, level: 'beginner', tutorialCount: 1, primaryTag: 'cap',
    displayTags: ['CAP'], displayTagSlugs: ['software-product>sap-cloud-application-programming-model'],
    href: '/tutorials/cap-getting-started', stepCount: 5, isNew: true,
  }

  it('renders title, description, level, time', () => {
    const w = mount(TutorialCard, { props: { item: tut, progress: emptyProgress() } })
    expect(w.text()).toContain('CAP Getting Started')
    expect(w.text()).toContain('Build a CAP service in 30 min')
    expect(w.text()).toContain('Beginner')
    expect(w.text()).toContain('30')
  })

  it('renders the NEW badge when isNew is true', () => {
    const w = mount(TutorialCard, { props: { item: tut, progress: emptyProgress() } })
    expect(w.find('.nav-card__new-badge').exists()).toBe(true)
  })

  it('omits the NEW badge when isNew is false', () => {
    const w = mount(TutorialCard, { props: { item: { ...tut, isNew: false }, progress: emptyProgress() } })
    expect(w.find('.nav-card__new-badge').exists()).toBe(false)
  })

  it('SSR renders without the progress ring even when progress exists', async () => {
    const progress: ProgressPayload = { ...emptyProgress(), tutorials: { 'cap-getting-started': { stepIndex: 2, total: 5 } } }
    const html = await renderToString(createSSRApp({
      render: () => h(TutorialCard, { item: tut, progress }),
    }))
    expect(html).toContain('CAP Getting Started')          // chrome SSRs
    expect(html).not.toContain('nav-card__progress')        // ring does not
  })

  it('href maps to /tutorials/<slug>', () => {
    const w = mount(TutorialCard, { props: { item: tut, progress: emptyProgress() } })
    expect(w.attributes('href')).toBe('/tutorials/cap-getting-started')
  })
})
```

- [ ] **Step 2: Run the test, verify it fails.** Expect: FAIL (component does not exist).

- [ ] **Step 3: Implement `TutorialCard.vue`.** Copy the markup from `TutorialNavigator.vue:870-916` verbatim, swap the outer `v-for` loop to a single `<a>`, swap inline `<ProgressRing>` for `<ProgressOverlay>`, swap inline `<LicenseIcon v-if="requiresLicense(item)">` for the same expression but importing from `../license`. Preserve `data-vt-card="navigator"` (the view-transition marker is shared across both surfaces). Keep all class names byte-identical so existing CSS continues to apply.

```vue
<!-- hugo-apps/src/shared/cards/TutorialCard.vue
     Tutorial card variant. Shared between the / navigator and /browse/.
     Markup migrated from TutorialNavigator.vue:870-916 (verbatim, no
     CSS drift permitted). Per-user state (progress, completed badge)
     is delegated to ProgressOverlay which gates itself on hydration.
-->
<script setup lang="ts">
import type { CardItem } from '@shared/types'
import type { ProgressPayload } from '../../navigator/cardProgress'
import { cardProgress } from '../../navigator/cardProgress'
import { requiresLicense } from '../license'
import LicenseIcon from '../LicenseIcon.vue'
import ProgressOverlay from './ProgressOverlay.vue'

const props = defineProps<{
  item: CardItem
  progress: ProgressPayload
}>()

const TYPE_LABEL = 'Tutorial'

function capitalizeLevel(l: string) { return l.charAt(0).toUpperCase() + l.slice(1) }
function formatTime(min: number) { return `${min} min` }
</script>

<template>
  <a
    :href="item.href"
    class="nav-card"
    data-vt-card="navigator"
    :class="{
      'nav-card--new': item.isNew,
      'nav-card--has-progress': !!cardProgress(item, progress),
    }"
  >
    <ProgressOverlay :item="item" :progress="progress" />
    <span v-if="item.isNew" class="nav-card__new-badge" aria-label="New tutorial">NEW</span>
    <LicenseIcon v-if="requiresLicense(item)" class="nav-card__license" />
    <div class="nav-card__type nav-card__type--tutorial">{{ TYPE_LABEL }}</div>
    <h3 class="nav-card__title">{{ item.title }}</h3>
    <p class="nav-card__desc">{{ item.description }}</p>
    <div class="nav-card__meta">
      <span class="nav-card__meta-item">
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M2 13V3h4l2 2h6v8H2z"/></svg>
        {{ capitalizeLevel(item.level) }}
      </span>
      <span class="nav-card__meta-sep">&middot;</span>
      <span class="nav-card__meta-item">
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><circle cx="8" cy="8" r="6.5"/><path d="M8 4.5V8l2.5 1.5"/></svg>
        {{ formatTime(item.time) }}
      </span>
    </div>
  </a>
</template>
```

- [ ] **Step 4: Run the test, verify it passes.** Expect: 5 PASS.

- [ ] **Step 5: Commit.**

```bash
git add hugo-apps/src/shared/cards/TutorialCard.vue hugo-apps/src/shared/cards/cards.test.ts
git commit -m "feat(shared): extract TutorialCard component (#174)

Markup migrated verbatim from TutorialNavigator.vue:870-916 with
ProgressRing → ProgressOverlay swap. No CSS drift; class names
byte-identical so existing styles continue to apply on /.

Refs #174"
```

### Task 1.5: Extract `<MissionCard>` and `<GroupCard>` shared components

Mission and Group cards share the same outer markup as Tutorial but include a `tutorialCount` line in the meta row and use a different `nav-card__type--*` modifier.

**Files:**
- Create: `hugo-apps/src/shared/cards/MissionCard.vue`
- Create: `hugo-apps/src/shared/cards/GroupCard.vue`
- Modify: `hugo-apps/src/shared/cards/cards.test.ts`

- [ ] **Step 1: Add tests for both.**

```ts
// Append to hugo-apps/src/shared/cards/cards.test.ts
import MissionCard from './MissionCard.vue'
import GroupCard from './GroupCard.vue'

describe('<MissionCard>', () => {
  const m: CardItem = {
    type: 'mission', id: 'mission-1', title: 'Build with CAP',
    description: 'Full-stack mission', time: 240, level: 'intermediate',
    tutorialCount: 8, primaryTag: 'cap', displayTags: ['CAP'],
    displayTagSlugs: ['software-product>sap-cloud-application-programming-model'],
    href: '/tutorials/mission-build-with-cap', stepCount: 40,
  }
  it('renders type label "Mission"', () => {
    const w = mount(MissionCard, { props: { item: m, progress: emptyProgress() } })
    expect(w.find('.nav-card__type').text()).toBe('Mission')
  })
  it('shows tutorial count in meta', () => {
    const w = mount(MissionCard, { props: { item: m, progress: emptyProgress() } })
    expect(w.text()).toContain('8 Tutorials')
  })
})

describe('<GroupCard>', () => {
  const g: CardItem = {
    type: 'group', id: 'group-1', title: 'CAP Basics',
    description: 'Three tutorials', time: 90, level: 'beginner',
    tutorialCount: 3, primaryTag: 'cap', displayTags: [], displayTagSlugs: [],
    href: '/tutorials/group-cap-basics', stepCount: 12,
  }
  it('renders type label "Group"', () => {
    const w = mount(GroupCard, { props: { item: g, progress: emptyProgress() } })
    expect(w.find('.nav-card__type').text()).toBe('Group')
  })
  it('shows tutorial count in meta', () => {
    const w = mount(GroupCard, { props: { item: g, progress: emptyProgress() } })
    expect(w.text()).toContain('3 Tutorials')
  })
})
```

- [ ] **Step 2: Run, verify they fail.**

- [ ] **Step 3: Implement `MissionCard.vue` and `GroupCard.vue`.** Copy `TutorialCard.vue` and change: (a) `TYPE_LABEL` constant, (b) `nav-card__type--*` modifier, (c) add the `<template v-if="item.tutorialCount">` clause for the "N Tutorials" meta line (matching `TutorialNavigator.vue:906-909`), (d) the type-specific card never has `isNew` so drop the `--new` class and the badge span, (e) drop license icon (mission/group cards don't carry license). Reuse the same `<ProgressOverlay>`.

- [ ] **Step 4: Run all card tests.** `npx vitest run hugo-apps/src/shared/cards/`. Expect: ≥9 PASS (3 ProgressOverlay + 5 Tutorial + 2 Mission + 2 Group + any others added).

- [ ] **Step 5: Commit.**

```bash
git add hugo-apps/src/shared/cards/MissionCard.vue hugo-apps/src/shared/cards/GroupCard.vue hugo-apps/src/shared/cards/cards.test.ts
git commit -m "feat(shared): extract MissionCard and GroupCard components (#174)

Same outer markup as TutorialCard with type-specific meta: 'Mission' /
'Group' labels and 'N Tutorials' count line. No isNew/license treatment
on these types (matches TutorialNavigator.vue today).

Refs #174"
```

### Task 1.6: Build `useNavigatorFilters` composable

Extract the reactive filter state, the URL-sync watcher, the `currentNavState()` helper, and the filtering computeds (`filteredItems`, `displayedItems`, `counts`, etc.) from `TutorialNavigator.vue` into a single composable. The composable accepts `allCards` as a `Ref` so it works with both data sources (`/`'s `/build/navigator` fetch and `/browse/`'s SSR-injected list).

**Files:**
- Create: `hugo-apps/src/shared/composables/useNavigatorFilters.ts`
- Create: `hugo-apps/src/shared/composables/useNavigatorFilters.test.ts`

- [ ] **Step 1: Write the failing test for the composable's contract.**

```ts
// hugo-apps/src/shared/composables/useNavigatorFilters.test.ts
import { describe, expect, it } from 'vitest'
import { ref, nextTick } from 'vue'
import { useNavigatorFilters } from './useNavigatorFilters'
import type { CardItem } from '@shared/types'

const cards: CardItem[] = [
  { type: 'mission', id: 'm1', title: 'M1', description: '', time: 60, level: 'beginner', tutorialCount: 3, primaryTag: '', displayTags: [], displayTagSlugs: ['software-product>sap-build-apps'], href: '/x', stepCount: 6 },
  { type: 'tutorial', id: 't1', title: 'T1 cap', description: '', time: 30, level: 'beginner', tutorialCount: 1, primaryTag: '', displayTags: ['CAP'], displayTagSlugs: ['software-product>sap-cloud-application-programming-model'], href: '/x', stepCount: 3 },
  { type: 'tutorial', id: 't2', title: 'T2', description: '', time: 30, level: 'advanced', tutorialCount: 1, primaryTag: '', displayTags: [], displayTagSlugs: ['software-product>sap-build-apps'], href: '/x', stepCount: 2 },
]

describe('useNavigatorFilters', () => {
  it('returns all cards when no filters active', () => {
    const allCards = ref(cards)
    const { displayedItems } = useNavigatorFilters({ allCards })
    expect(displayedItems.value.length).toBe(3)
  })

  it('filters by type', async () => {
    const allCards = ref(cards)
    const f = useNavigatorFilters({ allCards })
    f.filters.types = ['mission']
    await nextTick()
    expect(f.displayedItems.value.map(c => c.id)).toEqual(['m1'])
  })

  it('filters by level (case-insensitive on read)', async () => {
    const allCards = ref(cards)
    const f = useNavigatorFilters({ allCards })
    f.filters.levels = ['advanced']
    await nextTick()
    expect(f.displayedItems.value.map(c => c.id)).toEqual(['t2'])
  })

  it('filters by product slug', async () => {
    const allCards = ref(cards)
    const f = useNavigatorFilters({ allCards })
    f.filters.products = ['software-product>sap-cloud-application-programming-model']
    await nextTick()
    expect(f.displayedItems.value.map(c => c.id)).toEqual(['t1'])
  })

  it('search "cap" matches title containing cap', async () => {
    const allCards = ref(cards)
    const f = useNavigatorFilters({ allCards })
    f.searchQuery.value = 'cap'
    await nextTick()
    expect(f.displayedItems.value.map(c => c.id)).toEqual(['t1'])
  })

  it('clearFilters resets every dimension and currentPage to 1', async () => {
    const allCards = ref(cards)
    const f = useNavigatorFilters({ allCards })
    f.filters.types = ['mission']
    f.searchQuery.value = 'foo'
    f.currentPage.value = 3
    f.clearFilters()
    await nextTick()
    expect(f.filters.types).toEqual([])
    expect(f.searchQuery.value).toBe('')
    expect(f.currentPage.value).toBe(1)
    expect(f.displayedItems.value.length).toBe(3)
  })

  it('hasActiveFilters reflects any non-default state', async () => {
    const allCards = ref(cards)
    const f = useNavigatorFilters({ allCards })
    expect(f.hasActiveFilters.value).toBe(false)
    f.filters.types = ['mission']
    expect(f.hasActiveFilters.value).toBe(true)
    f.clearFilters()
    expect(f.hasActiveFilters.value).toBe(false)
  })

  it('sort=recent orders by createdAt desc when enableSort=true and items have createdAt', async () => {
    const dated: CardItem[] = [
      { ...cards[0], id: 'old', createdAt: '2024-01-01T00:00:00Z' as any },
      { ...cards[1], id: 'new', createdAt: '2026-01-01T00:00:00Z' as any },
    ]
    const allCards = ref(dated)
    const f = useNavigatorFilters({ allCards, enableSort: true })
    f.sort.value = 'recent'
    await nextTick()
    expect(f.displayedItems.value.map(c => c.id)).toEqual(['new', 'old'])
  })
})
```

- [ ] **Step 2: Run the test, verify it fails.** Expect: FAIL (composable does not exist).

- [ ] **Step 3: Implement `useNavigatorFilters.ts`.** Move the relevant blocks from `TutorialNavigator.vue` (filter state, `currentNavState`, URL sync watcher, `filteredItems`, `paginatedItems`, `displayedItems`, `counts`, `clearFilters`, `hasActiveFilters`, the pagination-reset watcher). Add an optional `enableSort` arg + a `sort` ref + a sorted-items step in front of pagination. Keep the `useSearch` integration so `searchMode`-based behavior still works on `/`.

The composable signature:

```ts
import { ref, reactive, computed, watch, nextTick, onMounted, onScopeDispose, type Ref } from 'vue'
import { useSearch, MIN_SEARCH_CHARS, type SearchableItem } from '../../navigator/useSearch'
import { parseNavState, writeNavStateToWindow, EMPTY_STATE, type NavState } from '../../navigator/urlSync'
import { parseTagParams, parseLevelParams } from '../../navigator/url-params'
import { isWithinNewWindow } from '../freshness'
import { requiresLicense } from '../license'
import { cardProgress, emptyProgress, toLookup, type ProgressPayload } from '../../navigator/cardProgress'
import type { CardItem, TutorialEntry } from '@shared/types'

export type Sort = 'relevance' | 'updated' | 'recent' | 'title' | 'time'

export interface UseNavigatorFiltersOptions {
  allCards: Ref<CardItem[]>
  /** Optional: when present, used by useSearch for server-search path. */
  tutorials?: Ref<TutorialEntry[]>
  /** When true, expose the `sort` ref + sorted output. Defaults false. */
  enableSort?: boolean
  /** When true, attach URL-sync watcher + read URL on mount. Defaults true. */
  syncURL?: boolean
  /** Page size. Defaults 48 (matches navigator); /browse/ overrides to 24. */
  pageSize?: number
}

export function useNavigatorFilters(opts: UseNavigatorFiltersOptions) {
  // … (move all the relevant logic from TutorialNavigator.vue here)
  // Return: { searchQuery, filters, currentPage, sort, totalPages,
  //   displayedItems, displayedTotalCount, displayedCounts,
  //   hasActiveFilters, paginatorPages, goToPage, clearFilters,
  //   currentNavState, scheduleURLSync, ... }
}
```

For sort comparators, implement five functions:

```ts
const SORT_COMPARATORS: Record<Sort, (a: CardItem, b: CardItem) => number> = {
  relevance: () => 0,                                              // identity (catalog order)
  updated:   (a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''),
  recent:    (a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''),
  title:     (a, b) => a.title.localeCompare(b.title),
  time:      (a, b) => (a.time ?? 0) - (b.time ?? 0),
}
```

`updatedAt` and `createdAt` must be added as optional fields on `CardItem` in `@shared/types` (a small type extension — note that the navigator's `allCards` builder already populates `isNew` from `createdAt` for tutorial items, so the field reaches the composable today; mission/group items will get `null` and naturally fall to the bottom of recent/updated sorts which is acceptable).

- [ ] **Step 4: Run the test, verify it passes.** Expect: 8 PASS.

- [ ] **Step 5: Commit.**

```bash
git add hugo-apps/src/shared/composables/
git commit -m "feat(shared): extract useNavigatorFilters composable (#174)

Reactive filter state + URL sync + filtering pipeline + pagination +
optional sort, all in one composable. Accepts allCards as a ref so
both / (CSR) and /browse/ (SSR-injected) can consume it. URL sync
delegates to urlSync.ts (#195) verbatim; sort is opt-in via
enableSort and reads/writes ?sort= via browseUrl.ts (added in PR 2).

Refs #174"
```

### Task 1.7: Rewire `TutorialNavigator.vue` to consume the extracted modules

Now that the composable and shared cards exist, rewrite `TutorialNavigator.vue` to use them. The visible behavior on `/` MUST stay identical — the snapshot test from Task 1.1 is the gate.

**Files:**
- Modify: `hugo-apps/src/navigator/TutorialNavigator.vue`

- [ ] **Step 1: Verify Task 1.1 snapshot tests still pass against the unchanged file.** `npx vitest run hugo-apps/src/navigator/__tests__/navigator-regression.test.ts`. Expect: 10 PASS. (If they fail, something earlier broke and we don't want to layer the rewrite on top.)

- [ ] **Step 2: Replace filter state + URL sync + filtering computed blocks with `useNavigatorFilters` call.** Lines 17-67 + 394-685 of `TutorialNavigator.vue` collapse to:

```ts
import { useNavigatorFilters } from '@shared/composables/useNavigatorFilters'

const tutorials = ref<TutorialEntry[]>([])
const missionsMeta = ref<MissionRef[]>([])
const groupsMeta = ref<GroupRef[]>([])
// allCards builder stays in this SFC because it depends on missionsMeta/groupsMeta which are
// /-specific (loaded from /build/navigator). On /browse/ allCards comes pre-built from SSR.
const allCards = computed<CardItem[]>(() => { /* unchanged from existing 394-476 */ })

const {
  searchQuery, filters, currentPage, totalPages,
  displayedItems, displayedTotalCount, displayedCounts,
  hasActiveFilters, paginatorPages, goToPage, clearFilters,
  filtersOpen, productSearch, topicSearch,
  filteredProducts, filteredTopics,    // moved into composable too
  searchMode, isSubThreshold, isSearching, searchError,
  progress, progressLoaded,
  toggleFilter,
} = useNavigatorFilters({
  allCards,
  tutorials,                            // for useSearch enrichment
  // enableSort omitted — / has no sort UI today
})
```

- [ ] **Step 3: Replace the inline `<a class="nav-card">` v-for block (lines 870-916) with a switch over the three card components.**

```vue
<template v-for="item in displayedItems" :key="item.id">
  <MissionCard  v-if="item.type === 'mission'"  :item="item" :progress="progress" />
  <GroupCard    v-else-if="item.type === 'group'" :item="item" :progress="progress" />
  <TutorialCard v-else-if="item.type === 'tutorial'" :item="item" :progress="progress" />
</template>
```

Add the imports at the top of `<script setup>`.

- [ ] **Step 4: Run the snapshot test.** `npx vitest run hugo-apps/src/navigator/__tests__/navigator-regression.test.ts`. Expect: 10 PASS. **If any snapshot fails, the refactor introduced a behavior change — diff the failing snapshot, identify the drift, fix the composable or the SFC, do not update the snapshot to match.**

- [ ] **Step 5: Run all hugo-apps tests.** `npx vitest run hugo-apps/`. Expect: every pre-existing test still passes (`useSearch.test.ts`, `urlSync.test.ts`, `cardProgress.test.ts`, `TutorialNavigator.test.ts`, `url-params.test.ts`, etc.) plus the new ones from Tasks 1.2-1.6 plus 1.7's snapshot.

- [ ] **Step 6: Run a Hugo build smoke check.** `npm run fetch-tutorials && npm run build:all`. Expect: build succeeds, `hugo/public/index.html` contains `id="tutorial-navigator"` mount point as before, no console errors in the build output.

- [ ] **Step 7: Manual local-dev smoke.** `npm run dev` (Hugo) + `cds watch` (CAP) + `npm run start:approuter`. Open http://localhost:5000/ in a browser. Verify: filter chips render, clicking "Mission" filters cards, search "cap" returns matches, clicking "Clear all filters" resets, URL updates per `urlSync` (`?type=mission` etc.). Visual: no layout shift, no flicker, no missing icons. **If any of these are off, fix before committing.**

- [ ] **Step 8: Commit.**

```bash
git add hugo-apps/src/navigator/TutorialNavigator.vue
git commit -m "refactor(navigator): consume useNavigatorFilters + shared cards (#174)

TutorialNavigator.vue thinned: filter state + filtering pipeline +
pagination delegated to useNavigatorFilters; <a class=\"nav-card\">
v-for replaced with a 3-way switch over MissionCard/GroupCard/
TutorialCard. The 10-combo navigator-regression snapshot stays
green: zero behavior change on /.

Refs #174"
```

### Task 1.8: Open PR 1

- [ ] **Step 1: Verify branch is correct.** `git branch --show-current`. Expect: `refactor/issue-174-extract-navigator-filters`. ([[verify-branch-before-commit]])

- [ ] **Step 2: Push branch.** `git push -u origin refactor/issue-174-extract-navigator-filters`.

- [ ] **Step 3: Open PR via gh.**

```bash
gh pr create --repo sap-tutorials/tutorials-ims --base main \
  --title "refactor(navigator): extract useNavigatorFilters + shared card components (#174)" \
  --body "$(cat <<'EOF'
PR 1 of 3 implementing the spec in #198.

## What

- Extract `useNavigatorFilters()` composable from \`TutorialNavigator.vue\`.
- Extract `<MissionCard>`, `<GroupCard>`, `<TutorialCard>` shared components.
- Extract `<ProgressOverlay>` (CSR-only progress decoration via `<ClientOnly>`).
- Add `<ClientOnly>` wrapper for vanilla Vue 3.
- Add navigator-regression snapshot test pinning ten filter combinations to current behavior.

## What this is NOT

- Not /browse/. That's PR 2 of 3.
- Not a behavior change on /. The regression test gates it.

## Verification

- [x] \`npx vitest run hugo-apps/\` passes
- [x] Navigator regression snapshot (10 cases) passes
- [x] \`npm run build:all\` succeeds
- [x] Manual smoke on local dev: / filters, search, clear-all all work as before

Refs #174 / spec #198
EOF
)"
```

- [ ] **Step 4: Capture PR number** for #174 task-list update later.

---

## PR 2 — `/browse/` SSR + Vue Hydration

**Goal:** Ship `/browse/` reachable at the deployed approuter with SSR rails+grid and Vue hydration, surfaced via a pill on `/` and a shellbar item. PR 2 only — no admin-write rebuild trigger yet (PR 3).

**Branch:** `feat/issue-174-browse-ssr` — start from a fresh `main` after PR 1 merges.

**Files (PR 2 scope):**

- Create: `hugo/data/.gitignore` (one-line, ignore `browse.json`)
- Create: `hugo/content/browse/_index.md`
- Create: `hugo/layouts/browse/list.html`
- Create: `hugo/layouts/browse/_partials/card-mission.html`
- Create: `hugo/layouts/browse/_partials/card-group.html`
- Create: `hugo/layouts/browse/_partials/card-tutorial.html`
- Create: `hugo/layouts/browse/_partials/rail.html`
- Create: `hugo/layouts/browse/_partials/filter-rail.html`
- Create: `hugo/assets/css/browse.css`
- Create: `hugo-apps/src/browse/main.ts`
- Create: `hugo-apps/src/browse/BrowsePage.vue`
- Create: `hugo-apps/src/browse/BrowseFilterRail.vue`
- Create: `hugo-apps/src/browse/BrowseRail.vue`
- Create: `hugo-apps/src/browse/BrowseSortDropdown.vue`
- Create: `hugo-apps/src/browse/BrowseGrid.vue`
- Create: `hugo-apps/src/browse/browseUrl.ts`
- Create: `hugo-apps/src/browse/__tests__/browseUrl.test.ts`
- Create: `hugo-apps/src/browse/__tests__/BrowsePage.hydration.test.ts`
- Create: `hugo-apps/src/browse/__tests__/card-template-parity.test.ts`
- Modify: `scripts/fetch-tutorials.ts` (add `writeBrowseData()`)
- Modify: `hugo-apps/vite.config.ts` (add `browse` entry)
- Modify: `hugo/layouts/index.html` (add pill on `/`)
- Modify: `hugo/layouts/partials/header.html` (add shellbar Browse item — verify exact path)
- Modify: `approuter/xs-app.json` (add `/browse/` route if needed — verify; Hugo static route may already cover it)
- Modify: `test/smoke/*.test.ts` (add `/browse/` smoke checks)
- Modify: `.gitignore` (already ignores `hugo/data/browse.json` via the sub-`.gitignore`; verify)

### Task 2.1: Add `writeBrowseData()` to `fetch-tutorials.ts`

**Files:**
- Modify: `scripts/fetch-tutorials.ts`
- Create: `hugo/data/.gitignore`

- [ ] **Step 1: Add the gitignore.** `echo 'browse.json' > hugo/data/.gitignore`. (`hugo/data/image_dimensions.json` and `hugo/data/glossary.yaml` are checked in; `browse.json` is build-time-generated and should not be.)

- [ ] **Step 2: Locate the catalog-loaded block in `fetch-tutorials.ts`.** Around line 750-780, after `missions = catalog.missions / hierarchies = catalog.hierarchies / standaloneGroups = catalog.standaloneGroups` is set, AND after `coCompletions` is fetched, AND after the `navEntries` loop (~line 783-840) populates `missionId` / `groupId` etc. on each tutorial — that loop builds `navEntries` which the navigator currently consumes via `/build/navigator`. We need the same enriched data shape for `/browse/`'s SSR.

- [ ] **Step 3: Add a `writeBrowseData(navEntries, missions, missionsMeta, groupsMeta)` helper at the bottom of `fetch-tutorials.ts`.**

```ts
import { writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __scriptDir = dirname(__filename)
const HUGO_DATA_DIR = join(__scriptDir, '..', 'hugo', 'data')
const BROWSE_DATA_FILE = join(HUGO_DATA_DIR, 'browse.json')

interface BrowseCardItem {
  type: 'mission' | 'group' | 'tutorial'
  id: string
  title: string
  description: string
  time: number
  level: 'beginner' | 'intermediate' | 'advanced'
  tutorialCount: number
  primaryTag: string
  displayTags: string[]
  displayTagSlugs: string[]
  href: string
  stepCount: number
  isNew?: boolean
  createdAt?: string
  updatedAt?: string
}

interface BrowseData {
  all: BrowseCardItem[]
  featured: string[]      // mission card ids in display order (first N)
  recent: string[]        // tutorial card ids by createdAt desc (first N)
  buildAt: string
}

const FEATURED_MAX = 10
const RECENT_MAX = 10

function writeBrowseData(
  navEntries: TutorialEntry[],
  missions: Mission[],
  hierarchies: MissionHierarchy[],
  standaloneGroups: StandaloneGroup[],
): void {
  // Reuse the same allCards-builder logic that TutorialNavigator's allCards
  // computed uses, but inlined here at build time. Generates mission cards,
  // group cards, and tutorial cards from the enriched navEntries + catalog.
  // Keep this builder in sync with hugo-apps/src/navigator/TutorialNavigator.vue's
  // allCards computed; the card-template-parity test catches drift.
  const all: BrowseCardItem[] = buildAllCards(navEntries, missions, hierarchies, standaloneGroups)

  // Featured: first FEATURED_MAX mission cards, in catalog order.
  const featured = all.filter(c => c.type === 'mission').slice(0, FEATURED_MAX).map(c => c.id)

  // Recent: top RECENT_MAX tutorial cards by createdAt desc.
  const recent = all
    .filter(c => c.type === 'tutorial' && c.createdAt)
    .sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''))
    .slice(0, RECENT_MAX)
    .map(c => c.id)

  const data: BrowseData = {
    all,
    featured,
    recent,
    buildAt: new Date().toISOString(),
  }

  mkdirSync(HUGO_DATA_DIR, { recursive: true })
  writeFileSync(BROWSE_DATA_FILE, JSON.stringify(data, null, 2), 'utf-8')
  console.log(`  [browse] wrote ${all.length} cards (${featured.length} featured, ${recent.length} recent) → hugo/data/browse.json`)
}

// buildAllCards: lifted-and-shifted from TutorialNavigator.vue:394-476.
// Functionally identical so the SSR'd grid matches what / would render.
function buildAllCards(
  tuts: TutorialEntry[],
  missions: Mission[],
  hierarchies: MissionHierarchy[],
  standaloneGroups: StandaloneGroup[],
): BrowseCardItem[] {
  // …exact translation of the Vue `allCards` computed, minus the .value
  // unwrapping. See the SFC for the canonical implementation.
}
```

- [ ] **Step 4: Call `writeBrowseData(...)` after the navEntries enrichment loop completes.** Around line ~840 of `fetch-tutorials.ts`, after `missionsMeta` and `allGroupRefs` are populated. The call MUST be inside the same `try/catch` that already wraps catalog handling — if catalog fetch failed but `ALLOW_EMPTY_CAP=1`, skip the write.

- [ ] **Step 5: Verify locally.** `rm -rf .tutorial-cache hugo/data/browse.json` then `npm run fetch-tutorials`. Expect: `hugo/data/browse.json` exists, contains `{"all": [...], "featured": [...], "recent": [...], "buildAt": "..."}`, `all` has ≥1000 entries, `featured` has 10, `recent` has 10. Spot-check that one tutorial in `all` matches the shape expected by `BrowseCardItem`.

- [ ] **Step 6: Commit.**

```bash
git add hugo/data/.gitignore scripts/fetch-tutorials.ts
git commit -m "feat(fetch-tutorials): emit hugo/data/browse.json for /browse/ SSR (#174)

Adds writeBrowseData() that dumps the same enriched catalog shape
TutorialNavigator builds at runtime, but at Hugo build time so the
template can read it via .Site.Data.browse.{all,featured,recent}.
File is gitignored — regenerated every fetch-tutorials run.

Refs #174"
```

### Task 2.2: Build the Hugo template structure

**Files:**
- Create: `hugo/content/browse/_index.md`
- Create: `hugo/layouts/browse/list.html`
- Create: `hugo/layouts/browse/_partials/{card-mission,card-group,card-tutorial,rail,filter-rail}.html`

- [ ] **Step 1: Create `hugo/content/browse/_index.md`.**

```markdown
---
title: "Browse SAP developer tutorials"
type: browse
layout: list
---
```

- [ ] **Step 2: Create `hugo/layouts/browse/_partials/card-tutorial.html`.** The Hugo mirror of `<TutorialCard>`. Markup MUST match Vue output byte-for-byte (the parity test in Task 2.5 will catch drift). Pattern: open `<a>` tag with the appropriate classes, conditional NEW badge `<span>`, conditional license-icon partial, type-label `<div>`, title `<h3>`, desc `<p>`, meta `<div>` with two SVG-icon-and-text spans (level, time). Use Hugo's built-in `title` function (= `strings.Title`) to capitalize level — verify it produces `Beginner` from `beginner` (single-word values: yes).

Refer to `hugo-apps/src/shared/cards/TutorialCard.vue` from PR 1 as the canonical source. Hugo mirrors it; both are byte-equivalent.

- [ ] **Step 3: Create `card-mission.html` and `card-group.html` partials.** Same shape as `card-tutorial.html`, but: (a) different type label / class modifier, (b) include the "N Tutorials" meta line, (c) no NEW badge, no license icon. Mirror `MissionCard.vue` and `GroupCard.vue` byte-for-byte.

- [ ] **Step 4: Create `hugo/layouts/browse/_partials/rail.html`** for the curation rails.

```html
{{- /* hugo/layouts/browse/_partials/rail.html
       Curation rail. Receives a dict { title, idList, showAllHref }.
       Hidden via the [hidden] attribute when the Vue island toggles
       data-rails-hidden on its container.
*/ -}}
{{- $title := .title -}}
{{- $ids := .idList -}}
{{- $showAll := .showAllHref -}}
{{- $all := .Site.Data.browse.all -}}
<section class="browse-rail" aria-label="{{ $title }}" data-rail>
  <header class="browse-rail__header">
    <h2 class="browse-rail__title">{{ $title }}</h2>
    {{- if $showAll -}}
      <a class="browse-rail__show-all" href="{{ $showAll }}">Show all →</a>
    {{- end -}}
  </header>
  <div class="browse-rail-curation">
    {{- range $id := $ids -}}
      {{- range $item := $all -}}
        {{- if eq $item.id $id -}}
          {{- if eq $item.type "mission" -}}{{ partial "browse/_partials/card-mission.html" $item }}{{- end -}}
          {{- if eq $item.type "group"   -}}{{ partial "browse/_partials/card-group.html"   $item }}{{- end -}}
          {{- if eq $item.type "tutorial"-}}{{ partial "browse/_partials/card-tutorial.html" $item }}{{- end -}}
        {{- end -}}
      {{- end -}}
    {{- end -}}
  </div>
</section>
```

The double-nested range is O(N²) but with N=1400 and ids=10 that's 14k iterations per rail — well under Hugo's per-page render budget.

- [ ] **Step 5: Create `hugo/layouts/browse/_partials/filter-rail.html`.** Static filter form markup. The Vue island reads existing checkbox/input state on hydration so the SSR'd "checked" state from URL is preserved.

```html
{{- /* hugo/layouts/browse/_partials/filter-rail.html
       Static filter rail. Vue island reads checkbox/input state on
       hydration so the SSR'd checked state (from URL params) is
       preserved without re-render.
*/ -}}
<aside class="browse-rail" role="complementary" aria-label="Filters" id="browse-filter-rail">
  <form role="search" class="browse-filter-form">
    <fieldset class="browse-filter-group">
      <legend>Type</legend>
      <label><input type="checkbox" name="type" value="mission"> Mission</label>
      <label><input type="checkbox" name="type" value="group"> Group</label>
      <label><input type="checkbox" name="type" value="tutorial"> Tutorial</label>
    </fieldset>
    <fieldset class="browse-filter-group">
      <legend>Level</legend>
      <label><input type="checkbox" name="level" value="beginner"> Beginner</label>
      <label><input type="checkbox" name="level" value="intermediate"> Intermediate</label>
      <label><input type="checkbox" name="level" value="advanced"> Advanced</label>
    </fieldset>
    {{- /* Products + Topics are dynamic and large — Vue renders them after mount.
           Empty slot here keeps the layout from shifting. */ -}}
    <fieldset class="browse-filter-group" data-products-mount></fieldset>
    <fieldset class="browse-filter-group" data-topics-mount></fieldset>
    <fieldset class="browse-filter-group">
      <legend>Quick filters</legend>
      <label><input type="checkbox" name="new" value="1"> New only</label>
      <label><input type="checkbox" name="noLicense" value="1"> No license</label>
    </fieldset>
    <button type="button" class="browse-filter-clear" data-action="clear-filters">Clear all</button>
  </form>
</aside>
```

- [ ] **Step 6: Create `hugo/layouts/browse/list.html`.** The page template that ties everything together: banner with `<h1>` + search input, skip-link, the browse-shell `<div>` containing the filter-rail partial and a `<main id="browse-results" tabindex="-1">`. Inside `<main>`: a `<div data-rails-container>` holding the two rail partials (Featured missions linking to `/missions/`, Recently added linking to `/?new=1`), then a `<section class="browse-grid-section">` with header (title + sort `<select>`), a `<div class="browse-grid" id="browse-root">` containing `first 24` of `.Site.Data.browse.all` rendered via the appropriate card partial per type, then a `<nav class="browse-pagination">` with a `Next →` link when `totalPages > 1`. Below `</div>` (browse-shell), emit a small `<script>` setting `window.__BROWSE_BUILD_AT` from `.Site.Data.browse.buildAt` for cache-busting, and the `<script type="module" src="/js/browse.js?v=...">` for the Vue island.

Refer to spec Section 4 for exact markup; the file is small (~80 lines including comments).

- [ ] **Step 7: Sanity-check the Hugo build.** `npm run build:all`. Expect: build succeeds, `hugo/public/browse/index.html` exists, contains `<header class="browse-banner">`, `<aside ...aria-label="Filters">`, `<main id="browse-results">`, at least 24 `<a class="nav-card">` elements, and 10 cards in each rail. **No `[Vue warn]` or hydration warnings yet (the JS island doesn't exist — we'll get a 404 on `browse.js`, which is fine until Task 2.4).**

- [ ] **Step 8: Commit.**

```bash
git add hugo/content/browse/ hugo/layouts/browse/
git commit -m "feat(hugo): /browse/ SSR layout with rails + page-1 grid (#174)

list.html template + filter-rail + curation-rail + three card-type
partials. Card markup mirrors hugo-apps/src/shared/cards/*.vue
byte-for-byte; drift caught by card-template-parity.test.ts in
the next task. Page 1 SSR'd; pages 2+ are CSR after hydration.

Refs #174"
```

### Task 2.3: Author the page CSS

**Files:**
- Create: `hugo/assets/css/browse.css`

- [ ] **Step 1: Write the CSS.** ~150 lines covering the desktop grid layout, the curation rails (`grid-template-columns: repeat(5, ...)`), the filter rail's vertical stack, the mobile drawer (`@media (max-width: 1023px)` rules), the banner styling, the progress-ring draw-in animation, and the `prefers-reduced-motion` overrides. The full CSS structure is in spec Section 4 ("Layout, visuals, and responsive behavior"). Key rules:

```css
.browse-shell { display: grid; grid-template-columns: 280px 1fr; gap: 1.5rem; max-width: 1440px; margin: 0 auto; padding: 1rem; }
.browse-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 1rem; }
.browse-rail-curation { display: grid; grid-template-columns: repeat(5, minmax(220px, 1fr)); gap: 1rem; overflow-x: auto; scroll-snap-type: x mandatory; }
.browse-rail-curation > * { scroll-snap-align: start; }
.browse-banner { background: var(--sapShellColor); padding: 1.5rem 1rem; text-align: center; }
.browse-banner h1 { margin: 0 0 1rem; }
.browse-banner__search { width: 100%; max-width: 480px; padding: 0.5rem 0.75rem; }
.skip-link { position: absolute; top: -40px; left: 0; padding: 0.5rem 1rem; background: var(--sapShellColor); }
.skip-link:focus { top: 0; }

@media (max-width: 1023px) {
  .browse-shell { grid-template-columns: 1fr; }
  #browse-filter-rail { display: none; }            /* JS toggles to a <dialog> drawer */
  .browse-rail-curation { grid-template-columns: repeat(3, minmax(200px, 80vw)); }
}

/* Progress-ring draw-in (decision #13). The class lands on hydration; the
   keyframes draw the stroke-dashoffset from full to actual. */
.nav-card__progress--animate-in circle.ring__indicator {
  animation: ring-draw-in 250ms ease forwards;
}
@keyframes ring-draw-in {
  from { stroke-dashoffset: var(--ring-circumference); }
  to   { stroke-dashoffset: var(--ring-target); }
}
@media (prefers-reduced-motion: reduce) {
  .nav-card__progress--animate-in circle.ring__indicator { animation: none; }
}

/* Rails fade-out on filter/search (decision Q4). */
[data-rails-container][data-rails-hidden] { opacity: 0; pointer-events: none; transition: opacity 150ms ease; }
@media (prefers-reduced-motion: reduce) {
  [data-rails-container][data-rails-hidden] { transition: none; }
}
```

- [ ] **Step 2: Verify Hugo picks it up.** `npm run build:all`, then `grep -l 'browse-shell' hugo/public/css/`. Expect: a hashed CSS file containing the rules.

- [ ] **Step 3: Manual visual smoke.** Open `hugo/public/browse/index.html` directly in a browser (file://). Layout should look right even without the JS island: rail on the left, rails + grid on the right, mobile breakpoint produces single-column.

- [ ] **Step 4: Commit.**

```bash
git add hugo/assets/css/browse.css
git commit -m "feat(hugo): /browse/ CSS — left-rail grid, rails, drawer, animation (#174)

Implements the layout primitive (CSS grid, 280px + 1fr), the
curation-rail horizontal scroll-snap, the mobile breakpoint
(<1024px collapses rail), the progress-ring draw-in keyframes,
and the prefers-reduced-motion guards.

Refs #174"
```

### Task 2.4: Build the Vue island (`browseUrl.ts` + `BrowsePage.vue` + sub-components)

**Files:**
- Create: `hugo-apps/src/browse/browseUrl.ts` + test
- Create: `hugo-apps/src/browse/main.ts`
- Create: `hugo-apps/src/browse/BrowsePage.vue`
- Create: `hugo-apps/src/browse/BrowseFilterRail.vue`
- Create: `hugo-apps/src/browse/BrowseRail.vue`
- Create: `hugo-apps/src/browse/BrowseSortDropdown.vue`
- Create: `hugo-apps/src/browse/BrowseGrid.vue`
- Modify: `hugo-apps/vite.config.ts`

- [ ] **Step 1: Write the failing test for `browseUrl.ts`.**

```ts
// hugo-apps/src/browse/__tests__/browseUrl.test.ts
import { describe, expect, it } from 'vitest'
import { readSort, writeSort, isValidSort, type Sort } from '../browseUrl'

describe('browseUrl', () => {
  it('readSort defaults to relevance when ?sort= is absent', () => {
    expect(readSort('http://x/browse/')).toBe('relevance')
  })

  it('readSort returns the value when present and valid', () => {
    expect(readSort('http://x/browse/?sort=recent')).toBe('recent')
    expect(readSort('http://x/browse/?sort=title')).toBe('title')
  })

  it('readSort falls back to relevance for unknown values', () => {
    expect(readSort('http://x/browse/?sort=banana')).toBe('relevance')
  })

  it('writeSort writes the param when value is non-default', () => {
    const out = writeSort('http://x/browse/', 'recent')
    expect(out).toBe('http://x/browse/?sort=recent')
  })

  it('writeSort omits the param when value is relevance (default)', () => {
    const out = writeSort('http://x/browse/?sort=recent', 'relevance')
    expect(out).toBe('http://x/browse/')
  })

  it('writeSort preserves unrelated params (urlSync compose)', () => {
    const out = writeSort('http://x/browse/?type=mission&page=2', 'title')
    expect(out).toContain('type=mission')
    expect(out).toContain('page=2')
    expect(out).toContain('sort=title')
  })

  it('isValidSort accepts all 5 declared values', () => {
    for (const s of ['relevance', 'updated', 'recent', 'title', 'time']) {
      expect(isValidSort(s)).toBe(true)
    }
    expect(isValidSort('foo')).toBe(false)
  })
})
```

- [ ] **Step 2: Run, verify FAIL.**

- [ ] **Step 3: Implement `browseUrl.ts`.**

```ts
// hugo-apps/src/browse/browseUrl.ts
//
// /browse/-only sort param. urlSync.ts (#195) handles every other URL
// dimension — q/types/levels/products/topics/isNew/noLicense/page —
// and intentionally preserves unknown params, so adding ?sort= here
// composes cleanly without touching the shared module.

export const SORTS = ['relevance', 'updated', 'recent', 'title', 'time'] as const
export type Sort = typeof SORTS[number]
export const DEFAULT_SORT: Sort = 'relevance'

export function isValidSort(v: string): v is Sort {
  return (SORTS as readonly string[]).includes(v)
}

export function readSort(href: string): Sort {
  const v = new URL(href).searchParams.get('sort') ?? ''
  return isValidSort(v) ? v : DEFAULT_SORT
}

export function writeSort(href: string, sort: Sort): string {
  const url = new URL(href)
  if (sort === DEFAULT_SORT) url.searchParams.delete('sort')
  else url.searchParams.set('sort', sort)
  return url.toString()
}
```

- [ ] **Step 4: Run the test, verify PASS.**

- [ ] **Step 5: Commit.** `git add hugo-apps/src/browse/browseUrl.ts hugo-apps/src/browse/__tests__/browseUrl.test.ts && git commit -m "feat(browse): browseUrl.ts — ?sort= read/write composes with urlSync (#174)"`.

- [ ] **Step 6: Add the `browse` entry to Vite config.** Modify `hugo-apps/vite.config.ts` `rollupOptions.input` to include `browse: resolve(__dirname, 'src/browse/main.ts')`.

- [ ] **Step 7: Implement `main.ts`.**

```ts
// hugo-apps/src/browse/main.ts
import { createSSRApp } from 'vue'
import BrowsePage from './BrowsePage.vue'

const el = document.getElementById('browse-root')
if (el) {
  createSSRApp(BrowsePage).mount(el)
}
```

- [ ] **Step 8: Implement `BrowsePage.vue`.** Top-level orchestration — fetches `/browse/data.json` and `/build/my-progress`, instantiates `useNavigatorFilters({ allCards, enableSort: true })`, wires search-from-banner-input, renders banner / sub-components / shows-rails-toggle. Key plumbing:

  - On mount, fetch `/browse/data.json` (full ~1400-card catalog) and assign to `allCards.value`. Empty fallback on 404 — page-1 SSR'd cards still interactive.
  - Fetch `/build/my-progress` (best-effort, 401 OK) and convert to a `ProgressPayload` via `toLookup`.
  - Read initial sort via `readSort(window.location.href)` and seed `filters.sort.value`.
  - `watch(filters.sort, ...)` writes to URL via `writeSort` + `history.replaceState`.
  - `railsHidden` computed = `filters.hasActiveFilters.value`. Bind to `[data-rails-hidden]` attribute on the `data-rails-container` div for the CSS fade.
  - Pass `filters.displayedItems`, `currentPage`, `totalPages`, `progress`, `sort` down to `<BrowseGrid>`. Emit-back on sort change and page change.
  - Drawer state: `drawerOpen` ref, toggled by the mobile filter button. Pass to `<BrowseFilterRail>`.

  No DOM-write properties; the Vue template handles all rendering. The component is purely declarative; refer to spec Section 3 (Runtime data flow) for the canonical sequence.

- [ ] **Step 9: Implement `BrowseFilterRail.vue`.** Form binding the existing checkbox inputs to `filters.X` arrays via `v-model` (or per-checkbox click handlers since we want to use the SSR'd DOM). On `<1024px` it renders inside a `<dialog>` opened by a "Filters" button in the sticky toolbar. Two-stage hydration: Vue's createSSRApp.mount over the SSR-rendered `<aside>` reads the existing `<input checked>` state (already correct from URL pre-rendering), then takes over change handling. The `data-products-mount` and `data-topics-mount` empty fieldsets get filled with dynamically-built product/topic checkbox lists post-mount (these come from the `availableProducts` / `availableTopics` computeds in `useNavigatorFilters`).

- [ ] **Step 10: Implement `BrowseRail.vue`.** Renders one curation rail. Receives `idList`, `allCards`, and looks up cards by id; renders the appropriate card component for each.

- [ ] **Step 11: Implement `BrowseSortDropdown.vue`.** Native `<select>` with the 5 options. `v-model` to `sort`; emits `change`.

- [ ] **Step 12: Implement `BrowseGrid.vue`.** Renders `items` via the appropriate card component, plus the pagination controls. Pagination buttons are real `<a href="?page=N">` with a click handler that calls `e.preventDefault(); emit('page-change', N)`.

- [ ] **Step 13: Build the Vite bundle.** `cd hugo-apps && npm run build`. Expect: `hugo/static/js/browse.js` produced, no errors.

- [ ] **Step 14: Build Hugo + smoke locally.** `npm run build:all && python -m http.server -d hugo/public 8080`. Open http://localhost:8080/browse/. Verify: SSR'd page-1 cards visible immediately, after JS loads the URL filter chips reflect any `?type=` etc. you set, sort dropdown changes order, search in banner filters cards, mobile breakpoint opens drawer.

- [ ] **Step 15: Commit.**

```bash
git add hugo-apps/src/browse/ hugo-apps/vite.config.ts
git commit -m "feat(browse): /browse/ Vue island — hydrate SSR with full catalog + sort + drawer (#174)

BrowsePage hydrates over the SSR'd DOM via createSSRApp().mount();
fetches /browse/data.json for pages 2+, /build/my-progress for
the CSR'd progress overlays. Search lives in the banner; rails
hide via [data-rails-hidden] when filters are active.

Refs #174"
```

### Task 2.5: Hydration parity & test plan

**Files:**
- Create: `hugo-apps/src/browse/__tests__/BrowsePage.hydration.test.ts`
- Create: `hugo-apps/src/browse/__tests__/card-template-parity.test.ts`
- Modify: smoke tests in `test/smoke/`

- [ ] **Step 1: Write `BrowsePage.hydration.test.ts`.** Captures a snapshot of `hugo/public/browse/index.html` (after running a dev Hugo build with a fixture catalog), mounts `BrowsePage.vue` over it via `createSSRApp().mount()`, asserts no `[Vue warn]` console output and no DOM diff. Uses safe DOM construction — no DOM-write properties, no string-injected markup. Pattern:

  - Read the captured `browse-page-1.html` fixture file via `readFileSync`.
  - Parse it via happy-dom's `DOMParser` (avoids the security-hook'd DOM string-write).
  - Append the parsed body's children to `document.body` via `appendChild` in a loop.
  - Spy on `console.warn` and `console.error` to capture any `[Vue warn]` output.
  - Mount `createSSRApp(BrowsePage)` on the parsed `#browse-root` element.
  - `await new Promise(r => setTimeout(r, 50))` to settle `onMounted`.
  - Assert the captured warnings have no `Vue warn|hydration` matches.
  - Assert `document.querySelector('input[name="type"][value="mission"]').checked === true` when `?type=mission` is in the URL via `history.replaceState` set before mount.
  - Assert `document.querySelector('select[name="sort"]').value === 'recent'` when `?sort=recent` is in the URL.

- [ ] **Step 2: Generate the HTML fixture.** Build Hugo locally with a small fixture `browse.json`, copy `hugo/public/browse/index.html` to `hugo-apps/src/browse/__tests__/fixtures/browse-page-1.html`. Document the fixture-regen step in a README or comment so future test edits know how.

- [ ] **Step 3: Run the test, verify PASS.**

- [ ] **Step 4: Write `card-template-parity.test.ts`.** For each card type: render Vue card via `renderToString()` with a fixture, render Hugo partial with the same fixture (via `hugo --renderToMemory ...` or a small shell-out), normalize whitespace + attribute order, assert equivalent DOM. Pattern:

  - Vue side: `renderToString(createSSRApp({ render: () => h(TutorialCard, { item: tutFixture, progress: emptyProgress() }) }))` returns an HTML string.
  - Hugo side: spawn a one-off Hugo build via `execFileSync('hugo', ['--source', tmpdir, ...])` with a temp config + a single layout that renders the partial under test. Read the rendered HTML string from disk.
  - Normalize both: collapse whitespace runs, strip Vue scoped-id attributes (`data-v-*`), strip any non-meaningful attribute-order differences. Assert string equality.

  **Windows caveat:** running Hugo from inside Vitest may be brittle on Windows. If the in-test Hugo invocation flakes, pivot to: pre-compute the Hugo render output at test-fixture-prep time, commit the captured strings as static fixture files (`fixtures/card-tutorial.html.txt` etc.), and assert Vue's `renderToString` matches the captured fixture. Document the fixture-regen step. **The pivot is acceptable for v1** — the test still catches drift; it just requires manual fixture regeneration when card markup intentionally changes.

- [ ] **Step 5: Run, verify PASS.**

- [ ] **Step 6: Add smoke tests** in `test/smoke/` for `/browse/` returning 200 with the expected landmarks, the `data.json` returning valid JSON, `?type=mission` returning a body where the mission checkbox is `checked`. Reuse the smoke harness pattern from existing `test/smoke/*.test.ts`.

- [ ] **Step 7: Run all PR-2 tests.** `npx vitest run hugo-apps/src/browse/`. Expect: every test passes.

- [ ] **Step 8: Commit.**

```bash
git add hugo-apps/src/browse/__tests__/ test/smoke/
git commit -m "test(browse): hydration parity + card-template parity + smoke (#174)

Three load-bearing tests for the dual-edit tax:
- BrowsePage.hydration.test.ts: no Vue hydration warnings, URL state
  survives mount.
- card-template-parity.test.ts: Vue card SSR ↔ Hugo partial equivalence.
- test/smoke/browse.test.ts: deployed-DEV reachability, landmarks,
  filter pre-check via SSR.

Refs #174"
```

### Task 2.6: Surface `/browse/` (pill + shellbar)

**Files:**
- Modify: `hugo/layouts/index.html` (pill on `/`)
- Modify: `hugo/layouts/partials/header.html` or whichever shellbar partial exists (verify path)

- [ ] **Step 1: Find the existing shellbar partial.** `grep -rn 'ui5-shellbar\|shellbar' hugo/layouts/partials/ | head -20`. The partial path will inform the next step; depending on the project layout it may be `header.html`, `shellbar.html`, or inline in `baseof.html`.

- [ ] **Step 2: Add the shellbar "Browse" item.** Match the existing item pattern; ensure the active-state highlight applies on `/browse/` paths. Wrap behind `{{ if not site.Params.qa }}` if the QA channel doesn't ship `/browse/` (check spec — and per [[qa-gate-frontend-script-tags]]).

- [ ] **Step 3: Add the pill on `/`.** Above the existing hero in `hugo/layouts/index.html`:

```html
<a class="browse-pill" href="/browse/">
  <span class="browse-pill__icon" aria-hidden="true">✨</span>
  Try the new browse layout →
</a>
```

Plus a small CSS rule in `hugo/assets/css/home.css` for the pill (subtle, clearly marked "new feature trial" — easy to remove post-A/B).

- [ ] **Step 4: Build + smoke.** `npm run build:all`, open `/` in browser, verify the pill is visible and clickable, lands on `/browse/`. Verify shellbar Browse item is present and highlights when on `/browse/`.

- [ ] **Step 5: Commit.**

```bash
git add hugo/layouts/index.html hugo/layouts/partials/ hugo/assets/css/home.css
git commit -m "feat(home): pill on / + shellbar item surfacing /browse/ (#174)

Both surface the new layout for the A/B period; both are easy to
remove post-A/B without touching /browse/ itself.

Refs #174"
```

### Task 2.7: Open PR 2

- [ ] **Step 1: Verify branch + tests.** `git branch --show-current` (`feat/issue-174-browse-ssr`), `npx vitest run hugo-apps/`, `npm run build:all`. All green.

- [ ] **Step 2: Push + PR.**

```bash
git push -u origin feat/issue-174-browse-ssr
gh pr create --repo sap-tutorials/tutorials-ims --base main \
  --title "feat: /browse/ Discovery-Center-style alternative homepage with full SSR (#174)" \
  --body "PR 2 of 3 implementing #198. Adds /browse/ Hugo route with SSR rails+grid, Vue island that hydrates over the rendered DOM, surfaced via pill on / + shellbar Browse item. urlSync.ts reused from #197 verbatim; ?sort= in browseUrl.ts. card-template-parity test catches Vue↔Hugo drift.\n\nDoes NOT include admin-write rebuild trigger — that's PR 3.\n\nVerification: full hugo-apps test suite, BrowsePage.hydration.test.ts, card-template-parity.test.ts, smoke tests for /browse/, manual local-dev visual check.\n\nRefs #174 / spec #198"
```

---

## PR 3 — Admin-Write Rebuild Trigger

**Goal:** When an admin saves a Mission/Group/Featured-flag in the admin UI, fire a debounced GitHub `workflow_dispatch` to `rebuild-content.yml` so `/browse/`'s SSR'd content stays fresh within minutes (not hours). Behind a feature flag — if `GITHUB_DISPATCH_TOKEN` is unset, no-op gracefully and content stays fresh via the existing push trigger.

**Branch:** `feat/issue-174-admin-write-rebuild-trigger` — start from a fresh `main` after PR 2 merges.

**Files (PR 3 scope):**

- Create: `srv/lib/rebuild-trigger.js`
- Create: `srv/lib/__tests__/rebuild-trigger.test.js`
- Create: `docs/developers/operations/github-dispatch-pat-rotation.md`
- Modify: `srv/server.js` (extend the existing `invalidateNavigatorCache` after-hook callsite)
- Modify: `.github/workflows/rebuild-content.yml` (add `workflow_dispatch.inputs.trigger-source`)
- Modify: `.deploy/mta.yaml` (verify `srv-qa` cp-list includes `rebuild-trigger.js` per [[srv-qa-cp-list-recurring]])
- Modify: `.env.example` (document `GITHUB_DISPATCH_TOKEN`)

### Task 3.1: Implement the debounced trigger module

**Files:**
- Create: `srv/lib/rebuild-trigger.js`
- Create: `srv/lib/__tests__/rebuild-trigger.test.js`

- [ ] **Step 1: Write the failing test.**

```js
// srv/lib/__tests__/rebuild-trigger.test.js
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { _resetForTests, scheduleRebuild } from '../rebuild-trigger.js'

describe('rebuild-trigger', () => {
  let dispatch
  beforeEach(() => {
    vi.useFakeTimers()
    dispatch = vi.fn().mockResolvedValue({ status: 204 })
    _resetForTests({ dispatchFn: dispatch, debounceMs: 60_000, token: 'fake-token' })
  })
  afterEach(() => { vi.useRealTimers() })

  it('fires once after debounce window for a single trigger', async () => {
    scheduleRebuild('admin-write')
    expect(dispatch).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(60_001)
    expect(dispatch).toHaveBeenCalledTimes(1)
    expect(dispatch).toHaveBeenCalledWith({ trigger_source: 'admin-write' })
  })

  it('coalesces multiple triggers within the window into one dispatch', async () => {
    scheduleRebuild('admin-write')
    await vi.advanceTimersByTimeAsync(20_000)
    scheduleRebuild('admin-write')
    await vi.advanceTimersByTimeAsync(20_000)
    scheduleRebuild('admin-write')
    await vi.advanceTimersByTimeAsync(60_001)
    expect(dispatch).toHaveBeenCalledTimes(1)
  })

  it('fires twice when triggers are spaced beyond the window', async () => {
    scheduleRebuild('admin-write')
    await vi.advanceTimersByTimeAsync(60_001)
    scheduleRebuild('admin-write')
    await vi.advanceTimersByTimeAsync(60_001)
    expect(dispatch).toHaveBeenCalledTimes(2)
  })

  it('no-ops when token is unset', async () => {
    _resetForTests({ dispatchFn: dispatch, debounceMs: 60_000, token: null })
    scheduleRebuild('admin-write')
    await vi.advanceTimersByTimeAsync(60_001)
    expect(dispatch).not.toHaveBeenCalled()
  })

  it('swallows dispatch errors (does not throw to caller)', async () => {
    dispatch.mockRejectedValueOnce(new Error('network broken'))
    scheduleRebuild('admin-write')
    await expect(vi.advanceTimersByTimeAsync(60_001)).resolves.not.toThrow()
    expect(dispatch).toHaveBeenCalledTimes(1)
  })

  it('next trigger after a failed dispatch still fires (no permanent jam)', async () => {
    dispatch.mockRejectedValueOnce(new Error('network broken'))
    scheduleRebuild('admin-write')
    await vi.advanceTimersByTimeAsync(60_001)
    expect(dispatch).toHaveBeenCalledTimes(1)
    scheduleRebuild('admin-write')
    await vi.advanceTimersByTimeAsync(60_001)
    expect(dispatch).toHaveBeenCalledTimes(2)
  })
})
```

- [ ] **Step 2: Run, verify FAIL** (`srv/lib/rebuild-trigger.js` doesn't exist).

- [ ] **Step 3: Implement `rebuild-trigger.js`.**

```js
// srv/lib/rebuild-trigger.js
//
// Debounced GitHub workflow_dispatch trigger for admin writes.
// When admins save a Mission/Group/Featured-flag, /browse/ SSR's catalog
// goes stale until the next Hugo rebuild. This module collapses bulk
// edits into one rebuild dispatch within a 60s window.
//
// Behind a feature flag: if GITHUB_DISPATCH_TOKEN is unset, this is a
// no-op. Local dev never tries to dispatch.
//
// Spec: docs/superpowers/specs/2026-06-02-browse-layout-design.md (Q11)

import { Octokit } from '@octokit/rest'

const REPO_OWNER = 'sap-tutorials'
const REPO_NAME = 'tutorials-ims'
const WORKFLOW_FILE = 'rebuild-content.yml'
const DEFAULT_DEBOUNCE_MS = 60_000

let _state = {
  token: process.env.GITHUB_DISPATCH_TOKEN ?? null,
  debounceMs: DEFAULT_DEBOUNCE_MS,
  pendingTimer: null,
  pendingReason: null,
  dispatchFn: defaultDispatch,
}

async function defaultDispatch(inputs) {
  if (!_state.token) return { status: 0, skipped: true }
  const octokit = new Octokit({ auth: _state.token })
  return octokit.actions.createWorkflowDispatch({
    owner: REPO_OWNER,
    repo: REPO_NAME,
    workflow_id: WORKFLOW_FILE,
    ref: 'main',
    inputs,
  })
}

export function scheduleRebuild(reason) {
  if (!_state.token) {
    return  // Feature flag off — no-op silently. Token-missing is logged once at boot.
  }
  if (_state.pendingTimer) {
    // A dispatch is already pending — reset the timer to extend the window.
    // Multiple admin saves in rapid succession all collapse into one dispatch
    // after 60s of quiet.
    clearTimeout(_state.pendingTimer)
  }
  _state.pendingReason = reason
  _state.pendingTimer = setTimeout(() => {
    const reasonAtFire = _state.pendingReason
    _state.pendingTimer = null
    _state.pendingReason = null
    _state.dispatchFn({ trigger_source: reasonAtFire }).catch((err) => {
      console.error('[rebuild-trigger] dispatch failed:', err.message ?? err)
      // Do NOT rethrow. Admin save already succeeded; the next trigger
      // picks up the missed change.
    })
  }, _state.debounceMs)
}

// One-time boot warning if token is unset, so ops sees the feature flag is off.
let _bootWarned = false
export function checkFeatureFlag() {
  if (!_state.token && !_bootWarned) {
    _bootWarned = true
    console.warn('[rebuild-trigger] GITHUB_DISPATCH_TOKEN unset — admin writes will not trigger /browse/ rebuilds. Falls back to next-push cadence.')
  }
}

// Test-only escape hatch.
export function _resetForTests({ dispatchFn, debounceMs, token }) {
  if (_state.pendingTimer) clearTimeout(_state.pendingTimer)
  _state = {
    token: token ?? null,
    debounceMs: debounceMs ?? DEFAULT_DEBOUNCE_MS,
    pendingTimer: null,
    pendingReason: null,
    dispatchFn: dispatchFn ?? defaultDispatch,
  }
  _bootWarned = false
}
```

- [ ] **Step 4: Run the test, verify PASS** (6 cases).

- [ ] **Step 5: Commit.**

```bash
git add srv/lib/rebuild-trigger.js srv/lib/__tests__/rebuild-trigger.test.js
git commit -m "feat(srv): rebuild-trigger.js — debounced workflow_dispatch (#174)

Collapses admin-write storms into one workflow_dispatch within a
60s debounce window. Behind GITHUB_DISPATCH_TOKEN env flag — no-op
if unset. Errors swallowed (admin save still succeeds; next trigger
picks up missed changes). 6 unit tests cover the debounce logic,
token-missing no-op, and post-error recovery.

Refs #174"
```

### Task 3.2: Wire the trigger into the existing admin-write hook

**Files:**
- Modify: `srv/server.js`

- [ ] **Step 1: Import the new module + add the boot warning.** Near the top of `srv/server.js`:

```js
import { scheduleRebuild, checkFeatureFlag as checkRebuildTriggerFeatureFlag } from './lib/rebuild-trigger.js'
```

In the `cds.on('served', ...)` block, near where other startup checks live, add `checkRebuildTriggerFeatureFlag()` so the boot warning surfaces once if the token isn't set.

- [ ] **Step 2: Extend the existing `invalidateNavigatorCache` callsite.** [srv/server.js:268-292](srv/server.js#L268-L292) already runs after admin writes to mission/group/featured entities. Add the rebuild trigger to the same callback:

```js
admin.after(['CREATE', 'UPDATE', 'DELETE'], navInvalidatingEntities, () => {
  try {
    invalidateNavigatorCache()
  } catch (err) {
    console.error('[navigator] cache invalidation failed', err)
  }
  try {
    const removed = invalidateRenderCache()
    if (removed > 0) {
      console.log(`[render-cache] invalidated ${removed} entries after admin write`)
    }
  } catch (err) {
    console.error('[render-cache] cache invalidation failed', err)
  }
  // [#174 PR 3] Also schedule a /browse/ SSR rebuild. Debounced 60s so a
  // single admin bulk-edit (rename tag → 50 tutorials updated) collapses
  // into one workflow_dispatch instead of 50.
  try {
    scheduleRebuild('admin-write')
  } catch (err) {
    console.error('[rebuild-trigger] scheduling failed', err)
  }
})
```

- [ ] **Step 3: Manual smoke (hybrid mode).** Run CAP locally with `cds bind --exec -- cds watch` against DEV. Make a small admin edit to a Mission via the admin UI (e.g. update a description). Watch the CAP logs: expect one `[rebuild-trigger]` line ~60s after the save, OR the boot warning if `GITHUB_DISPATCH_TOKEN` isn't set locally (which is the expected dev-mode default — local CAP shouldn't fire workflows).

- [ ] **Step 4: Commit.**

```bash
git add srv/server.js
git commit -m "feat(srv): wire admin-write hook to schedule /browse/ rebuild (#174)

Extends the existing invalidateNavigatorCache callsite to also
schedule a debounced rebuild trigger. No additional after-hook
registration; reuses the navInvalidatingEntities allowlist
(Missions, Groups, CompletionPaths, CompletionPathItems,
GroupPathItems, Tutorials).

Refs #174"
```

### Task 3.3: Add the `workflow_dispatch` input to `rebuild-content.yml`

**Files:**
- Modify: `.github/workflows/rebuild-content.yml`

- [ ] **Step 1: Read the current workflow.** Confirm it already has a `workflow_dispatch:` trigger. If yes, just add the new input. If no, add the trigger.

- [ ] **Step 2: Add the `trigger-source` input.** In the `on:` block:

```yaml
on:
  workflow_dispatch:
    inputs:
      slug:
        description: 'Tutorial slug to force-refresh (optional — leave blank for full rebuild)'
        required: false
        type: string
      trigger-source:                                 # NEW for #174
        description: 'Where the rebuild was triggered from (admin-write | manual | scheduled)'
        required: false
        default: 'manual'
        type: string
  repository_dispatch:
    types: [tutorial-content-changed]
```

The input is informational only — it surfaces in the Actions UI so ops can tell admin-triggered rebuilds apart from manual/scheduled ones. No job-step gating on it; the existing job runs the same regardless.

- [ ] **Step 3: Commit.**

```bash
git add .github/workflows/rebuild-content.yml
git commit -m "ci: rebuild-content workflow_dispatch trigger-source input (#174)

Lets admin-write rebuild triggers tag themselves so the Actions UI
shows where each run came from. Informational only — no job-step
gate.

Refs #174"
```

### Task 3.4: Verify `srv-qa` cp-list includes the new module

**Files:**
- Modify: `.deploy/mta.yaml` (if needed)

This step exists because of [[srv-qa-cp-list-recurring]] — the project's hand-curated `srv-qa` `cp` list has crashed QA boot twice in 4 days when new transitive `srv/lib/*` imports were added. **Do not skip.**

- [ ] **Step 1: Walk transitive imports.** Starting from `srv/lib/content-store.js` (the QA srv's entry-point dependency tree) and any other QA-srv-imported file, list every `./` relative import. Add `srv/lib/rebuild-trigger.js` if any QA-loaded file imports it. The current PR 3 only imports it from `srv/server.js`, but the QA srv has its own `server-qa.js` or similar — verify which file QA loads.

```bash
cd d:/projects/tutorials-poc
grep -lE "from\s+['\"]\\./rebuild-trigger" srv/ -r 2>&1
```

- [ ] **Step 2: Update `srv-qa` cp-list in `.deploy/mta.yaml`** if QA boots `rebuild-trigger.js`. If QA doesn't import it (admin writes go through the prod admin service only), the file is prod-srv-only and QA's `cp` list is fine.

- [ ] **Step 3: Manual MTA build smoke.** `cd .deploy && mbt build`. Expect: builds successfully, no missing-file errors. Don't deploy yet — just verify the build doesn't crash.

- [ ] **Step 4: Commit (if mta.yaml changed).**

```bash
git add .deploy/mta.yaml
git commit -m "chore(deploy): add rebuild-trigger.js to srv-qa cp-list (#174)

Per [[srv-qa-cp-list-recurring]], hand-curated cp-list crashes QA
boot when new srv/lib/ files are missing. Verified rebuild-trigger
is required by [list the importing file]."
```

If no change was needed, skip this commit; just note in PR 3's body that the cp-list audit was performed and confirmed no change required.

### Task 3.5: Document the PAT rotation runbook

**Files:**
- Create: `docs/developers/operations/github-dispatch-pat-rotation.md`
- Modify: `.env.example`

- [ ] **Step 1: Write the runbook.** Cover: (a) why the PAT exists (link to spec / #174), (b) generation steps (fine-grained PAT, scoped `actions:write` on `sap-tutorials/tutorials-ims` only, 90-day expiry), (c) where it lives (`GITHUB_DISPATCH_TOKEN` in CF env, set via `cf set-env tutorials-srv GITHUB_DISPATCH_TOKEN <value>` + `cf restart tutorials-srv`), (d) rotation cadence (90 days; calendar reminder), (e) revocation (GitHub Settings → Developer settings → revoke; CF env stays set with stale value until next rotation, which is the failure mode — log line warns when 4xx returned), (f) emergency revocation steps, (g) test command for verifying a new token (`curl -X POST -H "Authorization: Bearer $TOKEN" https://api.github.com/repos/.../dispatches -d '{"event_type":"test"}'`).

```markdown
# `GITHUB_DISPATCH_TOKEN` Rotation Runbook

## What

Fine-grained GitHub Personal Access Token used by `srv/lib/rebuild-trigger.js`
to fire `workflow_dispatch` on `rebuild-content.yml` after admin writes.
Keeps `/browse/` SSR'd content fresh within minutes of admin saves.

Set on the deployed `tutorials-srv` app as the env var `GITHUB_DISPATCH_TOKEN`.

## When to rotate

- Every 90 days (token expiry default).
- Immediately if the token is suspected leaked (see "Emergency revocation" below).
- When the PAT-owning user leaves SAP / changes role.

## How to rotate

1. **Generate the new token.** GitHub → Settings → Developer settings →
   Personal access tokens → Fine-grained tokens → Generate new token.
   - Resource owner: `sap-tutorials`
   - Repository access: only `tutorials-ims`
   - Permissions: Repository → Actions → Read and write (sole permission)
   - Expiration: 90 days

2. **Test the new token.**
   ```bash
   curl -X POST -H "Accept: application/vnd.github+json" \
     -H "Authorization: Bearer <NEW_TOKEN>" \
     https://api.github.com/repos/sap-tutorials/tutorials-ims/actions/workflows/rebuild-content.yml/dispatches \
     -d '{"ref":"main","inputs":{"trigger-source":"manual","slug":""}}'
   ```
   Expect: HTTP 204 (no body). A new run should appear in the Actions tab.

3. **Update CF env on each environment** (DEV, QA, PROD).
   ```bash
   cf target -s dev
   cf set-env tutorials-srv GITHUB_DISPATCH_TOKEN "<NEW_TOKEN>"
   cf restart tutorials-srv
   ```
   Repeat for `qa` and `prod` spaces. Validate via deployed log line on boot:
   `[rebuild-trigger] GITHUB_DISPATCH_TOKEN unset — ...` should NOT appear.

4. **Revoke the old token.** GitHub → Settings → Developer settings →
   Personal access tokens → click old token → Revoke.

5. **Update the rotation calendar reminder** for +90 days.

## Emergency revocation

If the token is suspected leaked (committed to a repo, posted in a chat, etc.):

1. **Revoke immediately** via GitHub UI. This stops further dispatches even
   before CF env is updated.
2. Generate a replacement and update CF env per "How to rotate" above.
3. Audit `tutorials-ims` Actions tab for unexpected workflow runs in the
   leak window. Any unauthorized dispatch is a possible incident — file
   per the project's security incident process.

## Failure modes

- **Token unset**: `[rebuild-trigger]` boot warning, admin writes don't
  trigger rebuilds, content stays fresh via the existing push trigger only.
  Acceptable degraded mode.
- **Token expired / revoked**: GitHub returns 401. `rebuild-trigger.js`
  swallows the error and logs `[rebuild-trigger] dispatch failed: ...`.
  Admin saves still succeed. Rotate to fix.
- **Token over-permissioned**: Defense-in-depth violation, not an outage.
  Re-issue with `actions:write` only.
```

- [ ] **Step 2: Document the env var in `.env.example`.**

```bash
# GITHUB_DISPATCH_TOKEN
# Fine-grained PAT scoped to actions:write on sap-tutorials/tutorials-ims.
# When set, admin writes (Missions/Groups/Featured) trigger debounced
# rebuilds of /browse/ SSR content. When unset, falls back to the
# existing push-only freshness cadence.
# Rotation runbook: docs/developers/operations/github-dispatch-pat-rotation.md
GITHUB_DISPATCH_TOKEN=
```

- [ ] **Step 3: Commit.**

```bash
git add docs/developers/operations/github-dispatch-pat-rotation.md .env.example
git commit -m "docs: GITHUB_DISPATCH_TOKEN rotation runbook (#174)

Generation, CF env update, revocation, emergency procedures.

Refs #174"
```

### Task 3.6: Open PR 3

- [ ] **Step 1: Verify branch + tests.** `git branch --show-current` (`feat/issue-174-admin-write-rebuild-trigger`), `npx vitest run srv/lib/__tests__/rebuild-trigger.test.js`, full `npm test`. All green.

- [ ] **Step 2: Push + PR.**

```bash
git push -u origin feat/issue-174-admin-write-rebuild-trigger
gh pr create --repo sap-tutorials/tutorials-ims --base main \
  --title "feat: admin-write rebuild trigger for /browse/ freshness (#174)" \
  --body "$(cat <<'EOF'
PR 3 of 3 implementing #198. Wires admin writes (Missions, Groups,
Featured-flag entities) to fire a debounced GitHub workflow_dispatch
on rebuild-content.yml so /browse/ SSR'd content stays fresh within
minutes of admin saves.

## What's in this PR

- \`srv/lib/rebuild-trigger.js\` — debounced trigger with 60s window
  (collapses bulk edits into one dispatch)
- \`srv/server.js\` — wires the trigger into the existing
  \`invalidateNavigatorCache\` after-hook callsite
- \`.github/workflows/rebuild-content.yml\` — new \`trigger-source\`
  input on \`workflow_dispatch\` (informational, surfaces in Actions UI)
- \`docs/developers/operations/github-dispatch-pat-rotation.md\` — full
  rotation runbook (90-day cadence, emergency revocation, failure modes)

## Feature flag

Behind \`GITHUB_DISPATCH_TOKEN\` env var. If unset, no-op gracefully —
content stays fresh via the existing push trigger only. Roll out
per-environment (DEV → QA → PROD) by setting the env var when ready.

## Verification

- 6 unit tests for the debounce logic, token-missing no-op, and
  error-recovery path
- Manual hybrid-mode smoke: admin save in DEV admin UI → ~60s later,
  Actions tab shows a \`rebuild-content.yml\` run with
  \`trigger-source=admin-write\`
- \`srv-qa\` cp-list audit performed per [[srv-qa-cp-list-recurring]]:
  [confirm + describe outcome]

Refs #174 / spec #198
EOF
)"
```

- [ ] **Step 3: Capture PR number, update #174 task list, set the GITHUB_DISPATCH_TOKEN on DEV CF env, redeploy, verify with manual admin-write smoke.**

---

## Definition of done

- [ ] PR 1 merged, navigator-regression test green, `/` works as before
- [ ] PR 2 merged, `/browse/` reachable on DEV, hydration test green, card-template-parity test green
- [ ] PR 3 merged, `GITHUB_DISPATCH_TOKEN` set on DEV CF env, manual admin-write smoke confirmed
- [ ] Tom's manual checklist (spec Section 5) passes on DEV
- [ ] Pill on `/` and shellbar "Browse" item visible to all DEV users
- [ ] All 6 followup issues (#199–#204) referenced in #174 task-list
- [ ] When ready: roll PR 3's env var forward to QA + PROD per the rotation runbook

## References

- Spec: [docs/superpowers/specs/2026-06-02-browse-layout-design.md](../specs/2026-06-02-browse-layout-design.md)
- Spec PR: [#198](https://github.com/sap-tutorials/tutorials-ims/pull/198)
- Parent issue: [#174](https://github.com/sap-tutorials/tutorials-ims/issues/174)
- Followups: #199 (sort on /), #200 (SSR on /), #201 (Categories facet), #202 (Personalized rail), #203 (per-user SSR), #204 (A/B analytics)
- Dependency: #197 (urlSync.ts merged)
- Related memory pointers: [[parallel-agents-need-worktrees]], [[verify-branch-before-commit]], [[srv-qa-cp-list-recurring]], [[qa-gate-frontend-script-tags]], [[html-property-blocked-by-hook]], [[worktree-tests-hang]], [[npm-ignore-scripts-blocks-native-builds]]
