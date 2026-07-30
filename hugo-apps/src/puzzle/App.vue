<script setup lang="ts">
// hugo-apps/src/puzzle/App.vue
// Public crossword solver island. Ported from the POC React Puzzle.jsx.
// Handles: layout fetch, grid render, clue lists, click/type/arrows/backspace fill,
//          slot-level check, cross-device resume, completion + confetti.
// NO UI5 imports — theme CSS vars only (light/dark safe).

import { ref, computed, watch, onMounted } from 'vue';
import {
  buildSlots,
  advanceCursor,
  retreatCursor,
  findActiveSlot,
  cellKey,
  clueForSlot,
  type Cell,
  type Slot,
  type Cursor,
} from './lib/geometry';
import {
  probeAuth,
  buildCheckEntries,
  buildCellStatus,
  postCheck,
  fetchProgress,
  postSaveProgress,
  postComplete,
} from './lib/server';

const props = defineProps<{ slug: string; apiUrl: string }>();

// ── State ────────────────────────────────────────────────────────────────────
const loading = ref(true);
const error   = ref<string | null>(null);
const title   = ref('');
const grid    = ref<Cell[][]>([]);
const clues   = ref<Record<string, string>>({});

/** answers map: "r,c" → uppercase letter typed by the user */
const answers    = ref<Record<string, string>>({});
const cursor     = ref<Cursor | null>(null);
const dir        = ref<'across' | 'down'>('across');

/** per-cell check status: "r,c" → 'correct' | 'wrong' | undefined */
const cellStatus = ref<Record<string, 'correct' | 'wrong'>>({});

/** server/ui messages shown below the Check button */
const statusMsg  = ref<string | null>(null);

/** whether the puzzle has been completed (confetti + success banner) */
const solved     = ref(false);

/** whether current user is authenticated */
const authed     = ref(false);

// ── Derived ──────────────────────────────────────────────────────────────────
const slots = computed<Slot[]>(() =>
  grid.value.length ? buildSlots(grid.value) : []
);

const acrossSlots = computed(() =>
  slots.value.filter(s => s.dir === 'across').sort((a, b) => (a.number ?? 0) - (b.number ?? 0))
);
const downSlots = computed(() =>
  slots.value.filter(s => s.dir === 'down').sort((a, b) => (a.number ?? 0) - (b.number ?? 0))
);

const activeSlot = computed<Slot | null>(() =>
  cursor.value ? findActiveSlot(cursor.value, dir.value, slots.value) : null
);

const ROWS = computed(() => grid.value.length);
const COLS = computed(() => grid.value[0]?.length ?? 0);

/** true when at least one slot is fully filled (enables Check button) */
const hasFilledSlot = computed(() =>
  slots.value.some(s => s.cells.every(c => answers.value[`${c.r},${c.c}`]))
);

// ── Helpers ───────────────────────────────────────────────────────────────────
function isInActiveSlot(r: number, c: number): boolean {
  return activeSlot.value?.cells.some(cell => cell.r === r && cell.c === c) ?? false;
}

function isCursor(r: number, c: number): boolean {
  return cursor.value?.r === r && cursor.value?.c === c;
}

/** Find a slot that contains (r,c) in the given direction */
function slotAt(r: number, c: number, d: 'across' | 'down'): Slot | null {
  return slots.value.find(s => s.dir === d && s.cells.some(cell => cell.r === r && cell.c === c)) ?? null;
}

/** Persist answers to localStorage (always) */
function saveToLocalStorage() {
  try {
    localStorage.setItem(`puzzle-answers-${props.slug}`, JSON.stringify(answers.value));
  } catch {
    // storage full or private mode — ignore
  }
}

// ── Fetch layout ─────────────────────────────────────────────────────────────
async function loadPuzzle() {
  loading.value = true;
  error.value   = null;
  try {
    // OData filter: /puzzle-api/Puzzles?$filter=slug eq '<slug>'&$select=layout,title
    const url = `${props.apiUrl}/Puzzles?$filter=slug eq '${encodeURIComponent(props.slug)}'&$select=layout,title`;
    const res = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.json();
    const row  = Array.isArray(body.value) ? body.value[0] : null;
    if (!row) throw new Error('Puzzle not found');
    title.value = row.title ?? '';
    const layout = typeof row.layout === 'string' ? JSON.parse(row.layout) : row.layout;
    grid.value  = layout.grid ?? [];
    clues.value = layout.clues ?? {};
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    loading.value = false;
  }
}

// ── Resume ────────────────────────────────────────────────────────────────────
async function resumeProgress() {
  authed.value = await probeAuth();
  if (authed.value) {
    try {
      const prog = await fetchProgress(props.apiUrl, props.slug);
      if (prog.filledGrid) {
        const parsed = JSON.parse(prog.filledGrid) as Record<string, string>;
        answers.value = parsed;
        return; // loaded from server; watcher will mirror to localStorage on next tick
      }
    } catch {
      // 401 or network error — fall through to localStorage
    }
  }
  // Anonymous or server unavailable: try localStorage
  try {
    const stored = localStorage.getItem(`puzzle-answers-${props.slug}`);
    if (stored) answers.value = JSON.parse(stored) as Record<string, string>;
  } catch {
    // ignore corrupt storage
  }
}

// ── Autosave (debounced) ──────────────────────────────────────────────────────
let saveTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleSave() {
  if (saveTimer !== null) clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    saveTimer = null;
    const gridJson = JSON.stringify(answers.value);
    // Always mirror to localStorage
    saveToLocalStorage();
    // If authed, also persist to server (silently ignore errors)
    if (authed.value) {
      try {
        await postSaveProgress(props.apiUrl, props.slug, gridJson);
      } catch {
        // server save failed — local copy still valid
      }
    }
  }, 500);
}

/**
 * Flush any pending debounced save immediately. Cancels the timer and
 * performs a synchronous-to-the-caller save so that the persisted grid
 * is current before we hand off to complete(). No-op for anonymous users
 * (complete() will 401 for them anyway).
 */
async function flushSave() {
  if (saveTimer !== null) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  // Always mirror to localStorage
  saveToLocalStorage();
  if (authed.value) {
    try {
      await postSaveProgress(props.apiUrl, props.slug, JSON.stringify(answers.value));
    } catch {
      // server save failed — local copy still valid; complete() will re-grade what's stored
    }
  }
}

// Watch answers and trigger autosave; the watcher mirrors to localStorage on each change
watch(answers, scheduleSave, { deep: true });

// ── Check ─────────────────────────────────────────────────────────────────────
async function checkPuzzle() {
  const entries = buildCheckEntries(slots.value, answers.value);
  if (!entries.length) return;
  statusMsg.value = null;
  try {
    const data = await postCheck(props.apiUrl, props.slug, entries);
    cellStatus.value = buildCellStatus(data.results, slots.value);
    if (data.complete) {
      await onSolved();
    }
  } catch (e) {
    statusMsg.value = `Check failed: ${(e as Error).message}`;
  }
}

// ── Completion + confetti ─────────────────────────────────────────────────────
async function onSolved() {
  solved.value = true;
  // Flush any pending debounced autosave so the server re-grades the CURRENT grid,
  // not a stale snapshot that may be missing the final letter (I1 race fix).
  await flushSave();
  // Record completion server-side (silently ignore 401 for anon users)
  try {
    await postComplete(props.apiUrl, props.slug);
  } catch {
    // anon user or network error — confetti still fires
  }
  // Dynamic import keeps canvas-confetti out of the main chunk (budget guard)
  try {
    const confetti = (await import('canvas-confetti')).default;
    const end = Date.now() + 4000;
    const colors = ['#f59e0b', '#10b981', '#3b82f6', '#ec4899', '#8b5cf6'];
    (function frame() {
      confetti({ particleCount: 6, angle: 60, spread: 55, origin: { x: 0 }, colors });
      confetti({ particleCount: 6, angle: 120, spread: 55, origin: { x: 1 }, colors });
      if (Date.now() < end) requestAnimationFrame(frame);
    })();
  } catch {
    // confetti is cosmetic — never crash on it
  }
}

// ── Mount ─────────────────────────────────────────────────────────────────────
onMounted(async () => {
  await loadPuzzle();
  await resumeProgress();
});

// ── Interaction ───────────────────────────────────────────────────────────────
function handleCellClick(r: number, c: number) {
  if (grid.value[r]?.[c]?.black) return;
  const key = cellKey(r, c);
  if (isCursor(r, c)) {
    // Clicking the focused cell toggles across ↔ down
    const newDir: 'across' | 'down' = dir.value === 'across' ? 'down' : 'across';
    // Only toggle if a slot exists in the new direction
    if (slotAt(r, c, newDir)) dir.value = newDir;
  } else {
    cursor.value = { r, c };
    // Prefer current direction; fall back to the other
    if (!slotAt(r, c, dir.value)) {
      const other: 'across' | 'down' = dir.value === 'across' ? 'down' : 'across';
      if (slotAt(r, c, other)) dir.value = other;
    }
  }
  void key;
}

function handleKeyDown(e: KeyboardEvent) {
  if (!cursor.value) return;

  const { r, c } = cursor.value;
  const key = e.key;

  if (key === 'Tab') return; // let browser handle

  // Arrow keys
  if (key === 'ArrowRight' || key === 'ArrowLeft') {
    e.preventDefault();
    dir.value = 'across';
    if (key === 'ArrowRight') {
      cursor.value = advanceCursor(cursor.value, 'across', slots.value);
    } else {
      cursor.value = retreatCursor(cursor.value, 'across', slots.value);
    }
    return;
  }
  if (key === 'ArrowDown' || key === 'ArrowUp') {
    e.preventDefault();
    dir.value = 'down';
    if (key === 'ArrowDown') {
      cursor.value = advanceCursor(cursor.value, 'down', slots.value);
    } else {
      cursor.value = retreatCursor(cursor.value, 'down', slots.value);
    }
    return;
  }

  // Escape: clear cursor
  if (key === 'Escape') {
    cursor.value = null;
    return;
  }

  // Backspace: clear current cell and retreat
  if (key === 'Backspace') {
    e.preventDefault();
    const k = cellKey(r, c);
    if (answers.value[k]) {
      answers.value = { ...answers.value, [k]: '' };
    } else {
      cursor.value = retreatCursor(cursor.value, dir.value, slots.value);
      const pk = cellKey(cursor.value.r, cursor.value.c);
      answers.value = { ...answers.value, [pk]: '' };
    }
    return;
  }

  // Printable letter
  if (key.length === 1 && /[a-zA-Z]/.test(key)) {
    e.preventDefault();
    const letter = key.toUpperCase();
    answers.value = { ...answers.value, [cellKey(r, c)]: letter };
    cursor.value  = advanceCursor(cursor.value, dir.value, slots.value);
  }
}

function activateSlotFromClue(slot: Slot) {
  if (!slot.cells.length) return;
  cursor.value = { r: slot.cells[0].r, c: slot.cells[0].c };
  dir.value    = slot.dir;
}
</script>

<template>
  <div
    class="puzzle-island"
    style="font-family: var(--sapFontFamily, sans-serif); color: var(--sapTextColor, inherit);"
  >
    <!-- Loading / Error states -->
    <div v-if="loading" style="padding: 1rem; color: var(--sapContent_ForegroundColor);">
      Loading puzzle…
    </div>
    <div v-else-if="error" style="padding: 1rem; color: var(--sapNegativeColor, red);">
      {{ error }}
    </div>

    <!-- Puzzle body -->
    <template v-else>
      <h2
        v-if="title"
        style="margin: 0 0 1rem; font-size: 1.25rem; font-weight: 600;"
      >
        {{ title }}
      </h2>

      <!-- Solved banner -->
      <div
        v-if="solved"
        style="
          padding: 0.75rem 1rem;
          margin-bottom: 1rem;
          background: var(--sapSuccessBackground, #f1faf5);
          border: 1px solid var(--sapPositiveColor, #107e3e);
          border-radius: 6px;
          color: var(--sapPositiveColor, #107e3e);
          font-weight: 600;
        "
      >
        Puzzle complete! 🎉
      </div>

      <!-- Grid -->
      <div
        class="puzzle-grid"
        :style="{
          display: 'grid',
          gridTemplateColumns: `repeat(${COLS}, var(--puzzle-cell-size, 2rem))`,
          gridTemplateRows: `repeat(${ROWS}, var(--puzzle-cell-size, 2rem))`,
          gap: '2px',
          outline: 'none',
          userSelect: 'none',
        }"
        tabindex="0"
        @keydown="handleKeyDown"
      >
        <template v-for="(row, r) in grid" :key="r">
          <div
            v-for="(cell, c) in row"
            :key="`${r}-${c}`"
            :style="{
              width: 'var(--puzzle-cell-size, 2rem)',
              height: 'var(--puzzle-cell-size, 2rem)',
              background: cell.black
                ? 'var(--sapTextColor, #000)'
                : isCursor(r, c)
                  ? 'var(--sapInformativeColor, #0070f2)'
                  : cellStatus[`${r},${c}`] === 'correct'
                    ? 'var(--sapPositiveBackground, #f1faf5)'
                    : cellStatus[`${r},${c}`] === 'wrong'
                      ? 'var(--sapNegativeBackground, #fff1f1)'
                      : isInActiveSlot(r, c)
                        ? 'var(--sapHighlightColor, #d1e8ff)'
                        : 'var(--sapBackgroundColor, #fff)',
              border: cell.black
                ? 'none'
                : cellStatus[`${r},${c}`] === 'correct'
                  ? '1px solid var(--sapPositiveColor, #107e3e)'
                  : cellStatus[`${r},${c}`] === 'wrong'
                    ? '1px solid var(--sapNegativeColor, #bb0000)'
                    : '1px solid var(--sapContent_ForegroundColor, #666)',
              position: 'relative',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              cursor: cell.black ? 'default' : 'pointer',
              fontSize: '1rem',
              fontWeight: '600',
              color: isCursor(r, c)
                ? 'var(--sapContent_ContrastTextColor, #fff)'
                : cellStatus[`${r},${c}`] === 'correct'
                  ? 'var(--sapPositiveColor, #107e3e)'
                  : cellStatus[`${r},${c}`] === 'wrong'
                    ? 'var(--sapNegativeColor, #bb0000)'
                    : 'var(--sapTextColor, #000)',
              boxSizing: 'border-box',
            }"
            @click="handleCellClick(r, c)"
          >
            <!-- Cell number (top-left) -->
            <span
              v-if="!cell.black && cell.number"
              :style="{
                position: 'absolute',
                top: '1px',
                left: '2px',
                fontSize: '0.5rem',
                lineHeight: 1,
                color: isCursor(r, c)
                  ? 'var(--sapContent_ContrastTextColor, #fff)'
                  : 'var(--sapContent_LabelColor, #666)',
                pointerEvents: 'none',
              }"
            >
              {{ cell.number }}
            </span>
            <!-- Letter -->
            <span v-if="!cell.black">{{ answers[`${r},${c}`] || '' }}</span>
          </div>
        </template>
      </div>

      <!-- Actions bar -->
      <div style="display: flex; align-items: center; gap: 0.75rem; margin-top: 1rem; flex-wrap: wrap;">
        <button
          :disabled="!hasFilledSlot || solved"
          style="
            padding: 0.4rem 1rem;
            border-radius: 4px;
            border: 1px solid var(--sapButton_BorderColor, #0070f2);
            background: var(--sapButton_Background, #0070f2);
            color: var(--sapButton_TextColor, #fff);
            font-size: 0.875rem;
            font-family: inherit;
            cursor: pointer;
          "
          :style="{ opacity: (!hasFilledSlot || solved) ? '0.45' : '1' }"
          @click="checkPuzzle"
        >
          Check
        </button>
        <!-- Subtle status message (errors, etc.) -->
        <span
          v-if="statusMsg"
          style="font-size: 0.8rem; color: var(--sapNegativeColor, #bb0000);"
        >
          {{ statusMsg }}
        </span>
      </div>

      <!-- Clue lists -->
      <div
        class="puzzle-clues"
        style="display: flex; gap: 2rem; margin-top: 1.5rem; flex-wrap: wrap;"
      >
        <!-- Across -->
        <div style="flex: 1; min-width: 12rem;">
          <h3 style="margin: 0 0 0.5rem; font-size: 1rem; font-weight: 600;">Across</h3>
          <ol style="list-style: none; padding: 0; margin: 0;">
            <li
              v-for="slot in acrossSlots"
              :key="slot.id"
              :style="{
                padding: '0.25rem 0.5rem',
                cursor: 'pointer',
                background: activeSlot?.id === slot.id
                  ? 'var(--sapHighlightColor, #d1e8ff)'
                  : 'transparent',
                borderRadius: '4px',
                fontSize: '0.875rem',
                lineHeight: '1.4',
              }"
              @click="activateSlotFromClue(slot)"
            >
              <strong>{{ slot.number }}.</strong> {{ clueForSlot(slot, clues) }}
            </li>
          </ol>
        </div>

        <!-- Down -->
        <div style="flex: 1; min-width: 12rem;">
          <h3 style="margin: 0 0 0.5rem; font-size: 1rem; font-weight: 600;">Down</h3>
          <ol style="list-style: none; padding: 0; margin: 0;">
            <li
              v-for="slot in downSlots"
              :key="slot.id"
              :style="{
                padding: '0.25rem 0.5rem',
                cursor: 'pointer',
                background: activeSlot?.id === slot.id
                  ? 'var(--sapHighlightColor, #d1e8ff)'
                  : 'transparent',
                borderRadius: '4px',
                fontSize: '0.875rem',
                lineHeight: '1.4',
              }"
              @click="activateSlotFromClue(slot)"
            >
              <strong>{{ slot.number }}.</strong> {{ clueForSlot(slot, clues) }}
            </li>
          </ol>
        </div>
      </div>
    </template>
  </div>
</template>
