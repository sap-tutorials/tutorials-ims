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
import { emptyWhiteCells } from './lib/progress';

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
/** Hidden input that summons the mobile on-screen keyboard. Focused on cell tap;
    typed characters are routed into the grid via handleMobileInput. */
const hiddenInput = ref<HTMLInputElement | null>(null);

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
    const status = buildCellStatus(data.cells);           // per-cell green/red
    // Mark every empty white cell red too (item 4: blank white cells → red).
    for (const { r, c } of emptyWhiteCells(grid.value, answers.value)) {
      status[`${r},${c}`] = 'wrong';
    }
    cellStatus.value = status;
    if (data.complete) await onSolved();
  } catch (e) {
    statusMsg.value = `Check failed: ${(e as Error).message}`;
  }
}

/** Clear a cell's stale check status after the user types into or clears it. */
function clearCellStatus(r: number, c: number) {
  const key = cellKey(r, c);
  if (cellStatus.value[key]) {
    const cs = { ...cellStatus.value };
    delete cs[key];
    cellStatus.value = cs;
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
  // Focus the hidden input so mobile browsers raise the on-screen keyboard.
  // (Desktop is unaffected — physical keydown still routes via the input too.)
  hiddenInput.value?.focus();
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
      clearCellStatus(r, c);
    } else {
      cursor.value = retreatCursor(cursor.value, dir.value, slots.value);
      const pk = cellKey(cursor.value.r, cursor.value.c);
      answers.value = { ...answers.value, [pk]: '' };
      clearCellStatus(cursor.value.r, cursor.value.c);
    }
    return;
  }

  // Printable letter
  if (key.length === 1 && /[a-zA-Z]/.test(key)) {
    e.preventDefault();
    const letter = key.toUpperCase();
    answers.value = { ...answers.value, [cellKey(r, c)]: letter };
    clearCellStatus(r, c);
    cursor.value  = advanceCursor(cursor.value, dir.value, slots.value);
  }
}

function activateSlotFromClue(slot: Slot) {
  if (!slot.cells.length) return;
  cursor.value = { r: slot.cells[0].r, c: slot.cells[0].c };
  dir.value    = slot.dir;
}

/**
 * Mobile on-screen keyboard input. The hidden <input> fires `input` events with
 * the typed character(s); we take the last letter, place it, advance, and clear
 * the input so the next keystroke starts fresh. Backspace on an empty input
 * fires a `keydown` (handled by handleKeyDown, which the input also listens to),
 * so deletion + arrows keep working on both mobile and desktop.
 */
function handleMobileInput(e: Event) {
  const el = e.target as HTMLInputElement;
  const raw = el.value || '';
  el.value = ''; // reset so we only ever process the newest char
  if (!cursor.value) return;
  const ch = raw.slice(-1);
  if (!/[a-zA-Z]/.test(ch)) return;
  const { r, c } = cursor.value;
  answers.value = { ...answers.value, [cellKey(r, c)]: ch.toUpperCase() };
  clearCellStatus(r, c);
  cursor.value  = advanceCursor(cursor.value, dir.value, slots.value);
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

      <!-- Solved banner (above the 3-column row) -->
      <div v-if="solved" class="solved-banner">
        Puzzle complete! 🎉
      </div>

      <!-- 3-column layout: [Across clues] [Grid + Actions] [Down clues] -->
      <div class="puzzle-layout">

        <!-- Left column: Across clues -->
        <div class="puzzle-clues-col">
          <h3 class="clues-heading">Across</h3>
          <ol class="clues-list">
            <li
              v-for="slot in acrossSlots"
              :key="slot.id"
              class="clue-item"
              :class="{ 'clue-active': activeSlot?.id === slot.id }"
              @click="activateSlotFromClue(slot)"
            >
              <strong>{{ slot.number }}.</strong> {{ clueForSlot(slot, clues) }}
            </li>
          </ol>
        </div>

        <!-- Center column: Grid + Actions bar -->
        <div class="puzzle-center-col">
          <!-- Hidden input: focused on cell tap to raise the mobile on-screen
               keyboard. @input handles printable letters (mobile + desktop);
               @keydown handles backspace/arrows/escape. Visually hidden but NOT
               display:none (that would block focus + the keyboard). -->
          <input
            ref="hiddenInput"
            class="puzzle-hidden-input"
            type="text"
            inputmode="text"
            autocapitalize="characters"
            autocomplete="off"
            autocorrect="off"
            spellcheck="false"
            aria-label="Type a letter for the selected crossword cell"
            @input="handleMobileInput"
            @keydown="handleKeyDown"
          />
          <!-- Grid — only gridTemplateColumns/Rows are dynamic; all else via class -->
          <div
            class="puzzle-grid"
            :style="{
              gridTemplateColumns: `repeat(${COLS}, var(--puzzle-cell-size, 2rem))`,
              gridTemplateRows:    `repeat(${ROWS}, var(--puzzle-cell-size, 2rem))`,
            }"
            tabindex="0"
            @keydown="handleKeyDown"
          >
            <template v-for="(row, r) in grid" :key="r">
              <div
                v-for="(cell, c) in row"
                :key="`${r}-${c}`"
                class="puzzle-cell"
                :class="{
                  'cell-black':    cell.black,
                  'cell-clickable': !cell.black,
                  'cell-cursor':   !cell.black && isCursor(r, c),
                  'cell-correct':  !cell.black && !isCursor(r, c) && cellStatus[`${r},${c}`] === 'correct',
                  'cell-wrong':    !cell.black && !isCursor(r, c) && cellStatus[`${r},${c}`] === 'wrong',
                  'cell-active':   !cell.black && !isCursor(r, c)
                                    && cellStatus[`${r},${c}`] !== 'correct'
                                    && cellStatus[`${r},${c}`] !== 'wrong'
                                    && isInActiveSlot(r, c),
                }"
                @click="handleCellClick(r, c)"
              >
                <!-- Cell number (top-left) -->
                <span
                  v-if="!cell.black && cell.number"
                  class="cell-number"
                  :class="{ 'cell-number-cursor': isCursor(r, c) }"
                >
                  {{ cell.number }}
                </span>
                <!-- Letter -->
                <span v-if="!cell.black">{{ answers[`${r},${c}`] || '' }}</span>
              </div>
            </template>
          </div>

          <!-- Actions bar -->
          <div class="puzzle-actions">
            <button
              :disabled="!hasFilledSlot || solved"
              class="puzzle-btn"
              :class="{ 'puzzle-btn-disabled': !hasFilledSlot || solved }"
              @click="checkPuzzle"
            >
              Check
            </button>
            <!-- Submit: enabled only when puzzle is solved.
                 TODO (follow-up): wire final-submission backend call. -->
            <button
              :disabled="!solved"
              class="puzzle-btn"
              :class="{ 'puzzle-btn-disabled': !solved }"
            >
              Submit
            </button>
            <!-- Subtle status message (errors, etc.) -->
            <span v-if="statusMsg" class="status-msg">
              {{ statusMsg }}
            </span>
          </div>
        </div>

        <!-- Right column: Down clues -->
        <div class="puzzle-clues-col">
          <h3 class="clues-heading">Down</h3>
          <ol class="clues-list">
            <li
              v-for="slot in downSlots"
              :key="slot.id"
              class="clue-item"
              :class="{ 'clue-active': activeSlot?.id === slot.id }"
              @click="activateSlotFromClue(slot)"
            >
              <strong>{{ slot.number }}.</strong> {{ clueForSlot(slot, clues) }}
            </li>
          </ol>
        </div>

      </div><!-- /.puzzle-layout -->
    </template>
  </div>
</template>

<style scoped>
/* ── Outer island ─────────────────────────────────────────────────────────── */
.puzzle-island {
  /* inherits font/color from inline style on the root div */
}

/* ── 3-column layout row ──────────────────────────────────────────────────── */
.puzzle-layout {
  display: flex;
  flex-direction: row;
  gap: 1.5rem;
  align-items: flex-start;
}

/* Narrow screens: stack vertically */
@media (max-width: 900px) {
  .puzzle-layout {
    flex-direction: column;
  }
  .puzzle-clues-col {
    max-width: 100%;
    max-height: none;
    width: 100%;
  }
}

/* Clue side-columns: scrollable when clue list is long */
.puzzle-clues-col {
  flex: 1 1 11rem;
  min-width: 10rem;
  max-width: 16rem;
  max-height: 32rem;
  overflow-y: auto;
}

/* Center column: size to the grid + actions */
.puzzle-center-col {
  flex: 0 0 auto;
}

/* ── Clue lists ───────────────────────────────────────────────────────────── */
.clues-heading {
  margin: 0 0 0.5rem;
  font-size: 1rem;
  font-weight: 600;
}

.clues-list {
  list-style: none;
  padding: 0;
  margin: 0;
}

.clue-item {
  padding: 0.25rem 0.5rem;
  cursor: pointer;
  border-radius: 4px;
  font-size: 0.875rem;
  line-height: 1.4;
  background: transparent;
}

/* Active clue highlight. Pin BOTH background and text color to fixed hex so the
   selected clue stays readable in dark mode — the light-blue tint inherits the
   theme's white --sapTextColor otherwise, making white-on-light-blue unreadable
   (matches .cell-active, which is likewise theme-independent). */
.clue-active {
  background: #d0e8ff;
  color: #1a1a1a;
}

/* ── Grid container ───────────────────────────────────────────────────────── */
.puzzle-grid {
  display: grid;
  gap: 1px;
  outline: none;
  user-select: none;
  /* Dark grid backing: the 1px gaps between cells render as black grid lines,
     and the outer border + padding frame the whole grid so it stands out
     against ANY page background (light-gray Horizon light mode included,
     where a plain white grid was blending in). Theme-independent by design. */
  background: #1a1a1a;
  border: 2px solid #1a1a1a;
  padding: 1px;
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.25);
}

/* Visually-hidden input that raises the mobile on-screen keyboard on cell tap.
   Off-screen rather than display:none — display:none / visibility:hidden are
   not focusable, so the keyboard would never appear. */
.puzzle-hidden-input {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  border: 0;
  opacity: 0;
  pointer-events: none;
  left: -9999px;
}

/* ── Cells — THEME-INDEPENDENT (always black-on-white, ignores dark mode) ── */
/*
 * Fixed hex values are intentional: a crossword grid is always rendered
 * black-on-white regardless of the surrounding app's light/dark theme.
 * Do NOT replace these with var(--sap…) tokens.
 */
.puzzle-cell {
  width: var(--puzzle-cell-size, 2rem);
  height: var(--puzzle-cell-size, 2rem);
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 1rem;
  font-weight: 600;
  box-sizing: border-box;
  cursor: default;
  /* Default white cell. No border: the dark .puzzle-grid backing shows through
     the 1px gaps AS the grid lines, so a per-cell border would double up. */
  background: #ffffff;
  color: #1a1a1a;
  border: none;
}

/* Non-black cells are clickable */
.cell-clickable {
  cursor: pointer;
}

/* Black (blocked) cell */
.cell-black {
  background: #1a1a1a;
  border: none;
  cursor: default;
}

/* Cursor position: clear blue highlight */
.cell-cursor {
  background: #3b82f6;
  color: #ffffff;
  border-color: #2563eb;
}

/* Active word slot (non-cursor cells): soft blue tint */
.cell-active {
  background: #d0e8ff;
  color: #1a1a1a;
}

/* Check result — correct: green */
.cell-correct {
  background: #e6f4ea;
  color: #107e3e;
  border-color: #107e3e;
}

/* Check result — wrong: red */
.cell-wrong {
  background: #fce8e8;
  color: #bb0000;
  border-color: #bb0000;
}

/* ── Cell number label (top-left corner) ──────────────────────────────────── */
.cell-number {
  position: absolute;
  top: 1px;
  left: 2px;
  font-size: 0.5rem;
  line-height: 1;
  color: #444;
  pointer-events: none;
}

/* On cursor cell the number must stay readable against the blue bg */
.cell-number-cursor {
  color: #ffffff;
}

/* ── Actions bar (Check + Submit + status message) ────────────────────────── */
.puzzle-actions {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  margin-top: 1rem;
  flex-wrap: wrap;
}

.puzzle-btn {
  padding: 0.4rem 1rem;
  border-radius: 4px;
  border: 1px solid var(--sapButton_BorderColor, #0070f2);
  background: var(--sapButton_Background, #0070f2);
  color: var(--sapButton_TextColor, #fff);
  font-size: 0.875rem;
  font-family: inherit;
  cursor: pointer;
}

.puzzle-btn-disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.status-msg {
  font-size: 0.8rem;
  color: var(--sapNegativeColor, #bb0000);
}

/* ── Solved banner ────────────────────────────────────────────────────────── */
.solved-banner {
  padding: 0.75rem 1rem;
  margin-bottom: 1rem;
  background: var(--sapSuccessBackground, #f1faf5);
  border: 1px solid var(--sapPositiveColor, #107e3e);
  border-radius: 6px;
  color: var(--sapPositiveColor, #107e3e);
  font-weight: 600;
}
</style>
