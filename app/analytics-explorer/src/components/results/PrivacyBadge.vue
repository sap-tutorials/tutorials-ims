<script setup lang="ts">
defineProps<{
  privacy?: { mode: 'raw' | 'k-anon'; suppressedCells?: number }
}>()
</script>

<template>
  <span v-if="privacy" class="privacy-badge" :class="`badge-${privacy.mode}`">
    <template v-if="privacy.mode === 'raw'">
      ⚠ Raw query — no privacy filter
    </template>
    <template v-else>
      🔒 Privacy-filtered (k≥5){{ privacy.suppressedCells ? ` — ${privacy.suppressedCells} cells suppressed` : '' }}
    </template>
  </span>
</template>

<style scoped>
.privacy-badge {
  display: inline-flex;
  align-items: center;
  padding: 0.2rem 0.5rem;
  border-radius: 4px;
  font-size: 0.75rem;
  font-weight: 500;
}
.badge-raw {
  background: var(--sapWarningBackground, #fff8d6);
  color: var(--sapWarningTextColor, #b06000);
  border: 1px solid var(--sapWarningBorderColor, #d2872c);
}
.badge-k-anon {
  background: var(--sapPositiveBackground, #ebf5e0);
  color: var(--sapPositiveTextColor, #2b7d2b);
  border: 1px solid var(--sapPositiveBorderColor, #5cb85c);
}
</style>
