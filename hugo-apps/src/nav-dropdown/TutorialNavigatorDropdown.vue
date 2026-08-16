<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { buildOrderedGroups } from './order'
import { resolveGroupMembers } from '@shared/group-nav-context'

interface NavEntry {
  slug: string
  title: string
  missionId: number
  missionTitle: string
  groupId: number
  groupTitle: string
  prev: string | null
  next: string | null
  // Ordering hints baked by fetch-tutorials.ts (#group-nav-dropdown-order).
  missionGroupSeq?: number
  groupOrder?: number
}

interface StepEntry {
  number: number
  title: string
}

const props = defineProps<{
  currentSlug: string
  isOpen: boolean
  toggleElement?: HTMLElement | null
  // #1836: the group the reader entered from (?from=<groupSlug>). When set, the
  // dropdown shows THAT group's ordered siblings instead of the baked missionId
  // grouping (which can be a junk single-tutorial event mission).
  fromGroupSlug?: string | null
}>()

const emit = defineEmits<{
  close: []
}>()

const navEntries = ref<NavEntry[]>([])
const stepEntries = ref<StepEntry[]>([])
const mode = ref<'mission' | 'group' | 'steps'>('mission')
const dropdownEl = ref<HTMLElement | null>(null)

const groups = computed(() => buildOrderedGroups(navEntries.value))

// mission mode → mission name; group mode (#1836) → the entry group's name.
const headerTitle = computed(() => navEntries.value[0]?.missionTitle ?? '')

function onClickOutside(e: MouseEvent) {
  const target = e.target as Node
  if (dropdownEl.value && !dropdownEl.value.contains(target) &&
      !(props.toggleElement && props.toggleElement.contains(target))) {
    emit('close')
  }
}

function extractStepsFromDOM(): StepEntry[] {
  const steps: StepEntry[] = []
  document.querySelectorAll('.tutorial-step').forEach(el => {
    const num = parseInt(el.getAttribute('data-step') || '0', 10)
    const titleEl = el.querySelector('.step-title-text')
    if (num && titleEl) {
      steps.push({ number: num, title: titleEl.textContent?.trim() || `Step ${num}` })
    }
  })
  return steps
}

// In group mode, keep the reader in-group by carrying ?from= on sibling links.
function itemHref(slug: string): string {
  if (mode.value === 'group' && props.fromGroupSlug) {
    return `/tutorials/${slug}?from=${encodeURIComponent(props.fromGroupSlug)}`
  }
  return `/tutorials/${slug}`
}

// #1836: build the entry group's ordered sibling list from /build/navigator
// (member slugs + order + group title) joined with _nav.json (tutorial titles).
// Returns true when it populated a non-empty group; false → caller falls back.
async function loadFromGroup(fromGroupSlug: string): Promise<boolean> {
  const rows = await resolveGroupMembers(fromGroupSlug)
  if (!rows.length) return false
  const groupTitle = rows[0].groupTitle
  const groupId = rows[0].groupId
  let titleBySlug = new Map<string, string>()
  try {
    const res = await fetch('/tutorials/_nav.json')
    if (res.ok) {
      const navData = await res.json()
      const all: NavEntry[] = navData.tutorials ?? navData
      titleBySlug = new Map(all.map(t => [t.slug, t.title]))
    }
  } catch {
    // titles are best-effort; fall back to the slug below
  }
  navEntries.value = rows.map((r, i) => ({
    slug: r.slug,
    title: titleBySlug.get(r.slug) ?? r.slug,
    missionId: 0,
    missionTitle: groupTitle,   // surfaced in the header
    groupId,
    groupTitle,
    prev: r.prev,
    next: r.next,
    missionGroupSeq: 0,
    groupOrder: i,              // preserve feed (itemOrder) order
  }))
  mode.value = 'group'
  return true
}

onMounted(async () => {
  try {
    // #1836: entry-group context wins when present.
    if (props.fromGroupSlug && await loadFromGroup(props.fromGroupSlug)) {
      document.addEventListener('click', onClickOutside, true)
      return
    }
    const res = await fetch('/tutorials/_nav.json')
    if (res.ok) {
      const navData = await res.json()
      const allTutorials: NavEntry[] = navData.tutorials ?? navData
      const current = allTutorials.find(t => t.slug === props.currentSlug)
      if (current && current.missionId) {
        navEntries.value = allTutorials.filter(t => t.missionId === current.missionId)
        mode.value = 'mission'
      } else {
        stepEntries.value = extractStepsFromDOM()
        mode.value = 'steps'
      }
    }
  } catch {
    stepEntries.value = extractStepsFromDOM()
    mode.value = 'steps'
  }
  document.addEventListener('click', onClickOutside, true)
})

onUnmounted(() => {
  document.removeEventListener('click', onClickOutside, true)
})
</script>

<template>
  <div v-if="isOpen" ref="dropdownEl" class="nav-dropdown">
    <!-- Mission / group mode: show sibling tutorials grouped by group -->
    <template v-if="mode === 'mission' || mode === 'group'">
      <div class="nav-dropdown-header">
        <span class="nav-dropdown-icon">&#127919;</span>
        <div>
          <div class="nav-dropdown-mission">{{ headerTitle }}</div>
          <div class="nav-dropdown-count">{{ navEntries.length }} tutorials</div>
        </div>
      </div>
      <div v-for="group in groups" :key="group.groupId" class="nav-dropdown-group">
        <!-- In group mode the single group's name already shows in the header. -->
        <div v-if="mode === 'mission'" class="nav-dropdown-group-title">{{ group.title }}</div>
        <a
          v-for="tut in group.tutorials"
          :key="tut.slug"
          :href="itemHref(tut.slug)"
          class="nav-dropdown-item"
          :class="{ 'is-current': tut.slug === currentSlug }"
        >
          <span class="nav-dropdown-bullet" :class="{ current: tut.slug === currentSlug }">
            <span v-if="tut.slug === currentSlug">&#9658;</span>
            <span v-else>&#9675;</span>
          </span>
          <span class="nav-dropdown-item-title">{{ tut.title }}</span>
        </a>
      </div>
    </template>

    <!-- Steps mode: show tutorial steps as in-page navigation -->
    <template v-else>
      <div class="nav-dropdown-header">
        <span class="nav-dropdown-icon">&#128221;</span>
        <div>
          <div class="nav-dropdown-mission">Tutorial Steps</div>
          <div class="nav-dropdown-count">{{ stepEntries.length }} steps</div>
        </div>
      </div>
      <div class="nav-dropdown-group">
        <a
          v-for="step in stepEntries"
          :key="step.number"
          :href="`#step-${step.number}`"
          class="nav-dropdown-item"
          @click="emit('close')"
        >
          <span class="nav-dropdown-bullet">
            <span class="step-num">{{ step.number }}</span>
          </span>
          <span class="nav-dropdown-item-title">{{ step.title }}</span>
        </a>
      </div>
    </template>
  </div>
</template>

<style scoped>
.nav-dropdown {
  position: absolute;
  top: 100%;
  left: 0;
  z-index: 100;
  width: 420px;
  max-height: 480px;
  overflow-y: auto;
  background: var(--sapGroup_ContentBackground, #fff);
  border: 1px solid var(--sapNeutralBorderColor, #d9d9d9);
  border-radius: 0.5rem;
  box-shadow: var(--sapContent_Shadow2, 0 0.25rem 1rem rgba(0, 0, 0, 0.15));
  margin-top: 0.25rem;
}

.nav-dropdown-header {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  padding: 1rem;
  border-bottom: 1px solid var(--sapNeutralBorderColor, #d9d9d9);
  background: var(--sapObjectHeader_Background, #fff);
}

.nav-dropdown-icon {
  font-size: 1.5rem;
}

.nav-dropdown-mission {
  font-size: 0.9375rem;
  font-weight: 600;
  color: var(--sapTextColor, #32363a);
  line-height: 1.3;
}

.nav-dropdown-count {
  font-size: 0.75rem;
  color: var(--sapNeutralTextColor, #6a6d70);
}

.nav-dropdown-group {
  padding: 0.5rem 0;
}

.nav-dropdown-group-title {
  padding: 0.375rem 1rem;
  font-size: 0.6875rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--sapNeutralTextColor, #6a6d70);
}

.nav-dropdown-item {
  display: flex;
  align-items: flex-start;
  gap: 0.5rem;
  padding: 0.5rem 1rem;
  text-decoration: none;
  color: var(--sapTextColor, #32363a);
  font-size: 0.8125rem;
  line-height: 1.4;
  transition: background 0.1s;
}

.nav-dropdown-item:hover {
  background: var(--sapList_Hover_Background, #f5f6f7);
}

.nav-dropdown-item.is-current {
  background: var(--sapList_SelectionBackgroundColor, #ebf5fe);
}

.nav-dropdown-bullet {
  flex-shrink: 0;
  width: 1rem;
  text-align: center;
  font-size: 0.625rem;
  margin-top: 0.15rem;
  color: var(--sapNeutralTextColor, #6a6d70);
}

.nav-dropdown-bullet.current {
  color: var(--sapBrandColor, #0070f2);
}

.nav-dropdown-item-title {
  flex: 1;
}

.step-num {
  font-size: 0.6875rem;
  font-weight: 600;
}
</style>
