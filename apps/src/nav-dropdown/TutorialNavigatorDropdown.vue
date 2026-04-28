<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue'

interface NavEntry {
  slug: string
  title: string
  missionId: number
  missionTitle: string
  groupId: number
  groupTitle: string
  prev: string | null
  next: string | null
}

const props = defineProps<{
  currentSlug: string
  isOpen: boolean
  toggleElement?: HTMLElement | null
}>()

const emit = defineEmits<{
  close: []
}>()

const navEntries = ref<NavEntry[]>([])
const dropdownEl = ref<HTMLElement | null>(null)

const groups = computed(() => {
  const map = new Map<number, { title: string; tutorials: NavEntry[] }>()
  for (const entry of navEntries.value) {
    if (!map.has(entry.groupId)) {
      map.set(entry.groupId, { title: entry.groupTitle, tutorials: [] })
    }
    map.get(entry.groupId)!.tutorials.push(entry)
  }
  return Array.from(map.values())
})

const missionTitle = computed(() => navEntries.value[0]?.missionTitle ?? '')

function onClickOutside(e: MouseEvent) {
  const target = e.target as Node
  if (dropdownEl.value && !dropdownEl.value.contains(target) &&
      !(props.toggleElement && props.toggleElement.contains(target))) {
    emit('close')
  }
}

onMounted(async () => {
  try {
    const res = await fetch('/tutorials/_nav.json')
    if (res.ok) {
      const navData = await res.json()
      navEntries.value = navData.tutorials ?? navData
    }
  } catch {}
  document.addEventListener('click', onClickOutside, true)
})

onUnmounted(() => {
  document.removeEventListener('click', onClickOutside, true)
})
</script>

<template>
  <div v-if="isOpen" ref="dropdownEl" class="nav-dropdown">
    <div class="nav-dropdown-header">
      <span class="nav-dropdown-icon">&#127919;</span>
      <div>
        <div class="nav-dropdown-mission">{{ missionTitle }}</div>
        <div class="nav-dropdown-count">{{ navEntries.length }} tutorials</div>
      </div>
    </div>
    <div v-for="group in groups" :key="group.title" class="nav-dropdown-group">
      <div class="nav-dropdown-group-title">{{ group.title }}</div>
      <a
        v-for="tut in group.tutorials"
        :key="tut.slug"
        :href="`/tutorials/${tut.slug}`"
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
</style>
