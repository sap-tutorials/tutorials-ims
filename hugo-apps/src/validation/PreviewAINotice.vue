<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue'

defineProps<{
  /** Source rules.vr block (verbatim). Rendered in a <pre> when revealed. */
  rulesBlock: string
}>()

const revealed = ref(false)

function onReveal(ev: Event) {
  const detail = (ev as CustomEvent).detail as { on?: boolean } | undefined
  revealed.value = Boolean(detail?.on)
}

onMounted(() => {
  window.addEventListener('tutorial-preview:reveal-ai-rules', onReveal)
})
onUnmounted(() => {
  window.removeEventListener('tutorial-preview:reveal-ai-rules', onReveal)
})
</script>

<template>
  <div role="note" class="preview-ai-notice">
    <h4 class="preview-ai-notice__title">AI features can only be fully previewed once deployed</h4>
    <p class="preview-ai-notice__body">
      This section uses an AI-driven feature (free-text grading, AI-authored quiz,
      code-check, or Joule step help). The author-side rules are shown below; full
      runtime behavior validates after the next QA publish.
    </p>
    <pre v-show="revealed" class="preview-ai-notice__rules"><code>{{ rulesBlock }}</code></pre>
  </div>
</template>

<style scoped>
.preview-ai-notice {
  border: 1px dashed var(--sapInformationBorderColor, #0a6ed1);
  background: var(--sapInformationBackground, #ebf8ff);
  border-radius: 4px;
  padding: 1rem;
  margin: 1rem 0;
}
.preview-ai-notice__title {
  margin: 0 0 0.5rem 0;
  font-size: 1rem;
}
.preview-ai-notice__body {
  margin: 0 0 0.5rem 0;
  font-size: 0.875rem;
}
.preview-ai-notice__rules {
  background: var(--sapNeutralBackground, #f5f5f5);
  padding: 0.5rem;
  border-radius: 3px;
  overflow-x: auto;
  font-size: 0.75rem;
}
</style>
