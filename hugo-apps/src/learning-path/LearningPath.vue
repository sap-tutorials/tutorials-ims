<script setup lang="ts">
import { ref, onMounted } from 'vue'

const props = defineProps<{ goalType: 'tutorial' | 'mission' | 'group' | 'next-best' }>()

type Step = { order: number; tutorialSlug: string; teachesConcepts: string[]; satisfiesPrereqFor: string[]; alreadyPartial: boolean }
const steps = ref<Step[]>([])
const signedIn = ref(false)
const personalized = ref(false)
const ready = ref(false)

async function isSignedIn(): Promise<boolean> {
  try {
    const r = await fetch('/auth/user', { credentials: 'include' })
    if (!r.ok) return false
    if (!(r.headers.get('content-type') || '').includes('json')) return false
    const body = await r.json()
    return !!body?.authenticated
  } catch { return false }
}

onMounted(async () => {
  const rawSlug = document.documentElement.getAttribute('data-page-slug') || ''
  // Strip the URL-routing prefix that catalog-renderer stamps onto data-page-slug
  // for group/mission pages (e.g. 'group-foo' → 'foo', 'mission-bar' → 'bar').
  // Groups.slug and Missions.slug store the bare slug without prefix; tutorial
  // slugs are already bare and pass through unchanged.
  let goal = rawSlug
  if (props.goalType === 'group' && goal.startsWith('group-')) goal = goal.slice('group-'.length)
  if (props.goalType === 'mission' && goal.startsWith('mission-')) goal = goal.slice('mission-'.length)
  signedIn.value = await isSignedIn() // establishes session for the credentialed call below
  let res: Response
  try {
    res = await fetch(
      `/graph/learningPath(goal='${encodeURIComponent(goal)}',goalType='${props.goalType}')`,
      { credentials: 'same-origin', headers: { Accept: 'application/json' } },
    )
  } catch { return } // fail-open
  if (res.status === 503 || !res.ok) return // fail-open: render nothing
  const body = await res.json()
  const value = body?.value ?? body // OData function returns { ...result } or {value:{...}}
  steps.value = value?.steps ?? []
  personalized.value = !!value?.personalized
  ready.value = steps.value.length > 0
})
</script>

<template>
  <section v-if="ready" class="learning-path" aria-label="Your learning path">
    <h2 class="learning-path__title">Your learning path</h2>
    <p v-if="!signedIn" class="learning-path__nudge">Sign in to personalize this to what you've completed.</p>
    <ol class="learning-path__steps">
      <li v-for="s in steps" :key="s.tutorialSlug" class="learning-path__step">
        <a :href="`/tutorials/${s.tutorialSlug}/`">{{ s.tutorialSlug }}</a>
        <span v-if="s.alreadyPartial" class="learning-path__badge">in progress</span>
      </li>
    </ol>
  </section>
</template>
