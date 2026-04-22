<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useData } from 'vitepress'
import { useApi } from '../composables/useApi'
import ProgressBar from './ProgressBar.vue'

interface NavNode {
  title: string
  slug?: string
  type: 'mission' | 'group' | 'tutorial'
  progress: number
  url?: string
  children?: NavNode[]
}

const { frontmatter } = useData()
const { get } = useApi()
const navTree = ref<NavNode[]>([])
const expandedGroups = ref<Set<string>>(new Set())

const currentSlug = computed(() => frontmatter.value.slug)

onMounted(async () => {
  const missionId = frontmatter.value.missionId
  if (!missionId) return

  const data = await get<{ context: NavNode[] }>(`/missions/${missionId}/navigation`)
  if (data) {
    navTree.value = data.context
    for (const node of data.context) {
      if (node.children?.some(c => c.slug === currentSlug.value)) {
        expandedGroups.value.add(node.title)
      }
    }
  }
})

function toggleGroup(title: string) {
  if (expandedGroups.value.has(title)) {
    expandedGroups.value.delete(title)
  } else {
    expandedGroups.value.add(title)
  }
}
</script>

<template>
  <nav class="mini-navigator" v-if="navTree.length">
    <div v-for="mission in navTree" :key="mission.title" class="nav-mission">
      <div class="nav-mission-title">{{ mission.title }}</div>
      <div v-for="group in mission.children" :key="group.title" class="nav-group">
        <div class="nav-group-header" @click="toggleGroup(group.title)">
          <span>{{ expandedGroups.has(group.title) ? '▼' : '▶' }}</span>
          <span>{{ group.title }}</span>
        </div>
        <div v-if="expandedGroups.has(group.title)" class="nav-group-items">
          <a
            v-for="tut in group.children"
            :key="tut.slug"
            :href="`/tutorials/${tut.slug}`"
            class="nav-tutorial"
            :class="{ 'is-current': tut.slug === currentSlug }"
          >
            <span class="nav-tutorial-title">{{ tut.title }}</span>
            <ProgressBar v-if="tut.progress > 0" :completed="tut.progress" :total="100" />
          </a>
        </div>
      </div>
    </div>
  </nav>
</template>

<style scoped>
.mini-navigator {
  font-size: 0.875rem;
  border: 1px solid var(--sapNeutralBorderColor, #d9d9d9);
  border-radius: 0.5rem;
  padding: 1rem;
}
.nav-mission-title {
  font-weight: 700;
  margin-bottom: 0.5rem;
  color: var(--sapBrandColor, #0070f2);
}
.nav-group-header {
  cursor: pointer;
  padding: 0.25rem 0;
  display: flex;
  gap: 0.5rem;
  font-weight: 600;
}
.nav-group-items {
  padding-left: 1rem;
}
.nav-tutorial {
  display: block;
  padding: 0.375rem 0;
  color: var(--sapLinkColor, #0064d9);
  text-decoration: none;
}
.nav-tutorial:hover {
  text-decoration: underline;
}
.nav-tutorial.is-current {
  font-weight: 700;
  color: var(--sapTextColor, #32363a);
}
</style>
