<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { goalCompletion } from '../shared/goalCompletion'

// Per-user Group/Mission completion indicator for the catalog detail page.
//
// Detail pages are server-rendered and cached per-slug (shared across users),
// so per-user state cannot be baked in — this island fetches it client-side.
// The goal's tutorial slug list is supplied as a prop (stamped by the renderer
// from the build-time context), so the island needs no per-page DOM knowledge.
//
// Fail-open: on any error, or for anonymous users, it renders nothing.

const props = defineProps<{ tutorialSlugs: string[] }>()

const signedIn = ref(false)
const completedSlugs = ref<Set<string>>(new Set())
const ready = ref(false)

const result = computed(() => goalCompletion(props.tutorialSlugs ?? [], completedSlugs.value))

onMounted(async () => {
  if (!props.tutorialSlugs || props.tutorialSlugs.length === 0) return // nothing to show
  let json: any
  try {
    const res = await fetch('/build/my-progress', { credentials: 'include' })
    if (!res.ok) return // fail-open
    json = await res.json()
  } catch {
    return // fail-open
  }
  if (!json?.authenticated) return // anonymous: render nothing
  signedIn.value = true
  const raw = json?.tutorials?.completedSlugs
  completedSlugs.value = new Set(Array.isArray(raw) ? raw : [])
  ready.value = true
})
</script>

<template>
  <section
    v-if="ready && result.total > 0"
    class="goal-completion"
    :class="{ 'goal-completion--complete': result.complete }"
    aria-label="Your progress"
  >
    <template v-if="result.complete">
      <span class="goal-completion__badge">&#10003; Completed</span>
    </template>
    <template v-else>
      <div
        class="goal-completion__bar"
        role="progressbar"
        :aria-valuenow="result.percent"
        aria-valuemin="0"
        aria-valuemax="100"
      >
        <div class="goal-completion__bar-fill" :style="{ width: result.percent + '%' }"></div>
      </div>
      <span class="goal-completion__label">{{ result.completed }} of {{ result.total }} tutorials complete</span>
    </template>
  </section>
</template>

<style scoped>
.goal-completion {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  margin: 1rem 0 0;
  font-size: 0.95rem;
}
.goal-completion__bar {
  flex: 0 0 180px;
  height: 8px;
  border-radius: 999px;
  background: var(--sapNeutralBackground, #e5e5e5);
  overflow: hidden;
}
.goal-completion__bar-fill {
  height: 100%;
  border-radius: 999px;
  background: var(--sapProgress_Value_Color, var(--sapButton_Emphasized_Background, #0070f2));
  transition: width 0.3s ease;
}
.goal-completion__label {
  color: var(--sapContent_LabelColor, #556b82);
  white-space: nowrap;
}
.goal-completion__badge {
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
  padding: 0.2rem 0.6rem;
  border-radius: 999px;
  font-weight: 600;
  color: var(--sapPositiveTextColor, #256f3a);
  background: var(--sapSuccessBackground, #f0fae1);
}
</style>
