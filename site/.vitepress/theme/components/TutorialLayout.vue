<script setup lang="ts">
import { ref, computed, provide, onMounted } from 'vue'
import { useData } from 'vitepress'
import { useApi } from '../composables/useApi'
import ProgressBar from './ProgressBar.vue'
import PointsBadge from './PointsBadge.vue'
import MiniNavigator from './MiniNavigator.vue'

const { frontmatter } = useData()
const { get } = useApi()

const completedSteps = ref<Set<number>>(new Set())
const points = ref(0)
const badges = ref<Array<{ name: string; icon: string }>>([])

const stepCount = computed(() => frontmatter.value.stepCount ?? 0)
const completedCount = computed(() => completedSteps.value.size)

function onStepCompleted(stepNumber: number) {
  completedSteps.value.add(stepNumber)
  completedSteps.value = new Set(completedSteps.value)
}

provide('completedSteps', completedSteps)
provide('onStepCompleted', onStepCompleted)

onMounted(async () => {
  const slug = frontmatter.value.slug
  const progress = await get<{ completedSteps: number[]; points: number; badges: Array<{ name: string; icon: string }> }>(
    `/tutorials/${slug}/progress`
  )
  if (progress) {
    completedSteps.value = new Set(progress.completedSteps)
    points.value = progress.points
    badges.value = progress.badges
  }
})
</script>

<template>
  <div class="tutorial-page">
    <aside class="tutorial-sidebar">
      <MiniNavigator />
    </aside>
    <main class="tutorial-main">
      <div class="tutorial-header">
        <div class="tutorial-breadcrumb">
          <a href="/">Tutorials</a>
          <span v-if="frontmatter.groupTitle"> / {{ frontmatter.groupTitle }}</span>
        </div>
        <h1>{{ frontmatter.title }}</h1>
        <p class="tutorial-description">{{ frontmatter.description }}</p>
        <div class="tutorial-meta">
          <span class="fd-badge">{{ frontmatter.level }}</span>
          <span>{{ frontmatter.time }} min</span>
          <span>{{ frontmatter.author }}</span>
        </div>
        <ProgressBar
          :completed="completedCount"
          :total="stepCount"
          label="Tutorial Progress"
        />
        <PointsBadge :points="points" :badges="badges" />
      </div>

      <div class="tutorial-nav-top">
        <a v-if="frontmatter.prev" :href="`/tutorials/${frontmatter.prev}`" class="fd-button">
          ← Previous
        </a>
        <a v-if="frontmatter.next" :href="`/tutorials/${frontmatter.next}`" class="fd-button">
          Next →
        </a>
      </div>

      <div class="tutorial-steps">
        <Content />
      </div>

      <div class="tutorial-nav-bottom">
        <a v-if="frontmatter.prev" :href="`/tutorials/${frontmatter.prev}`" class="fd-button">
          ← Previous
        </a>
        <a v-if="frontmatter.next" :href="`/tutorials/${frontmatter.next}`" class="fd-button fd-button--emphasized">
          Next →
        </a>
      </div>
    </main>
  </div>
</template>

<style scoped>
.tutorial-page {
  display: flex;
  max-width: 1200px;
  margin: 0 auto;
  padding: 1rem;
  gap: 2rem;
}
.tutorial-sidebar {
  width: 280px;
  flex-shrink: 0;
}
.tutorial-main {
  flex: 1;
  min-width: 0;
}
.tutorial-header {
  margin-bottom: 2rem;
}
.tutorial-breadcrumb {
  font-size: 0.875rem;
  margin-bottom: 0.5rem;
  color: var(--sapNeutralTextColor, #6a6d70);
}
.tutorial-breadcrumb a {
  color: var(--sapLinkColor, #0064d9);
}
.tutorial-description {
  color: var(--sapNeutralTextColor, #6a6d70);
  margin: 0.5rem 0;
}
.tutorial-meta {
  display: flex;
  gap: 1rem;
  align-items: center;
  margin: 0.5rem 0;
  font-size: 0.875rem;
}
.tutorial-nav-top,
.tutorial-nav-bottom {
  display: flex;
  justify-content: space-between;
  margin: 1.5rem 0;
}

@media (max-width: 768px) {
  .tutorial-page {
    flex-direction: column;
  }
  .tutorial-sidebar {
    width: 100%;
  }
}
</style>
