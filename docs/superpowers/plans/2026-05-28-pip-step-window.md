# Document PiP Tutorial Step Window — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a Document Picture-in-Picture step window that lets learners pop the current tutorial step into an always-on-top floating window, two-way synced with the main browser tab via `BroadcastChannel`. Chromium-only with silent feature-detection fallback. Zero impact on Firefox/Safari/mobile.

**Architecture:** Two new Vue islands in `hugo-apps/src/` — a launcher mounted in the U11 progress-bar container that opens the PiP window, and a content island that renders inside the PiP window. They communicate over a typed `BroadcastChannel` wrapper, keyed per tutorial slug. No backend, schema, manifest, or CI changes.

**Tech Stack:** Vue 3 (existing islands pattern), TypeScript, Vite (existing build), Vitest + happy-dom (existing unit-test stack), UI5 Web Components (already imported via `ui5-bootstrap.ts`), native `BroadcastChannel`, `documentPictureInPicture` API, `window.crypto.randomUUID`.

**Spec:** [docs/superpowers/specs/2026-05-28-pip-step-window-design.md](../specs/2026-05-28-pip-step-window-design.md)

---

## File Structure

### New files

| Path | Responsibility |
|---|---|
| `hugo-apps/src/shared/pip-channel.ts` | Typed wrapper around `BroadcastChannel`. Auto-stamps `senderId` + `source` on every send. Drops self-broadcasts. ~60 LoC. |
| `hugo-apps/src/shared/pip-channel.test.ts` | Vitest unit tests for the channel wrapper. |
| `hugo-apps/src/shared/pip-types.ts` | `PipMessage` union + `StepPayload` shared between launcher and PiP island. |
| `hugo-apps/src/shared/pip-storage.ts` | `localStorage` getter/setter for PiP mode preference. Tiny; isolates the storage key. |
| `hugo-apps/src/shared/pip-storage.test.ts` | Vitest unit tests. |
| `hugo-apps/src/tutorial-pip-launcher/main.ts` | Feature-detected mount entry. Reads `data-*` attrs from mount node, instantiates Vue. |
| `hugo-apps/src/tutorial-pip-launcher/Launcher.vue` | The button. Manages `pipWindow` reference, opens/closes, wires the channel. |
| `hugo-apps/src/tutorial-pip-launcher/usePipLifecycle.ts` | Composable: `requestWindow`, CSS/font cloning, theme mirroring, channel routing. |
| `hugo-apps/src/tutorial-pip-launcher/usePipLifecycle.test.ts` | Vitest unit tests for the lifecycle helpers (mocked `documentPictureInPicture`). |
| `hugo-apps/src/tutorial-pip/main.ts` | Mount entry called by launcher *inside the PiP window*. |
| `hugo-apps/src/tutorial-pip/PipShell.vue` | Root: holds active step + mode, channel subscription, ResizeObserver for auto-collapse. |
| `hugo-apps/src/tutorial-pip/FullMode.vue` | Heading + body + ◀ ▶ + Mark Complete + chevron-to-controller. |
| `hugo-apps/src/tutorial-pip/ControllerMode.vue` | Heading + dots + ◀ ▶ + Mark Complete + Expand. |
| `hugo-apps/src/tutorial-pip/useStepNavigation.ts` | prev/next/goto + `markStepComplete` API call + bounds checks. |
| `hugo-apps/src/tutorial-pip/useStepNavigation.test.ts` | Vitest unit tests (mocked fetch). |
| `test/smoke/pip-bundle.test.ts` | Smoke check that both island bundles are deployed and 200. |

### Modified files

| Path | Change |
|---|---|
| `hugo-apps/vite.config.ts` | Add `tutorial-pip-launcher` and `tutorial-pip` to `rollupOptions.input`. |
| `hugo/layouts/tutorials/u1-object-page.html` | Add `<div id="tutorial-pip-launcher" data-slug="..." data-step-count="..." data-active-step="...">` next to existing `#progress-bar`. Add `<div id="tutorial-pip-mount">` that the PiP window will use as its render root (mounted lazily; see Task 5). Add a Hugo-emitted JSON island `<script id="tutorial-pip-steps" type="application/json">[...]</script>` containing `{stepIndex, heading, html}[]`. |
| `hugo/layouts/tutorials/single.html` | Same launcher mount + JSON payload (legacy single layout). |
| `hugo/assets/js/reading-progress.ts:65-75` | Inside `applyActive()`, after the early-return on `stepNum === lastActive`, dispatch `new CustomEvent('tutorial:step-change', { detail: { stepIndex } })` on `document`. |
| `hugo/assets/js/tutorial.ts:230-238` | After `markButtonCompleted(btn)` succeeds, dispatch `new CustomEvent('tutorial:step-completed', { detail: { stepIndex } })` on `document`. (Lets PiP receive completion clicks made in the main tab.) |
| `hugo/assets/js/ui5-bootstrap.ts` | One-line conditional import-and-mount for `tutorial-pip-launcher` (loaded as a Hugo-built static script — *not* via this file; see Task 6 for the Hugo-side wiring). |

### Why this decomposition

- **`shared/` holds the message contract + storage + channel wrapper.** Both islands import the same types — keeps the protocol authoritative in one place.
- **Launcher and PiP-content are separate top-level islands.** They run in different `Window` objects; they cannot share runtime state, only types and message envelopes.
- **Heavy logic lives in `.ts` modules, not `.vue` files.** Mirrors the project's existing test pattern (`navigator/cardProgress.ts` is the precedent — pure TS, unit-tested; component file is thin).
- **Lifecycle composable carries the messy parts** (CSS cloning, font copy, ResizeObserver, theme MutationObserver) so `Launcher.vue` and `PipShell.vue` stay readable.

---

## Pre-implementation: working branch + worktree

- [ ] **Step 0.1: Create a working branch in a fresh worktree**

```bash
cd d:/projects/tutorials-poc
git fetch origin
git worktree add .worktrees/feat-pip-step-window -b feat/pip-step-window origin/main
cd .worktrees/feat-pip-step-window
```

- [ ] **Step 0.2: Verify the worktree is clean and on the new branch**

Run:
```bash
git status
git rev-parse --abbrev-ref HEAD
```

Expected:
- `git status` → "On branch feat/pip-step-window / nothing to commit, working tree clean"
- `git rev-parse` → `feat/pip-step-window`

- [ ] **Step 0.3: Install dependencies inside the worktree**

Run:
```bash
npm install
( cd hugo-apps && npm install )
```

Expected: clean install with no audit errors that block. (Memory: `npm-security-config` — global `ignore-scripts=true` may leave `better-sqlite3` without bindings; if `npm test` later fails with "Could not find native module", `cd` to project root and `npm rebuild better-sqlite3` to force the postinstall.)

- [ ] **Step 0.4: Smoke-check the existing test suite is green before any change**

Run:
```bash
npm test
```

Expected: all tests pass. Record the count for later regression comparison (e.g., "620 passing / 0 failing / 13 skipped").

- [ ] **Step 0.5: Commit checkpoint (no changes — stake out the branch)**

Skip if no changes to commit. The worktree itself is the checkpoint.

---

## Task 1: Shared types

**Files:**
- Create: `hugo-apps/src/shared/pip-types.ts`

This task introduces the `PipMessage` union and `StepPayload` shape used by both islands. No tests yet — types-only files don't get unit tests in this project (precedent: `hugo-apps/src/shared/types.ts`).

- [ ] **Step 1.1: Create the types file**

```ts
// hugo-apps/src/shared/pip-types.ts
// Shared between tutorial-pip-launcher (main tab) and tutorial-pip (PiP window).
// Keep this file types-only — no runtime code, no imports beyond Vue types if needed.

export type PipMode = 'full' | 'controller';

export type StepPayload = {
  stepIndex: number;        // 1-based, matches data-step on .tutorial-step nodes
  heading: string;          // step H3 text content
  html: string;             // sanitized step body HTML (already sanitized by Hugo build)
};

export type PipSource = 'main' | 'pip';

type Envelope = { senderId: string; source: PipSource };

export type PipMessage = Envelope & (
  | { type: 'pip:init';        steps: StepPayload[]; activeStep: number; mode: PipMode }
  | { type: 'pip:hello' }
  | { type: 'pip:reattach' }
  | { type: 'pip:stepChange';  stepIndex: number }
  | { type: 'pip:complete';    stepIndex: number }
  | { type: 'pip:modeChange';  mode: PipMode }
  | { type: 'pip:themeChange'; theme: 'light' | 'dark' }
  | { type: 'pip:closed' }
);
```

- [ ] **Step 1.2: TypeScript-compile the file**

Run:
```bash
( cd hugo-apps && npx tsc --noEmit )
```

Expected: no errors.

- [ ] **Step 1.3: Commit**

```bash
git add hugo-apps/src/shared/pip-types.ts
git commit -m "feat(pip): add shared PiP message types"
```

---

## Task 2: pip-storage (localStorage helper)

**Files:**
- Create: `hugo-apps/src/shared/pip-storage.ts`
- Test: `hugo-apps/src/shared/pip-storage.test.ts`

Tiny module isolating the `localStorage` key name and parse/stringify. Spec recommendation: name the key `sap-tutorials-pip-mode` (matches the `sap-tutorials-admin-theme` precedent).

- [ ] **Step 2.1: Write failing test**

```ts
// hugo-apps/src/shared/pip-storage.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { loadPipMode, savePipMode, PIP_MODE_KEY } from './pip-storage';

beforeEach(() => {
  localStorage.clear();
});

describe('pip-storage', () => {
  it('returns "full" when no preference saved', () => {
    expect(loadPipMode()).toBe('full');
  });

  it('round-trips a saved mode', () => {
    savePipMode('controller');
    expect(loadPipMode()).toBe('controller');
  });

  it('uses the documented key', () => {
    savePipMode('controller');
    expect(localStorage.getItem(PIP_MODE_KEY)).toBe('controller');
  });

  it('returns "full" if the stored value is not a valid mode', () => {
    localStorage.setItem(PIP_MODE_KEY, 'garbage');
    expect(loadPipMode()).toBe('full');
  });
});
```

The Vitest unit project runs in `node` environment by default, but Vue island tests need the DOM. Add a `// @vitest-environment happy-dom` pragma at the top of the test file, mirroring how component-touching tests are run in this project. (Check existing pattern at `hugo-apps/src/navigator/cardProgress.test.ts` — that test is pure TS so doesn't need DOM. This one does for `localStorage`.)

Add the pragma:
```ts
// @vitest-environment happy-dom
```
as the very first line of the test file.

- [ ] **Step 2.2: Run test, verify it fails**

Run:
```bash
npx vitest run hugo-apps/src/shared/pip-storage.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 2.3: Implement**

```ts
// hugo-apps/src/shared/pip-storage.ts
import type { PipMode } from './pip-types';

export const PIP_MODE_KEY = 'sap-tutorials-pip-mode';

export function loadPipMode(): PipMode {
  try {
    const v = localStorage.getItem(PIP_MODE_KEY);
    return v === 'controller' ? 'controller' : 'full';
  } catch {
    return 'full';
  }
}

export function savePipMode(mode: PipMode): void {
  try {
    localStorage.setItem(PIP_MODE_KEY, mode);
  } catch {
    // ignore quota / private-mode failures
  }
}
```

- [ ] **Step 2.4: Run test, verify pass**

Run:
```bash
npx vitest run hugo-apps/src/shared/pip-storage.test.ts
```

Expected: 4 passing.

- [ ] **Step 2.5: Commit**

```bash
git add hugo-apps/src/shared/pip-storage.ts hugo-apps/src/shared/pip-storage.test.ts
git commit -m "feat(pip): add localStorage helper for PiP mode preference"
```

---

## Task 3: pip-channel (typed BroadcastChannel wrapper)

**Files:**
- Create: `hugo-apps/src/shared/pip-channel.ts`
- Test: `hugo-apps/src/shared/pip-channel.test.ts`

The channel wrapper is the single point that:
1. Auto-stamps `senderId` (a per-instance UUID) and `source` on every send.
2. Drops messages where `senderId === ourId` (self-broadcast loop prevention).
3. Names channels per slug: `tutorial-pip:<slug>`.

- [ ] **Step 3.1: Write failing test**

```ts
// hugo-apps/src/shared/pip-channel.test.ts
// @vitest-environment happy-dom
import { describe, it, expect, vi } from 'vitest';
import { createPipChannel } from './pip-channel';
import type { PipMessage } from './pip-types';

describe('pip-channel', () => {
  it('drops messages from its own senderId', async () => {
    const main = createPipChannel('demo-slug', 'main');
    const handler = vi.fn();
    main.on(handler);
    main.send({ type: 'pip:stepChange', stepIndex: 3 } as Omit<PipMessage, 'senderId' | 'source'>);
    await new Promise(r => setTimeout(r, 10));
    expect(handler).not.toHaveBeenCalled();
    main.close();
  });

  it('delivers messages from a different senderId on the same channel', async () => {
    const a = createPipChannel('demo-slug', 'main');
    const b = createPipChannel('demo-slug', 'pip');
    const handler = vi.fn();
    a.on(handler);
    b.send({ type: 'pip:stepChange', stepIndex: 5 } as Omit<PipMessage, 'senderId' | 'source'>);
    await new Promise(r => setTimeout(r, 10));
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0][0]).toMatchObject({
      type: 'pip:stepChange',
      stepIndex: 5,
      source: 'pip',
    });
    expect(typeof handler.mock.calls[0][0].senderId).toBe('string');
    a.close();
    b.close();
  });

  it('isolates channels by slug', async () => {
    const a = createPipChannel('slug-a', 'main');
    const b = createPipChannel('slug-b', 'pip');
    const handler = vi.fn();
    a.on(handler);
    b.send({ type: 'pip:stepChange', stepIndex: 1 } as Omit<PipMessage, 'senderId' | 'source'>);
    await new Promise(r => setTimeout(r, 10));
    expect(handler).not.toHaveBeenCalled();
    a.close();
    b.close();
  });

  it('returns an unsubscribe function from on()', async () => {
    const a = createPipChannel('demo-slug-2', 'main');
    const b = createPipChannel('demo-slug-2', 'pip');
    const handler = vi.fn();
    const off = a.on(handler);
    off();
    b.send({ type: 'pip:stepChange', stepIndex: 1 } as Omit<PipMessage, 'senderId' | 'source'>);
    await new Promise(r => setTimeout(r, 10));
    expect(handler).not.toHaveBeenCalled();
    a.close();
    b.close();
  });
});
```

> **Caveat:** happy-dom historically had partial `BroadcastChannel` support. If the test fails with "BroadcastChannel is not defined" or "channels do not deliver across instances," polyfill it in the test file's setup with a tiny in-memory shim before the imports, OR switch the test environment to `jsdom` for this file (jsdom ≥ 21 has full support). The wrapper itself doesn't change. The implementation step below assumes a working `BroadcastChannel`. **Recommendation: try happy-dom first, fall back to jsdom for this test only.**

- [ ] **Step 3.2: Run test, verify it fails**

Run:
```bash
npx vitest run hugo-apps/src/shared/pip-channel.test.ts
```

Expected: FAIL with "createPipChannel is not exported."

- [ ] **Step 3.3: Implement**

```ts
// hugo-apps/src/shared/pip-channel.ts
import type { PipMessage, PipSource } from './pip-types';

type OutgoingMessage = Omit<PipMessage, 'senderId' | 'source'>;

export type PipChannel = {
  send(msg: OutgoingMessage): void;
  on(handler: (msg: PipMessage) => void): () => void;
  close(): void;
};

export function createPipChannel(slug: string, source: PipSource): PipChannel {
  const channel = new BroadcastChannel(`tutorial-pip:${slug}`);
  const senderId = (typeof crypto !== 'undefined' && crypto.randomUUID)
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;

  return {
    send(msg) {
      const stamped = { ...msg, senderId, source } as PipMessage;
      channel.postMessage(stamped);
    },
    on(handler) {
      const listener = (e: MessageEvent<PipMessage>) => {
        if (!e.data || e.data.senderId === senderId) return;
        handler(e.data);
      };
      channel.addEventListener('message', listener);
      return () => channel.removeEventListener('message', listener);
    },
    close() {
      channel.close();
    },
  };
}
```

- [ ] **Step 3.4: Run test, verify pass**

Run:
```bash
npx vitest run hugo-apps/src/shared/pip-channel.test.ts
```

Expected: 4 passing. If happy-dom fails on `BroadcastChannel`, add `// @vitest-environment jsdom` instead and re-run; verify jsdom is available (`grep jsdom package.json`). If not present, install: `npm install --save-dev jsdom`.

- [ ] **Step 3.5: Commit**

```bash
git add hugo-apps/src/shared/pip-channel.ts hugo-apps/src/shared/pip-channel.test.ts
git commit -m "feat(pip): add typed BroadcastChannel wrapper with self-broadcast guard"
```

---

## Task 4: useStepNavigation composable + tests

**Files:**
- Create: `hugo-apps/src/tutorial-pip/useStepNavigation.ts`
- Test: `hugo-apps/src/tutorial-pip/useStepNavigation.test.ts`

Pure-logic composable used by the PiP island. Calls the existing `/completeStep` endpoint. Bounds-checks step navigation.

- [ ] **Step 4.1: Write failing test**

```ts
// hugo-apps/src/tutorial-pip/useStepNavigation.test.ts
// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ref } from 'vue';
import { useStepNavigation } from './useStepNavigation';
import type { StepPayload } from '../shared/pip-types';

const steps: StepPayload[] = [
  { stepIndex: 1, heading: 'A', html: '<p>a</p>' },
  { stepIndex: 2, heading: 'B', html: '<p>b</p>' },
  { stepIndex: 3, heading: 'C', html: '<p>c</p>' },
];

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('useStepNavigation', () => {
  it('next() advances within bounds', () => {
    const active = ref(1);
    const nav = useStepNavigation('demo', steps, active);
    nav.next();
    expect(active.value).toBe(2);
  });

  it('next() at last step is a no-op', () => {
    const active = ref(3);
    const nav = useStepNavigation('demo', steps, active);
    nav.next();
    expect(active.value).toBe(3);
  });

  it('prev() at first step is a no-op', () => {
    const active = ref(1);
    const nav = useStepNavigation('demo', steps, active);
    nav.prev();
    expect(active.value).toBe(1);
  });

  it('goto() clamps out-of-range indexes', () => {
    const active = ref(1);
    const nav = useStepNavigation('demo', steps, active);
    nav.goto(99);
    expect(active.value).toBe(1);
    nav.goto(-1);
    expect(active.value).toBe(1);
    nav.goto(2);
    expect(active.value).toBe(2);
  });

  it('completeStep returns true on 2xx, advances, no exception', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('{"ok":true}', { status: 200 })
    );
    const active = ref(1);
    const nav = useStepNavigation('demo', steps, active);
    const ok = await nav.completeStep(1);
    expect(ok).toBe(true);
    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(fetchSpy.mock.calls[0][0]).toMatch(/\/completeStep/);
  });

  it('completeStep returns false on non-2xx, does not throw', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('', { status: 500 }));
    const active = ref(1);
    const nav = useStepNavigation('demo', steps, active);
    const ok = await nav.completeStep(1);
    expect(ok).toBe(false);
  });

  it('completeStep returns false on network error, does not throw', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('net'));
    const active = ref(1);
    const nav = useStepNavigation('demo', steps, active);
    const ok = await nav.completeStep(1);
    expect(ok).toBe(false);
  });
});
```

- [ ] **Step 4.2: Run test, verify it fails**

Run:
```bash
npx vitest run hugo-apps/src/tutorial-pip/useStepNavigation.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 4.3: Implement**

```ts
// hugo-apps/src/tutorial-pip/useStepNavigation.ts
import type { Ref } from 'vue';
import type { StepPayload } from '../shared/pip-types';

export function useStepNavigation(
  slug: string,
  steps: StepPayload[],
  activeStep: Ref<number>
) {
  const minIndex = steps[0]?.stepIndex ?? 1;
  const maxIndex = steps[steps.length - 1]?.stepIndex ?? 1;

  function clamp(idx: number): number | null {
    if (!Number.isFinite(idx)) return null;
    if (idx < minIndex || idx > maxIndex) return null;
    return idx;
  }

  return {
    next() {
      const target = activeStep.value + 1;
      if (target <= maxIndex) activeStep.value = target;
    },
    prev() {
      const target = activeStep.value - 1;
      if (target >= minIndex) activeStep.value = target;
    },
    goto(idx: number) {
      const c = clamp(idx);
      if (c !== null) activeStep.value = c;
    },
    async completeStep(stepIndex: number): Promise<boolean> {
      try {
        const res = await fetch('/api/completeStep', {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ slug, stepNumber: stepIndex }),
        });
        return res.ok;
      } catch {
        return false;
      }
    },
  };
}
```

> **Endpoint note:** `tutorial.ts:227` calls `/completeStep` (no `/api/` prefix) via the `apiPost` helper, which prepends `/api`. The PiP window does direct `fetch` (no helper available cross-window without re-importing it), so the path must be the full one. Verify by running `grep -n "completeStep" srv/*.cds` to confirm the action is exposed at `/api/completeStep`. If it's actually at a different path, update the implementation to match.

- [ ] **Step 4.4: Run test, verify pass**

Run:
```bash
npx vitest run hugo-apps/src/tutorial-pip/useStepNavigation.test.ts
```

Expected: 7 passing.

- [ ] **Step 4.5: Commit**

```bash
git add hugo-apps/src/tutorial-pip/useStepNavigation.ts hugo-apps/src/tutorial-pip/useStepNavigation.test.ts
git commit -m "feat(pip): add useStepNavigation composable with completion API"
```

---

## Task 5: PiP-side Vue components

**Files:**
- Create: `hugo-apps/src/tutorial-pip/PipShell.vue`
- Create: `hugo-apps/src/tutorial-pip/FullMode.vue`
- Create: `hugo-apps/src/tutorial-pip/ControllerMode.vue`
- Create: `hugo-apps/src/tutorial-pip/main.ts`

These render *inside the popped-out PiP window*. Components are intentionally simple — most logic lives in the composable from Task 4.

- [ ] **Step 5.1: Create `PipShell.vue`**

```vue
<!-- hugo-apps/src/tutorial-pip/PipShell.vue -->
<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount, watch } from 'vue';
import FullMode from './FullMode.vue';
import ControllerMode from './ControllerMode.vue';
import { useStepNavigation } from './useStepNavigation';
import { createPipChannel } from '../shared/pip-channel';
import { savePipMode } from '../shared/pip-storage';
import type { PipMode, StepPayload, PipMessage } from '../shared/pip-types';

const props = defineProps<{
  slug: string;
  steps: StepPayload[];
  initialStepIndex: number;
  initialMode: PipMode;
}>();

const activeStep = ref(props.initialStepIndex);
const mode = ref<PipMode>(props.initialMode);
const errorMessage = ref<string | null>(null);

const channel = createPipChannel(props.slug, 'pip');
const nav = useStepNavigation(props.slug, props.steps, activeStep);

const currentStep = computed(() =>
  props.steps.find(s => s.stepIndex === activeStep.value) ?? props.steps[0]
);
const isLastStep = computed(() => activeStep.value === props.steps[props.steps.length - 1]?.stepIndex);

function broadcastStep() {
  channel.send({ type: 'pip:stepChange', stepIndex: activeStep.value });
}

function handleNext() {
  nav.next();
  broadcastStep();
}
function handlePrev() {
  nav.prev();
  broadcastStep();
}
function handleGoto(idx: number) {
  nav.goto(idx);
  broadcastStep();
}
async function handleComplete(stepIndex: number) {
  errorMessage.value = null;
  const ok = await nav.completeStep(stepIndex);
  if (!ok) {
    errorMessage.value = 'Could not save completion. Please try again.';
    return;
  }
  channel.send({ type: 'pip:complete', stepIndex });
  nav.next();
  channel.send({ type: 'pip:stepChange', stepIndex: activeStep.value });
}
function handleToggleMode() {
  mode.value = mode.value === 'full' ? 'controller' : 'full';
  savePipMode(mode.value);
  channel.send({ type: 'pip:modeChange', mode: mode.value });
}

// Auto-collapse / auto-expand on resize threshold (300px tall).
let ro: ResizeObserver | null = null;
onMounted(() => {
  ro = new ResizeObserver(entries => {
    for (const e of entries) {
      const h = e.contentRect.height;
      if (h < 300 && mode.value === 'full') {
        mode.value = 'controller';
        savePipMode('controller');
      } else if (h >= 300 && mode.value === 'controller') {
        mode.value = 'full';
        savePipMode('full');
      }
    }
  });
  ro.observe(document.documentElement);
});

// Subscribe to remote messages from the main tab.
const off = channel.on((msg: PipMessage) => {
  switch (msg.type) {
    case 'pip:stepChange':
      nav.goto(msg.stepIndex);
      break;
    case 'pip:complete':
      // Main tab marked it complete (e.g. user clicked in main tab).
      // No-op for active step; nav stays where it is.
      break;
    case 'pip:themeChange':
      document.documentElement.dataset.theme = msg.theme;
      if (msg.theme === 'dark') document.documentElement.classList.add('dark');
      else document.documentElement.classList.remove('dark');
      break;
    case 'pip:closed':
      // Main tab is signaling it's gone away; we close ourselves.
      window.close();
      break;
  }
});

onBeforeUnmount(() => {
  off();
  ro?.disconnect();
  channel.send({ type: 'pip:closed' });
  channel.close();
});
</script>

<template>
  <div class="pip-shell" :data-mode="mode">
    <ui5-message-strip v-if="errorMessage" design="Negative" hide-close-button>
      {{ errorMessage }}
    </ui5-message-strip>
    <FullMode
      v-if="mode === 'full'"
      :step="currentStep"
      :step-count="steps.length"
      :is-last="isLastStep"
      @next="handleNext"
      @prev="handlePrev"
      @complete="handleComplete"
      @toggle-mode="handleToggleMode"
    />
    <ControllerMode
      v-else
      :step="currentStep"
      :steps="steps"
      :active-step="activeStep"
      :is-last="isLastStep"
      @next="handleNext"
      @prev="handlePrev"
      @goto="handleGoto"
      @complete="handleComplete"
      @toggle-mode="handleToggleMode"
    />
  </div>
</template>
```

- [ ] **Step 5.2: Create `FullMode.vue`**

```vue
<!-- hugo-apps/src/tutorial-pip/FullMode.vue -->
<script setup lang="ts">
import type { StepPayload } from '../shared/pip-types';
defineProps<{
  step: StepPayload;
  stepCount: number;
  isLast: boolean;
}>();
defineEmits<{
  (e: 'next'): void;
  (e: 'prev'): void;
  (e: 'complete', stepIndex: number): void;
  (e: 'toggle-mode'): void;
}>();
</script>

<template>
  <div class="pip-full">
    <header class="pip-full__header">
      <h2>{{ step.heading }}</h2>
      <button type="button" class="pip-mode-toggle" @click="$emit('toggle-mode')" aria-label="Switch to controller mode">⌃</button>
    </header>
    <div class="pip-full__body" v-html="step.html" />
    <footer class="pip-full__footer">
      <ui5-button @click="$emit('prev')" icon="navigation-left-arrow" tooltip="Previous step" />
      <span class="pip-step-count">{{ step.stepIndex }} / {{ stepCount }}</span>
      <ui5-button @click="$emit('next')" icon="navigation-right-arrow" tooltip="Next step" />
      <ui5-button design="Emphasized" @click="$emit('complete', step.stepIndex)">
        {{ isLast ? 'Finish tutorial' : 'Mark complete' }}
      </ui5-button>
    </footer>
  </div>
</template>
```

- [ ] **Step 5.3: Create `ControllerMode.vue`**

```vue
<!-- hugo-apps/src/tutorial-pip/ControllerMode.vue -->
<script setup lang="ts">
import type { StepPayload } from '../shared/pip-types';
defineProps<{
  step: StepPayload;
  steps: StepPayload[];
  activeStep: number;
  isLast: boolean;
}>();
defineEmits<{
  (e: 'next'): void;
  (e: 'prev'): void;
  (e: 'goto', stepIndex: number): void;
  (e: 'complete', stepIndex: number): void;
  (e: 'toggle-mode'): void;
}>();
</script>

<template>
  <div class="pip-controller">
    <span class="pip-controller__title" :title="step.heading">{{ step.heading }}</span>
    <ui5-button @click="$emit('prev')" icon="navigation-left-arrow" tooltip="Previous step" />
    <ui5-button @click="$emit('next')" icon="navigation-right-arrow" tooltip="Next step" />
    <div class="pip-controller__dots">
      <button
        v-for="s in steps"
        :key="s.stepIndex"
        type="button"
        class="pip-controller__dot"
        :class="{ active: s.stepIndex === activeStep }"
        :aria-label="`Go to step ${s.stepIndex}`"
        @click="$emit('goto', s.stepIndex)"
      />
    </div>
    <ui5-button design="Emphasized" @click="$emit('complete', step.stepIndex)">
      {{ isLast ? 'Finish' : 'Done' }}
    </ui5-button>
    <button type="button" class="pip-mode-toggle" @click="$emit('toggle-mode')" aria-label="Expand to full mode">⌄</button>
  </div>
</template>
```

- [ ] **Step 5.4: Create `main.ts`**

```ts
// hugo-apps/src/tutorial-pip/main.ts
// Mount entry called by the launcher INSIDE the popped-out PiP window.
// The launcher copies CSS, then writes a <div id="tutorial-pip-mount"> into
// the PiP document and dispatches a custom event with the payload.

import { createApp } from 'vue';
import PipShell from './PipShell.vue';
import type { PipMode, StepPayload } from '../shared/pip-types';

export type PipBootstrap = {
  slug: string;
  steps: StepPayload[];
  initialStepIndex: number;
  initialMode: PipMode;
};

export function mountPip(doc: Document, payload: PipBootstrap): void {
  const el = doc.getElementById('tutorial-pip-mount');
  if (!el) return;
  createApp(PipShell, payload).mount(el);
}

// Allow the launcher to call into us via global on the PiP window.
(globalThis as any).__mountTutorialPip = mountPip;
```

- [ ] **Step 5.5: TypeScript-compile + ensure no test regressions**

Run:
```bash
( cd hugo-apps && npx tsc --noEmit )
npx vitest run hugo-apps
```

Expected: tsc clean, all hugo-apps tests still passing.

- [ ] **Step 5.6: Commit**

```bash
git add hugo-apps/src/tutorial-pip/
git commit -m "feat(pip): add PipShell + Full/Controller mode components + mount entry"
```

---

## Task 6: Launcher composable + Vue component

**Files:**
- Create: `hugo-apps/src/tutorial-pip-launcher/usePipLifecycle.ts`
- Test: `hugo-apps/src/tutorial-pip-launcher/usePipLifecycle.test.ts`
- Create: `hugo-apps/src/tutorial-pip-launcher/Launcher.vue`
- Create: `hugo-apps/src/tutorial-pip-launcher/main.ts`

The lifecycle composable is the messy part: opening the PiP window, cloning CSS/fonts, dropping the mount node, calling `mountPip`, theme observer, channel routing, close-handling.

- [ ] **Step 6.1: Write failing test for lifecycle utilities**

```ts
// hugo-apps/src/tutorial-pip-launcher/usePipLifecycle.test.ts
// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { isPipSupported, cloneStylesIntoDocument } from './usePipLifecycle';

describe('isPipSupported', () => {
  beforeEach(() => {
    delete (window as any).documentPictureInPicture;
  });

  it('returns false when API absent', () => {
    expect(isPipSupported()).toBe(false);
  });

  it('returns true when API present', () => {
    (window as any).documentPictureInPicture = { requestWindow: vi.fn() };
    expect(isPipSupported()).toBe(true);
  });
});

describe('cloneStylesIntoDocument', () => {
  it('clones <link rel="stylesheet"> nodes into the target head', () => {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = 'https://example.invalid/test.css';
    document.head.appendChild(link);

    const target = document.implementation.createHTMLDocument('pip');
    cloneStylesIntoDocument(document, target);

    const cloned = target.head.querySelectorAll('link[rel="stylesheet"]');
    expect(cloned.length).toBe(1);
    expect(cloned[0].getAttribute('href')).toBe('https://example.invalid/test.css');

    link.remove();
  });

  it('clones inline <style> nodes', () => {
    const style = document.createElement('style');
    style.textContent = '.foo { color: red; }';
    document.head.appendChild(style);

    const target = document.implementation.createHTMLDocument('pip');
    cloneStylesIntoDocument(document, target);

    const styles = target.head.querySelectorAll('style');
    expect(styles.length).toBeGreaterThanOrEqual(1);
    const found = Array.from(styles).some(s => s.textContent?.includes('.foo'));
    expect(found).toBe(true);

    style.remove();
  });
});
```

- [ ] **Step 6.2: Run test, verify it fails**

Run:
```bash
npx vitest run hugo-apps/src/tutorial-pip-launcher/usePipLifecycle.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 6.3: Implement composable**

```ts
// hugo-apps/src/tutorial-pip-launcher/usePipLifecycle.ts
import { ref, onBeforeUnmount } from 'vue';
import { createPipChannel, type PipChannel } from '../shared/pip-channel';
import { loadPipMode } from '../shared/pip-storage';
import type { PipMode, StepPayload, PipMessage } from '../shared/pip-types';

export function isPipSupported(): boolean {
  return typeof window !== 'undefined' && 'documentPictureInPicture' in window;
}

export function cloneStylesIntoDocument(src: Document, dest: Document): void {
  // <link rel="stylesheet"> + <link rel="preconnect" for fonts> + <style>
  const links = src.head.querySelectorAll('link[rel="stylesheet"], link[rel="preconnect"], link[rel="preload"]');
  links.forEach(node => dest.head.appendChild(node.cloneNode(true)));
  const styles = src.head.querySelectorAll('style');
  styles.forEach(node => dest.head.appendChild(node.cloneNode(true)));
}

export type LauncherCtx = {
  slug: string;
  getActiveStep: () => number;
  getSteps: () => StepPayload[];
};

export function usePipLifecycle(ctx: LauncherCtx) {
  const pipWindow = ref<Window | null>(null);
  let channel: PipChannel | null = null;
  let themeObserver: MutationObserver | null = null;
  let stepListener: ((e: Event) => void) | null = null;
  let completeListener: ((e: Event) => void) | null = null;

  async function open(): Promise<boolean> {
    if (!isPipSupported()) return false;
    const mode = loadPipMode();
    const dims = mode === 'full' ? { width: 480, height: 720 } : { width: 480, height: 140 };
    let win: Window;
    try {
      win = await (window as any).documentPictureInPicture.requestWindow(dims);
    } catch {
      return false;
    }

    cloneStylesIntoDocument(document, win.document);
    // Mirror initial theme.
    const theme = document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
    win.document.documentElement.dataset.theme = theme;
    if (theme === 'dark') win.document.documentElement.classList.add('dark');

    // Drop mount node.
    const mount = win.document.createElement('div');
    mount.id = 'tutorial-pip-mount';
    win.document.body.appendChild(mount);

    // Inject the bundle into the PiP window. We piggy-back on the same
    // /js/tutorial-pip.js that was loaded into the main tab — but only the
    // PiP window's `globalThis` will have `__mountTutorialPip` if we load
    // the script there. Easiest path: copy the <script> tag the main page
    // already includes.
    const tagSelector = 'script[src*="/js/tutorial-pip.js"]';
    const scriptTag = document.querySelector<HTMLScriptElement>(tagSelector);
    if (!scriptTag) {
      win.close();
      return false;
    }
    const cloned = win.document.createElement('script');
    cloned.src = scriptTag.src;
    cloned.type = scriptTag.type || 'text/javascript';
    cloned.onload = () => {
      const mountFn = (win as any).__mountTutorialPip;
      if (mountFn) {
        mountFn(win.document, {
          slug: ctx.slug,
          steps: ctx.getSteps(),
          initialStepIndex: ctx.getActiveStep(),
          initialMode: mode,
        });
      }
    };
    win.document.body.appendChild(cloned);

    pipWindow.value = win;
    channel = createPipChannel(ctx.slug, 'main');

    // Theme MutationObserver.
    themeObserver = new MutationObserver(() => {
      const t = document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
      channel?.send({ type: 'pip:themeChange', theme: t });
    });
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme', 'class'],
    });

    // Receive step changes / completions from PiP and apply to main tab.
    channel.on((msg: PipMessage) => {
      switch (msg.type) {
        case 'pip:stepChange':
          // Scroll the main tab to that step.
          {
            const node = document.querySelector<HTMLElement>(`.tutorial-step[data-step="${msg.stepIndex}"]`);
            node?.scrollIntoView({ behavior: 'smooth', block: 'start' });
          }
          break;
        case 'pip:complete':
          // Update U11 progress bar UI without re-fetching.
          {
            const step = document.querySelector<HTMLElement>(`.tutorial-step[data-step="${msg.stepIndex}"]`);
            step?.classList.add('completed');
            const tocItem = document.querySelector<HTMLElement>(`.step-toc-item[data-toc-step="${msg.stepIndex}"]`);
            tocItem?.classList.add('completed');
          }
          break;
        case 'pip:closed':
          // PiP window has shut down — clean up.
          cleanup();
          break;
      }
    });

    // Listen for U11 step-change events in main tab → broadcast to PiP.
    stepListener = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail && typeof detail.stepIndex === 'number') {
        channel?.send({ type: 'pip:stepChange', stepIndex: detail.stepIndex });
      }
    };
    document.addEventListener('tutorial:step-change', stepListener);

    // Listen for main-tab completion events → broadcast to PiP.
    completeListener = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail && typeof detail.stepIndex === 'number') {
        channel?.send({ type: 'pip:complete', stepIndex: detail.stepIndex });
      }
    };
    document.addEventListener('tutorial:step-completed', completeListener);

    // Track PiP closure.
    win.addEventListener('pagehide', () => cleanup(), { once: true });
    return true;
  }

  function close(): void {
    pipWindow.value?.close();
    cleanup();
  }

  function cleanup(): void {
    pipWindow.value = null;
    channel?.close();
    channel = null;
    themeObserver?.disconnect();
    themeObserver = null;
    if (stepListener) document.removeEventListener('tutorial:step-change', stepListener);
    if (completeListener) document.removeEventListener('tutorial:step-completed', completeListener);
    stepListener = null;
    completeListener = null;
  }

  onBeforeUnmount(cleanup);

  return { pipWindow, open, close };
}
```

- [ ] **Step 6.4: Run lifecycle tests**

Run:
```bash
npx vitest run hugo-apps/src/tutorial-pip-launcher/usePipLifecycle.test.ts
```

Expected: 4 passing (the two `isPipSupported` and the two `cloneStylesIntoDocument`). The `usePipLifecycle` composable itself isn't unit-tested in detail because the manual orchestration involves real cross-window APIs that aren't faithfully represented in happy-dom — covered by manual smoke instead.

- [ ] **Step 6.5: Create `Launcher.vue`**

```vue
<!-- hugo-apps/src/tutorial-pip-launcher/Launcher.vue -->
<script setup lang="ts">
import { computed } from 'vue';
import { usePipLifecycle } from './usePipLifecycle';
import type { StepPayload } from '../shared/pip-types';

const props = defineProps<{
  slug: string;
  steps: StepPayload[];
  initialActiveStep: number;
}>();

const { pipWindow, open, close } = usePipLifecycle({
  slug: props.slug,
  getActiveStep: () => {
    // Read current step from DOM (U11 maintains data-toc-item.active).
    const active = document.querySelector<HTMLElement>('.step-toc-item.active');
    const idx = active ? parseInt(active.dataset.tocStep || '', 10) : props.initialActiveStep;
    return Number.isFinite(idx) ? idx : props.initialActiveStep;
  },
  getSteps: () => props.steps,
});

const isOpen = computed(() => !!pipWindow.value);

async function onClick() {
  if (isOpen.value) {
    close();
  } else {
    const ok = await open();
    if (!ok) {
      const toast = document.querySelector<HTMLElement>('#tutorial-pip-toast');
      if (toast) (toast as any).show?.();
    }
  }
}
</script>

<template>
  <ui5-button
    :icon="isOpen ? 'navigation-down-arrow' : 'navigation-up-arrow'"
    :tooltip="isOpen ? 'Close pop-out window' : 'Pop out current step'"
    @click="onClick"
  />
  <ui5-toast id="tutorial-pip-toast" placement="BottomCenter" duration="3500">
    Pop-out window blocked. Check site permissions and try again.
  </ui5-toast>
</template>
```

- [ ] **Step 6.6: Create `main.ts`**

```ts
// hugo-apps/src/tutorial-pip-launcher/main.ts
import { createApp } from 'vue';
import Launcher from './Launcher.vue';
import { isPipSupported } from './usePipLifecycle';
import type { StepPayload } from '../shared/pip-types';

const el = document.getElementById('tutorial-pip-launcher');
if (el && isPipSupported()) {
  const slug = el.dataset.slug || '';
  const initialActiveStep = parseInt(el.dataset.activeStep || '1', 10);
  const stepsScript = document.getElementById('tutorial-pip-steps') as HTMLScriptElement | null;
  let steps: StepPayload[] = [];
  if (stepsScript?.textContent) {
    try {
      steps = JSON.parse(stepsScript.textContent);
    } catch {
      steps = [];
    }
  }
  if (slug && steps.length > 0) {
    createApp(Launcher, { slug, steps, initialActiveStep }).mount(el);
  }
}
```

- [ ] **Step 6.7: TypeScript compile**

Run:
```bash
( cd hugo-apps && npx tsc --noEmit )
```

Expected: clean.

- [ ] **Step 6.8: Commit**

```bash
git add hugo-apps/src/tutorial-pip-launcher/
git commit -m "feat(pip): add launcher composable + button component + mount entry"
```

---

## Task 7: Wire islands into the build

**Files:**
- Modify: `hugo-apps/vite.config.ts`

- [ ] **Step 7.1: Edit vite.config.ts**

Add two new entries to `rollupOptions.input`:
```ts
'tutorial-pip-launcher': resolve(__dirname, 'src/tutorial-pip-launcher/main.ts'),
'tutorial-pip': resolve(__dirname, 'src/tutorial-pip/main.ts'),
```

Position alphabetically with the others.

- [ ] **Step 7.2: Build and verify outputs**

Run:
```bash
( cd hugo-apps && npm run build )
ls hugo/static/js/ | grep -E "tutorial-pip"
```

Expected:
```
tutorial-pip-launcher.js
tutorial-pip.js
```

- [ ] **Step 7.3: Commit**

```bash
git add hugo-apps/vite.config.ts hugo/static/js/tutorial-pip-launcher.js hugo/static/js/tutorial-pip.js
git commit -m "build(pip): register PiP island bundles in vite config"
```

> Note: the project commits built JS into `hugo/static/js/` (precedent — those are tracked files). Confirm with `git ls-files hugo/static/js/ | head` if unsure; if not tracked, omit them from `git add`.

---

## Task 8: Hugo template wiring

**Files:**
- Modify: `hugo/layouts/tutorials/u1-object-page.html`
- Modify: `hugo/layouts/tutorials/single.html`

The launcher mounts at `#tutorial-pip-launcher`. The steps payload is emitted as a JSON island `<script id="tutorial-pip-steps" type="application/json">`. The Hugo content-step iteration is what generates this list.

- [ ] **Step 8.1: Inspect existing step-rendering loop**

Run:
```bash
grep -n "tutorial-step\|range \.Params.steps\|range \.Pages\|step-toc-item" hugo/layouts/tutorials/u1-object-page.html | head -20
```

This locates how the layout iterates steps. The JSON island goes adjacent to the existing `#progress-bar` mount (currently around line 262).

- [ ] **Step 8.2: Edit `u1-object-page.html`**

Find the line:
```hugo
{{ if and (not site.Params.qa) (not site.Params.previewMode) }}<div id="progress-bar" data-step-count="{{ .Params.stepCount }}" data-slug="{{ .Params.slug }}"></div>{{ end }}
```

Add immediately after it:

```hugo
{{ if and (not site.Params.qa) (not site.Params.previewMode) }}
  <div id="tutorial-pip-launcher"
       data-slug="{{ .Params.slug }}"
       data-step-count="{{ .Params.stepCount }}"
       data-active-step="1"></div>
  <script id="tutorial-pip-steps" type="application/json">
    [
      {{ range $i, $step := .Params.steps }}{{ if $i }},{{ end }}{
        "stepIndex": {{ add $i 1 }},
        "heading": {{ $step.title | jsonify }},
        "html": {{ $step.content | jsonify }}
      }{{ end }}
    ]
  </script>
{{ end }}
```

> **Hugo step-data verification step:** Before committing, render a sample tutorial page locally (`npm run dev`) and view the source. Confirm `<script id="tutorial-pip-steps">` contains a non-empty array. The exact path inside `.Params` depends on parser version (V2 places step bodies under `.Params.steps[].content`; V1 may differ). If the field name is wrong, inspect a generated `hugo/content/tutorials/<slug>.md` to find the correct frontmatter path. Update the Hugo template to match.

- [ ] **Step 8.3: Add the bundle to the layout**

Find the existing `<script>` includes near the bottom of `u1-object-page.html` (around `{{ partial "tutorial-foot" . }}` or before `</body>`). Add (alphabetically placed near other island scripts):

```hugo
<script type="module" src="/js/tutorial-pip-launcher.js"></script>
```

The PiP-side bundle (`tutorial-pip.js`) is *also* loaded on the main page so the launcher's `cloneNode` of the script tag finds an existing tag to copy. So add:

```hugo
<script type="module" src="/js/tutorial-pip.js"></script>
```

- [ ] **Step 8.4: Mirror changes in `single.html`**

Same edits, same locations. The layout file is older but still receives traffic.

- [ ] **Step 8.5: Verify a tutorial renders without error**

Run:
```bash
npm run fetch-tutorials
npm run dev
```

Open `http://localhost:1313/tutorials/<some-slug>/`. Open devtools.

Expected:
- No console errors.
- DOM contains `#tutorial-pip-launcher` and `#tutorial-pip-steps`.
- The pop-out button renders inside `#tutorial-pip-launcher` (you should see a `<ui5-button>` child).
- View source `#tutorial-pip-steps` shows valid JSON with non-empty `html` fields.

If `html` is empty or undefined, fix the Hugo `range` to use the correct field name (likely `content`, `body`, or another frontmatter key) and re-test.

- [ ] **Step 8.6: Commit**

```bash
git add hugo/layouts/tutorials/u1-object-page.html hugo/layouts/tutorials/single.html
git commit -m "feat(pip): mount launcher + emit steps payload from tutorial layouts"
```

---

## Task 9: Emit step-change + step-completed events from the main tab

**Files:**
- Modify: `hugo/assets/js/reading-progress.ts:65-75` (inside `applyActive()`)
- Modify: `hugo/assets/js/tutorial.ts:230-238` (inside `markDone()`, after success)

Without these two events, the launcher can't observe main-tab step changes or completions.

- [ ] **Step 9.1: Edit `reading-progress.ts`**

In `applyActive()` (around line 65), after the dedupe check `if (stepNum === lastActive) return; lastActive = stepNum;`, add immediately after:

```ts
if (stepNum) {
  document.dispatchEvent(new CustomEvent('tutorial:step-change', {
    detail: { stepIndex: parseInt(stepNum, 10) }
  }));
}
```

Place this *before* the `.step-toc-item` class manipulation so the event fires whether or not a TOC item exists.

- [ ] **Step 9.2: Edit `tutorial.ts`**

In `markDone()` (around line 230, inside `if (ok && step) { ... }`), immediately after `markButtonCompleted(btn)` and before `updateProgressBar()`:

```ts
document.dispatchEvent(new CustomEvent('tutorial:step-completed', {
  detail: { stepIndex: parseInt(stepNum, 10) }
}));
```

- [ ] **Step 9.3: Verify in dev**

```bash
npm run dev
```

Open devtools console. Run:
```js
document.addEventListener('tutorial:step-change', e => console.log('step-change', e.detail));
document.addEventListener('tutorial:step-completed', e => console.log('step-completed', e.detail));
```

Scroll the page. Click "Mark complete." Both events should fire.

- [ ] **Step 9.4: Commit**

```bash
git add hugo/assets/js/reading-progress.ts hugo/assets/js/tutorial.ts
git commit -m "feat(pip): dispatch tutorial:step-change + tutorial:step-completed events"
```

---

## Task 10: Smoke test for bundle deployment

**Files:**
- Create: `test/smoke/pip-bundle.test.ts`

- [ ] **Step 10.1: Write the smoke test**

```ts
// test/smoke/pip-bundle.test.ts
import { describe, it, expect } from 'vitest';

const BASE = process.env.SMOKE_BASE_URL ?? 'http://localhost:5000';

describe('PiP bundles deployed', () => {
  it('GET /js/tutorial-pip-launcher.js returns 200', async () => {
    const res = await fetch(`${BASE}/js/tutorial-pip-launcher.js`);
    expect(res.status).toBe(200);
    const txt = await res.text();
    expect(txt.length).toBeGreaterThan(0);
  });

  it('GET /js/tutorial-pip.js returns 200', async () => {
    const res = await fetch(`${BASE}/js/tutorial-pip.js`);
    expect(res.status).toBe(200);
    const txt = await res.text();
    expect(txt.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 10.2: Run locally against approuter**

```bash
npm run start:approuter &
SMOKE_BASE_URL=http://localhost:5000 npx vitest run --project smoke test/smoke/pip-bundle.test.ts
kill %1
```

Expected: both tests pass.

- [ ] **Step 10.3: Commit**

```bash
git add test/smoke/pip-bundle.test.ts
git commit -m "test(pip): smoke-check that PiP island bundles deploy"
```

---

## Task 11: Don't-break-existing-things checklist

This is the gate before opening a PR. The spec's bar is "never break anything where unsupported." We verify by running every test workspace.

- [ ] **Step 11.1: Run unit tests, full project**

```bash
npm test
```

Expected: same pass count as Step 0.4 baseline + the new PiP tests (Tasks 2, 3, 4, 6 = roughly 17 new tests).

- [ ] **Step 11.2: Run hybrid tests against DEV HANA**

```bash
cf login   # if not already logged in
cf target -s dev
npm run test:hybrid
```

Expected: all hybrid tests pass. PiP doesn't touch HANA, so no regressions expected.

- [ ] **Step 11.3: Build the full Hugo site**

```bash
npm run build:all
```

Expected: success. No errors about missing JSON island, no unexpected new files.

- [ ] **Step 11.4: Open a tutorial in Firefox**

Manually open the dev server in Firefox: `http://localhost:1313/tutorials/<some-slug>/`.

Verify:
- The U11 progress bar looks identical to today.
- The pop-out button does **not** render (`#tutorial-pip-launcher` exists but has no children).
- No console errors.

- [ ] **Step 11.5: Open a tutorial in Chrome**

Verify:
- Pop-out button renders.
- Click it. PiP window opens with full mode, current step content visible.
- Click Next in PiP. Main tab scrolls to next step.
- Scroll main tab past the next step. PiP swaps to the new step.
- Toggle dark mode in main tab (existing toggle in shellbar). PiP flips theme.
- Resize PiP small (under 300px tall). It auto-collapses to controller mode.
- Click chevron in controller mode to expand back.
- Click "Mark complete." Main tab's U11 progress bar fills the corresponding segment.
- Open Firefox in another window simultaneously, navigate to same tutorial. Verify no PiP interference.

If any step fails, debug and fix before proceeding. Do not skip.

- [ ] **Step 11.6: Commit any fixes**

If the manual verification turned up issues:
```bash
git add <files>
git commit -m "fix(pip): <what was fixed>"
```

---

## Task 12: Open the PR

- [ ] **Step 12.1: Push branch**

```bash
git push -u origin feat/pip-step-window
```

- [ ] **Step 12.2: Create the PR**

```bash
gh pr create --title "feat: Document PiP tutorial step window" --body "$(cat <<'EOF'
## Summary
- Adds a "Pop out step" button to the U11 progress bar that opens the current tutorial step in a Document Picture-in-Picture window
- Two-way sync between main tab and PiP via `BroadcastChannel` (step transitions, completions, theme)
- Full + controller modes, persisted to `localStorage`
- Chromium-only with silent feature-detection fallback

## Spec
[docs/superpowers/specs/2026-05-28-pip-step-window-design.md](docs/superpowers/specs/2026-05-28-pip-step-window-design.md)

## Test plan
- [ ] Unit tests pass (`npm test`)
- [ ] Hybrid tests pass against DEV (`npm run test:hybrid`)
- [ ] Smoke tests pass post-deploy (`npm run test:smoke`)
- [ ] Manual: Firefox shows no PiP button, U11 unchanged
- [ ] Manual: Chrome opens PiP, sync works both directions, theme mirrors, completion fires once
EOF
)"
```

Confirm with Tom on which scope to deploy (per project memory `feedback_confirm_deploy_scope.md`) before kicking off any deploy.

---

## Notes & gotchas (read before implementing)

- **Windows path quirks** — work happens in `.worktrees/feat-pip-step-window/` (Tom's project memory: parallel agents need worktrees). Beware CRLF flips on multi-section file edits — `git diff` after each edit. Run `file <path>` on any modified text file before committing if you've done multi-section work.
- **`apiPost` vs raw fetch** — the main-tab `tutorial.ts` uses `apiPost('/completeStep', ...)` which prepends `/api`. The PiP-side composable uses raw `fetch('/api/completeStep', ...)`. The PiP window is same-origin so cookies still flow.
- **Hugo step-data field name** — Step 8.2 has a verification step. Don't trust the `.Params.steps[].content` access path until you've confirmed it; check parser output in `hugo/content/tutorials/<slug>.md` if unsure.
- **`tutorial-pip.js` must be loaded on the main page** so the launcher can `cloneNode` an existing `<script>` tag to inject into the PiP window. If it's only referenced from `vite.config.ts` and not in the layout, the cloning step in Step 6.3 will fail.
- **CSS in the PiP window** — `cloneStylesIntoDocument` copies `<link>` and `<style>` nodes by reference (clone). If a stylesheet hasn't loaded by the time PiP opens, the cloned link will trigger its own fetch. Acceptable.
- **No theme MutationObserver leak** — `usePipLifecycle.cleanup()` disconnects it. Still, double-check that the listener isn't accidentally registered twice if open() is called while a window is already open. `Launcher.vue:onClick` guards via `isOpen`, so this should be safe.
- **Cross-tab cross-talk on same slug** — accepted gap per spec §13. Two main tabs both with PiP open will see each other's broadcasts. Symptom is harmless (steps stay in sync). Don't try to fix this in scope.
- **Memory pointer:** [feedback_pr_over_direct_merge.md](../../../.claude/memory/) — open a PR, don't fast-merge unless Tom says skip-the-PR.
