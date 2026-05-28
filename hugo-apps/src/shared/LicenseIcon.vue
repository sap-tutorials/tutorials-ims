<script setup lang="ts">
// Inline SVG key glyph. Sized via the .license-key CSS rules in the consumer.
// Color = currentColor so it inherits from the surrounding text and adapts
// to Horizon light/dark via existing theme variables.
withDefaults(defineProps<{ size?: number }>(), { size: 14 })
</script>

<template>
  <span class="license-key" role="img" aria-label="Requires a product license" title="Requires a product license">
    <svg
      :width="size" :height="size"
      viewBox="0 0 16 16" fill="none"
      stroke="currentColor" stroke-width="1.5"
      stroke-linecap="round" stroke-linejoin="round"
      aria-hidden="true" focusable="false"
    >
      <!-- Bow + bit pattern: a circular bow on the left, shaft to the right with two teeth. -->
      <circle cx="5" cy="8" r="2.75" />
      <path d="M7.75 8H14" />
      <path d="M11.5 8v2.25" />
      <path d="M13.5 8v1.5" />
    </svg>
  </span>
</template>

<style scoped>
.license-key {
  display: inline-flex;
  align-items: center;
  color: var(--sapContent_NonInteractiveIconColor, currentColor);
  margin-inline-start: 0.25rem;
}
</style>
