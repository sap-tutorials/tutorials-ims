<script setup lang="ts">
// hugo-apps/src/puzzle/App.vue
// Public crossword solver island. Ported from the POC React Puzzle.jsx.
// Handles: layout fetch, grid render, clue lists, click/type/arrows/backspace fill.
// No server check / resume / completion — those come in the next task.
// NO UI5 imports — theme CSS vars only (light/dark safe).

import { ref, computed, onMounted } from 'vue';
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

const props = defineProps<{ slug: string; apiUrl: string }>();

// ── State ────────────────────────────────────────────────────────────────────
const loading = ref(true);
const error   = ref<string | null>(null);
const title   = ref('');
const grid    = ref<Cell[][]>([]);
const clues   = ref<Record<string, string>>({});

/** answers map: "r,c" → uppercase letter typed by the user */
const answers = ref<Record<string, string>>({});
const cursor  = ref<Cursor | null>(null);
const dir     = ref<'across' | 'down'>('across');

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

// ── Fetch layout ─────────────────────────────────────────────────────────────
async function loadPuzzle() {
  loading.value = true;
  error.value   = null;
  try {
    // OData filter: /api/puzzles/Puzzles?$filter=slug eq '<slug>'&$select=layout,title
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

onMounted(loadPuzzle);

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
                  : isInActiveSlot(r, c)
                    ? 'var(--sapHighlightColor, #d1e8ff)'
                    : 'var(--sapBackgroundColor, #fff)',
              border: cell.black ? 'none' : '1px solid var(--sapContent_ForegroundColor, #666)',
              position: 'relative',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              cursor: cell.black ? 'default' : 'pointer',
              fontSize: '1rem',
              fontWeight: '600',
              color: isCursor(r, c)
                ? 'var(--sapContent_ContrastTextColor, #fff)'
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
