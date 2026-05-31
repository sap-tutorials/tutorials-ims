<script setup lang="ts">
import { ref, watch } from 'vue'
import '@ui5/webcomponents/dist/Button.js'
import { useQuerySpec } from '../../composables/useQuerySpec'

const STORAGE_KEY = 'analytics.seenAutoGroupBanner'

const querySpec = useQuerySpec()
const visible = ref(false)
const previouslyHadAgg = ref(false)
const dismissedThisSession = ref(false)

// Initialize: if user has dismissed before, never show again.
const seenInLocalStorage = (() => {
  try { return localStorage.getItem(STORAGE_KEY) === '1' } catch { return false }
})()

watch(
  () => querySpec.spec.value?.select.some(s => s.kind === 'aggregation') ?? false,
  (hasAgg) => {
    if (seenInLocalStorage || dismissedThisSession.value) return
    // Banner appears the FIRST time hasAgg flips from false to true.
    if (hasAgg && !previouslyHadAgg.value) {
      visible.value = true
    }
    previouslyHadAgg.value = hasAgg
  },
  { immediate: true },
)

function dismiss() {
  visible.value = false
  dismissedThisSession.value = true
  try { localStorage.setItem(STORAGE_KEY, '1') } catch { /* ignore */ }
}
</script>

<template>
  <div v-if="visible" class="auto-groupby-banner" role="status">
    <span class="icon" aria-hidden="true">ⓘ</span>
    <span class="message">
      GROUP BY auto-added: every non-aggregation SELECT chip is now an
      implicit group key. Edit the underlying SELECT chip to change.
    </span>
    <ui5-button design="Transparent" @click="dismiss">Got it</ui5-button>
  </div>
</template>

<style scoped>
.auto-groupby-banner {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.4rem 0.75rem;
  background: var(--sapInformationBackground, #ebf5fe);
  color: var(--sapInformationTextColor, #0a6ed1);
  border-bottom: 1px solid var(--sapList_BorderColor);
  font-size: 0.85rem;
}
.icon { font-weight: bold; flex-shrink: 0; }
.message { flex: 1; }
</style>
