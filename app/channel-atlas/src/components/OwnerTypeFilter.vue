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
        @click="emit('toggle', t)"
      >
        <span
          class="owner-filter__swatch"
          :style="{ background: colorFor(t) }"
        />
        {{ labelFor(t) }}
      </li>
    </ul>
  </div>
</template>
