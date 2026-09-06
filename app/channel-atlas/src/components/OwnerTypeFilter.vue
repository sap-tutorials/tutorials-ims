<!-- app/channel-atlas/src/components/OwnerTypeFilter.vue
     Fork of app/explore/src/components/FilterDropdown.vue.
     Renders a filter dropdown for ownerType values. -->
<script setup lang="ts">
import { ref, computed, onBeforeUnmount, onMounted } from 'vue'
import type { OwnerType } from '../types.js'
import { ALL_OWNER_TYPES } from '../composables/useOwnerTypeFilter.js'
import { OWNER_TYPE_PALETTE, FALLBACK_COLOR } from '../graph.js'

const props = defineProps<{
  enabledTypes: Set<OwnerType>
}>()
const emit = defineEmits<{ toggle: [OwnerType] }>()

const open = ref(false)
const rootEl = ref<HTMLElement | null>(null)

function toggle() { open.value = !open.value }

function onDocMousedown(e: MouseEvent) {
  if (open.value && rootEl.value && !rootEl.value.contains(e.target as Node)) {
    open.value = false
  }
}
onMounted(() => document.addEventListener('mousedown', onDocMousedown))
onBeforeUnmount(() => document.removeEventListener('mousedown', onDocMousedown))

// Label: count enabled types
const label = computed(() => {
  const n = props.enabledTypes.size
  return n === ALL_OWNER_TYPES.length ? 'All types' : `${n} type${n !== 1 ? 's' : ''}`
})

function colorFor(t: OwnerType) {
  return OWNER_TYPE_PALETTE[t] ?? FALLBACK_COLOR
}

// Human-readable label: replace underscores, trim prefix
function labelFor(t: OwnerType) {
  return t.replace(/_/g, ' ')
}
</script>

<template>
  <div ref="rootEl" class="owner-filter">
    <button class="owner-filter__toggle" @click="toggle" :aria-expanded="open">
      {{ label }}
    </button>
    <ul v-if="open" class="owner-filter__list" role="listbox">
      <li
        v-for="t in ALL_OWNER_TYPES"
        :key="t"
        class="owner-filter__item"
        :class="{ 'owner-filter__item--disabled': !enabledTypes.has(t) }"
        role="option"
        :aria-selected="enabledTypes.has(t)"
        @click="emit('toggle', t)"
      >
        <span class="owner-filter__check" aria-hidden="true">{{ enabledTypes.has(t) ? '✓' : '' }}</span>
        <span
          class="owner-filter__swatch"
          :style="{ background: colorFor(t) }"
        />
        {{ labelFor(t) }}
      </li>
    </ul>
  </div>
</template>

<style scoped>
/* Consumes site theme vars (hugo/assets/css/sap-theme-vars.css, flipped by
   the html.dark class). Light fallbacks keep the standalone/dev build legible. */
.owner-filter {
  position: relative;
  display: inline-block;
}

.owner-filter__toggle {
  font-family: inherit;
  font-size: 0.875rem;
  padding: 0.375rem 0.75rem;
  cursor: pointer;
  color: var(--sapButton_TextColor, #0064d9);
  background: var(--sapButton_Background, #fff);
  border: 1px solid var(--sapButton_BorderColor, #0064d9);
  border-radius: 0.5rem;
}

.owner-filter__toggle:hover {
  background: var(--sapButton_Hover_Background, rgba(0, 100, 217, 0.06));
}

.owner-filter__list {
  position: absolute;
  z-index: 10;
  margin: 0.25rem 0 0;
  padding: 0.25rem 0;
  list-style: none;
  min-width: 220px;
  max-height: 60vh;
  overflow-y: auto;
  background: var(--sapList_Background, #fff);
  border: 1px solid var(--sapGroup_ContentBorderColor, #d9d9d9);
  border-radius: 0.5rem;
  box-shadow: var(--sapContent_Shadow1, 0 2px 8px rgba(0, 0, 0, 0.15));
}

.owner-filter__item {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.375rem 0.75rem;
  cursor: pointer;
  font-size: 0.875rem;
  color: var(--sapTextColor, #32363a);
}

.owner-filter__item:hover {
  background: var(--sapList_Hover_Background, rgba(0, 112, 242, 0.06));
}

/* Selected (enabled) type: highlighted row + visible checkmark. */
.owner-filter__item[aria-selected='true'] {
  background: var(--sapList_SelectionBackgroundColor, #ebf5fe);
  font-weight: 600;
}

.owner-filter__check {
  display: inline-block;
  width: 0.875em;
  flex-shrink: 0;
  color: var(--sapSelectedColor, #0064d9);
  font-weight: 700;
}

/* Deselected type: dimmed text + faded swatch, no checkmark. */
.owner-filter__item--disabled {
  color: var(--sapContent_DisabledTextColor, #bcc3ca);
  font-weight: 400;
}

.owner-filter__item--disabled .owner-filter__swatch {
  opacity: 0.35;
}

.owner-filter__swatch {
  display: inline-block;
  width: 0.875rem;
  height: 0.875rem;
  border-radius: 50%;
  flex-shrink: 0;
}
</style>
