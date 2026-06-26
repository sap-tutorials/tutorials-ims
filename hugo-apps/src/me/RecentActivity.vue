<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'

interface Completion {
  slug: string
  title: string
  primaryTag: string | null
  experienceTag: string | null
  averageTimeToComplete: number | null
  completionDate: string | null
}

const loading = ref(true)
const isLoggedIn = ref<boolean | null>(null)
const rows = ref<Completion[]>([])
const errorMsg = ref('')

const recentRows = computed(() =>
  rows.value
    .slice()
    .filter(r => !!r.completionDate && !Number.isNaN(new Date(r.completionDate).getTime()))
    .sort((a, b) => new Date(b.completionDate!).getTime() - new Date(a.completionDate!).getTime())
    .slice(0, 10)
)

function formatDate(iso: string | null) {
  if (!iso) return '—'
  const d = new Date(iso)
  if (isNaN(d.getTime())) return '—'
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
}

function formatRelative(iso?: string | null): string {
  if (!iso) return '—'
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return formatDate(iso)
  const diffMs = Date.now() - then
  if (diffMs < 0) return 'Just now'
  const minutes = Math.floor(diffMs / 60_000)
  if (minutes < 60) return 'Just now'
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 30) return `${days}d ago`
  const months = Math.floor(days / 30)
  if (months < 12) return `${months}mo ago`
  return formatDate(iso)
}

function formatLevel(level: string | null) {
  if (!level) return '—'
  return level.charAt(0) + level.slice(1).toLowerCase()
}

function onTimelineNameClick(slug: string) {
  if (!slug) return
  window.location.href = `/tutorials/${slug}/`
}

onMounted(async () => {
  try {
    const authRes = await fetch('/auth/user', { credentials: 'include' })
    if (!authRes.ok) { isLoggedIn.value = false; loading.value = false; return }
    isLoggedIn.value = true
    const dataRes = await fetch('/api/getMyCompletions()', { credentials: 'include' })
    if (!dataRes.ok) {
      errorMsg.value = `Failed to load recent activity (HTTP ${dataRes.status}).`
      loading.value = false; return
    }
    const body = await dataRes.json()
    rows.value = Array.isArray(body) ? body : (body.value || [])
  } catch {
    errorMsg.value = 'Network error loading recent activity.'
  } finally {
    loading.value = false
  }
})
</script>

<template>
  <div v-if="loading" class="me-state">Loading…</div>
  <div v-else-if="isLoggedIn === false" class="me-state me-login-prompt">
    <h2>You're not signed in</h2>
    <p>Sign in to see your recent activity.</p>
    <a class="me-btn" href="/login">Sign in</a>
  </div>
  <div v-else-if="errorMsg" class="me-state me-error">{{ errorMsg }}</div>
  <div v-else-if="recentRows.length === 0" class="me-state me-state--empty">
    <p>No recent activity yet.</p>
  </div>
  <ui5-timeline v-else layout="Vertical" growing="None" class="me-timeline">
    <ui5-timeline-item
      v-for="item in recentRows"
      :key="item.slug"
      :name="item.title"
      :subtitle-text="`${item.primaryTag || 'Tutorial'} · ${formatRelative(item.completionDate)}`"
      icon="accept"
      state="Positive"
      name-clickable
      @name-click="() => onTimelineNameClick(item.slug)"
    >
      <span class="me-recent__level">{{ formatLevel(item.experienceTag) }}</span>
    </ui5-timeline-item>
  </ui5-timeline>
</template>

<style scoped>
.me-state { padding: 1.5rem; text-align: center; color: var(--sapNeutralTextColor, #556); }
.me-error { color: var(--sapNegativeColor, #b00020); }
.me-state--empty { padding: 1.5rem; }
.me-login-prompt h2 { font-size: 1.1rem; margin: 0 0 .5rem; }
.me-btn {
  display: inline-block; padding: .4rem .9rem; border-radius: 4px;
  background: var(--sapButton_Emphasized_Background, #0a6ed1);
  color: #fff; text-decoration: none; border: none;
}
.me-recent__level { font-size: 0.75rem; color: var(--sapContent_LabelColor, #6a6d70); }
</style>
