<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'

interface TutorialEntry {
  slug: string
  title: string
  missionId: number
  groupId: number
  groupTitle: string
  prev: string | null
  next: string | null
}

const tutorials = ref<TutorialEntry[]>([])
const searchQuery = ref('')

onMounted(async () => {
  const res = await fetch('/tutorials/_nav.json')
  if (res.ok) {
    tutorials.value = await res.json()
  }
})

const filtered = computed(() => {
  if (!searchQuery.value) return tutorials.value
  const q = searchQuery.value.toLowerCase()
  return tutorials.value.filter(t =>
    t.title.toLowerCase().includes(q) || t.slug.toLowerCase().includes(q)
  )
})

const groups = computed(() => {
  const map = new Map<string, TutorialEntry[]>()
  for (const t of filtered.value) {
    const list = map.get(t.groupTitle) ?? []
    list.push(t)
    map.set(t.groupTitle, list)
  }
  return map
})
</script>

<template>
  <div class="tutorial-list">
    <div class="search-bar">
      <input
        type="text"
        v-model="searchQuery"
        placeholder="Search tutorials..."
        class="search-input"
      />
    </div>
    <div v-for="[groupTitle, tuts] in groups" :key="groupTitle" class="tutorial-group">
      <h3>{{ groupTitle }}</h3>
      <div class="tutorial-cards">
        <a
          v-for="t in tuts"
          :key="t.slug"
          :href="`/tutorials/${t.slug}`"
          class="fd-card tutorial-card"
          role="listitem"
        >
          <div class="fd-card__header">
            <div class="fd-card__title-area">
              <span class="fd-card__title">{{ t.title }}</span>
            </div>
          </div>
        </a>
      </div>
    </div>
    <p v-if="filtered.length === 0">No tutorials found.</p>
  </div>
</template>

<style scoped>
.tutorial-list {
  max-width: 900px;
  margin: 0 auto;
}
.search-bar {
  margin-bottom: 1.5rem;
}
.search-input {
  width: 100%;
  padding: 0.75rem 1rem;
  border: 1px solid var(--sapNeutralBorderColor, #d9d9d9);
  border-radius: 0.5rem;
  font-size: 1rem;
}
.tutorial-group h3 {
  margin-top: 1.5rem;
}
.tutorial-cards {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: 1rem;
  margin-top: 0.5rem;
}
.tutorial-card {
  display: block;
  text-decoration: none;
  color: inherit;
  padding: 1rem;
  border: 1px solid var(--sapNeutralBorderColor, #d9d9d9);
  border-radius: 0.5rem;
  transition: box-shadow 0.2s;
}
.tutorial-card:hover {
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.12);
}
</style>
