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

type SortKey = 'title' | 'primaryTag' | 'experienceTag' | 'averageTimeToComplete' | 'completionDate'

const loading = ref(true)
const isLoggedIn = ref<boolean | null>(null)
const rows = ref<Completion[]>([])
const errorMsg = ref('')
const filterText = ref('')
const filterTopic = ref('')
const filterLevel = ref('')
const sortKey = ref<SortKey>('completionDate')
const sortDir = ref<'asc' | 'desc'>('desc')

const topicOptions = computed(() => {
  const set = new Set<string>()
  rows.value.forEach(r => { if (r.primaryTag) set.add(r.primaryTag) })
  return Array.from(set).sort()
})
const levelOptions = computed(() => {
  const set = new Set<string>()
  rows.value.forEach(r => { if (r.experienceTag) set.add(r.experienceTag) })
  return Array.from(set).sort()
})

const filtered = computed(() => {
  const q = filterText.value.trim().toLowerCase()
  return rows.value.filter(r => {
    if (q && !r.title.toLowerCase().includes(q) && !r.slug.toLowerCase().includes(q)) return false
    if (filterTopic.value && r.primaryTag !== filterTopic.value) return false
    if (filterLevel.value && r.experienceTag !== filterLevel.value) return false
    return true
  })
})

const sorted = computed(() => {
  const list = [...filtered.value]
  const k = sortKey.value
  const dir = sortDir.value === 'asc' ? 1 : -1
  list.sort((a, b) => {
    const av = a[k], bv = b[k]
    if (av == null && bv == null) return 0
    if (av == null) return 1
    if (bv == null) return -1
    if (k === 'completionDate') return (new Date(av as string).getTime() - new Date(bv as string).getTime()) * dir
    if (k === 'averageTimeToComplete') return ((av as number) - (bv as number)) * dir
    return String(av).localeCompare(String(bv)) * dir
  })
  return list
})

function setSort(key: SortKey) {
  if (sortKey.value === key) sortDir.value = sortDir.value === 'asc' ? 'desc' : 'asc'
  else { sortKey.value = key; sortDir.value = key === 'completionDate' ? 'desc' : 'asc' }
}

function sortIcon(key: SortKey) {
  if (sortKey.value !== key) return ''
  return sortDir.value === 'asc' ? ' ▲' : ' ▼'
}

function formatDate(iso: string | null) {
  if (!iso) return '—'
  const d = new Date(iso)
  if (isNaN(d.getTime())) return '—'
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
}

function formatLevel(level: string | null) {
  if (!level) return '—'
  return level.charAt(0) + level.slice(1).toLowerCase()
}

function clearFilters() { filterText.value = ''; filterTopic.value = ''; filterLevel.value = '' }

onMounted(async () => {
  try {
    const authRes = await fetch('/auth/user', { credentials: 'include' })
    if (!authRes.ok) { isLoggedIn.value = false; loading.value = false; return }
    isLoggedIn.value = true
    const dataRes = await fetch('/api/getMyCompletions()', { credentials: 'include' })
    if (!dataRes.ok) {
      errorMsg.value = `Failed to load completions (HTTP ${dataRes.status}).`
      loading.value = false; return
    }
    const body = await dataRes.json()
    rows.value = Array.isArray(body) ? body : (body.value || [])
  } catch {
    errorMsg.value = 'Network error loading your completions.'
  } finally {
    loading.value = false
  }
})
</script>

<template>
  <div v-if="loading" class="me-state">Loading…</div>
  <div v-else-if="isLoggedIn === false" class="me-state me-login-prompt">
    <h2>You're not signed in</h2>
    <p>Sign in to see the tutorials you've completed.</p>
    <a class="me-btn" href="/login">Sign in</a>
  </div>
  <div v-else-if="errorMsg" class="me-state me-error">{{ errorMsg }}</div>
  <div v-else-if="rows.length === 0" class="me-state me-state--empty">
    <ui5-illustrated-message name="NoData" design="Spot">
      <h2 slot="title">No completions yet</h2>
      <p slot="subtitle">Complete a tutorial step and it'll show up here.</p>
      <ui5-button design="Emphasized" onclick="window.location.href='/'">Browse tutorials</ui5-button>
    </ui5-illustrated-message>
  </div>

  <template v-else>
    <div class="me-toolbar" role="search">
      <label class="me-field"><span>Search</span><input type="text" v-model="filterText" placeholder="Title or slug…" /></label>
      <label class="me-field"><span>Topic</span><select v-model="filterTopic"><option value="">All</option><option v-for="t in topicOptions" :key="t" :value="t">{{ t }}</option></select></label>
      <label class="me-field"><span>Level</span><select v-model="filterLevel"><option value="">All</option><option v-for="l in levelOptions" :key="l" :value="l">{{ formatLevel(l) }}</option></select></label>
      <button v-if="filterText || filterTopic || filterLevel" class="me-btn me-btn-ghost" @click="clearFilters">Clear</button>
      <span class="me-count">{{ sorted.length }} of {{ rows.length }}</span>
    </div>

    <div class="me-table-wrap">
      <table class="me-table">
        <thead><tr>
          <th @click="setSort('title')"><button>Title{{ sortIcon('title') }}</button></th>
          <th @click="setSort('primaryTag')"><button>Topic{{ sortIcon('primaryTag') }}</button></th>
          <th @click="setSort('experienceTag')"><button>Level{{ sortIcon('experienceTag') }}</button></th>
          <th @click="setSort('averageTimeToComplete')" class="num"><button>Time{{ sortIcon('averageTimeToComplete') }}</button></th>
          <th @click="setSort('completionDate')"><button>Completed{{ sortIcon('completionDate') }}</button></th>
        </tr></thead>
        <tbody>
          <tr v-for="r in sorted" :key="r.slug">
            <td><a :href="`/tutorials/${r.slug}/`">{{ r.title }}</a></td>
            <td>{{ r.primaryTag || '—' }}</td>
            <td>{{ formatLevel(r.experienceTag) }}</td>
            <td class="num">{{ r.averageTimeToComplete != null ? `${r.averageTimeToComplete} min` : '—' }}</td>
            <td>{{ formatDate(r.completionDate) }}</td>
          </tr>
        </tbody>
      </table>
    </div>
  </template>
</template>

<style scoped>
.me-state { padding: 1.5rem; text-align: center; color: var(--sapNeutralTextColor, #556); }
.me-error { color: var(--sapNegativeColor, #b00020); }
.me-state--empty { padding: 1rem; background: transparent; }
.me-state--empty ui5-button { margin-top: 1rem; }
.me-login-prompt h2 { font-size: 1.25rem; margin: 0 0 .5rem; }
.me-toolbar { display: flex; flex-wrap: wrap; gap: 1rem; align-items: end; margin-bottom: 1rem; }
.me-field { display: flex; flex-direction: column; font-size: .875rem; }
.me-field span { margin-bottom: .25rem; color: var(--sapNeutralTextColor, #556); }
.me-field input, .me-field select {
  min-width: 12rem; padding: .4rem .6rem;
  border: 1px solid var(--sapField_BorderColor, #ccd); border-radius: 4px;
  background: var(--sapField_Background, #fff); color: inherit; font: inherit;
}
.me-btn {
  display: inline-block; padding: .5rem 1rem; border-radius: 4px;
  background: var(--sapButton_Emphasized_Background, #0a6ed1);
  color: #fff; text-decoration: none; border: none; cursor: pointer; font: inherit;
}
.me-btn-ghost { background: transparent; color: var(--sapLinkColor, #0a6ed1); border: 1px solid var(--sapField_BorderColor, #ccd); }
.me-count { margin-left: auto; color: var(--sapNeutralTextColor, #556); font-size: .875rem; }
.me-table-wrap { overflow-x: auto; border: 1px solid var(--sapList_BorderColor, #e5e5ea); border-radius: 8px; background: var(--sapList_Background, #fff); }
.me-table { width: 100%; border-collapse: collapse; font-size: .9rem; }
.me-table th, .me-table td { text-align: left; padding: .6rem .9rem; border-bottom: 1px solid var(--sapList_BorderColor, #eef); }
.me-table th { background: var(--sapList_HeaderBackground, #f4f4f7); font-weight: 600; user-select: none; padding: 0; }
.me-table th button { width: 100%; text-align: inherit; background: none; border: none; color: inherit; font: inherit; font-weight: inherit; padding: .6rem .9rem; cursor: pointer; }
.me-table tr:last-child td { border-bottom: none; }
.me-table .num { text-align: right; }
.me-table a { color: var(--sapLinkColor, #0a6ed1); text-decoration: none; }
.me-table a:hover { text-decoration: underline; }
</style>
