<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'

interface Completion {
  kind?: string | null
  slug: string
  title: string
  primaryTag: string | null
  experienceTag: string | null
  averageTimeToComplete: number | null
  completionDate: string | null
}

interface InProgressItem {
  kind?: string | null
  slug: string
  title: string
  primaryTag: string | null
  experienceTag: string | null
  averageTimeToComplete: number | null
  progressPercent: number | null
  lastTouchedAt: string | null
}

// Unified timeline row. `partial` distinguishes an in-progress ("resume where
// you left off", #2146) item from a finished one; `activityDate` is the field
// we sort the merged timeline on (completionDate for completed, lastTouchedAt
// for partial).
interface ActivityItem {
  kind?: string | null
  slug: string
  title: string
  experienceTag: string | null
  partial: boolean
  progressPercent: number | null
  activityDate: string | null
}

const loading = ref(true)
const isLoggedIn = ref<boolean | null>(null)
const completedRows = ref<Completion[]>([])
const partialRows = ref<InProgressItem[]>([])
const errorMsg = ref('')

const recentRows = computed<ActivityItem[]>(() => {
  const completed: ActivityItem[] = completedRows.value.map(r => ({
    kind: r.kind,
    slug: r.slug,
    title: r.title,
    experienceTag: r.experienceTag,
    partial: false,
    progressPercent: null,
    activityDate: r.completionDate
  }))
  const partial: ActivityItem[] = partialRows.value.map(r => ({
    kind: r.kind,
    slug: r.slug,
    title: r.title,
    experienceTag: r.experienceTag,
    partial: true,
    progressPercent: typeof r.progressPercent === 'number' ? r.progressPercent : null,
    activityDate: r.lastTouchedAt
  }))
  return [...completed, ...partial]
    .filter(r => !!r.activityDate && !Number.isNaN(new Date(r.activityDate).getTime()))
    .sort((a, b) => new Date(b.activityDate!).getTime() - new Date(a.activityDate!).getTime())
    .slice(0, 10)
})

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

function itemUrl(item: ActivityItem): string {
  // Petoberfest and puzzles are served from their own content sections, not
  // /tutorials/ — linking their slug under /tutorials/ 404s (verified live).
  const base = item.kind === 'puzzle' ? '/puzzles/'
    : item.kind === 'petoberfest' ? '/petoberfest/'
    : '/tutorials/'
  return `${base}${item.slug}/`
}

function itemKindLabel(item: ActivityItem): string {
  if (item.kind === 'puzzle') return 'Puzzle'
  if (item.kind === 'petoberfest') return 'Petoberfest'
  return 'Tutorial'
}

// Subtitle differs for a partial: it shows resume progress ("In progress · 57%
// · 3d ago") vs a completed item's kind + relative completion time.
function itemSubtitle(item: ActivityItem): string {
  if (item.partial) {
    const pct = typeof item.progressPercent === 'number' ? `${item.progressPercent}% · ` : ''
    return `In progress · ${pct}${formatRelative(item.activityDate)}`
  }
  return `${itemKindLabel(item)} · ${formatRelative(item.activityDate)}`
}

function onTimelineNameClick(item: ActivityItem) {
  if (!item.slug) return
  window.location.href = itemUrl(item)
}

// The approuter serves a lapsed/anonymous session as 200 + an XSUAA
// login-redirect HTML page (NOT 401), and Akamai can serve a cached anon
// /auth/user to a signed-in browser. A truthy signal requires JSON +
// body.authenticated — never authRes.ok alone. Mirrors coordinator.ts.
async function isSignedIn(): Promise<boolean> {
  try {
    const r = await fetch('/auth/user', { credentials: 'include' })
    if (!r.ok) return false
    if (!(r.headers.get('content-type') || '').includes('json')) return false
    const body = await r.json()
    return !!body?.authenticated
  } catch { return false }
}

// Fetch a /me OData collection. Returns the row array, or null when the
// response is a lapsed-session HTML login page (caller treats null as signed
// out) or an HTTP error (caller surfaces errorMsg).
async function fetchRows(url: string): Promise<any[] | null> {
  const res = await fetch(url, { credentials: 'include' })
  if (!res.ok) { errorMsg.value = `Failed to load recent activity (HTTP ${res.status}).`; return null }
  // Session may have lapsed after the gate → 200 + HTML login page. Treat a
  // non-JSON body as signed out, not a data error.
  if (!(res.headers.get('content-type') || '').includes('json')) { isLoggedIn.value = false; return null }
  const body = await res.json()
  return Array.isArray(body) ? body : (body.value || [])
}

onMounted(async () => {
  try {
    if (!(await isSignedIn())) { isLoggedIn.value = false; loading.value = false; return }
    isLoggedIn.value = true
    const [completed, partial] = await Promise.all([
      fetchRows('/api/getMyCompletions()'),
      fetchRows('/api/getMyInProgress()')
    ])
    // A null from either fetch means signed-out or an HTTP error already
    // recorded — bail without overwriting that state.
    if (isLoggedIn.value === false || errorMsg.value) { loading.value = false; return }
    completedRows.value = completed || []
    partialRows.value = partial || []
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
      v-for="(item, idx) in recentRows"
      :key="`${item.kind || 'tutorial'}:${item.slug}:${item.partial ? 'p' : 'c'}:${item.activityDate || idx}`"
      :name="item.title"
      :subtitle-text="itemSubtitle(item)"
      :icon="item.partial ? 'play' : 'accept'"
      :state="item.partial ? 'Information' : 'Positive'"
      name-clickable
      @name-click="() => onTimelineNameClick(item)"
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
