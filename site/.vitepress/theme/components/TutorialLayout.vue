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
const allExpanded = ref<boolean | null>(null)

const stepCount = computed(() => frontmatter.value.stepCount ?? 0)
const completedCount = computed(() => completedSteps.value.size)
const youWillLearn = computed<string[]>(() => frontmatter.value.youWillLearn ?? [])
const prerequisites = computed<string[]>(() => {
  const val = frontmatter.value.prerequisites
  if (Array.isArray(val)) return val
  if (typeof val === 'string' && val) return [val]
  return []
})
const displayTags = computed<string[]>(() => frontmatter.value.displayTags ?? [])
const stepsList = computed<Array<{ number: number; title: string }>>(() => frontmatter.value.steps ?? [])
const authorAvatar = computed(() => {
  const profile = frontmatter.value.authorProfile
  if (profile && profile.startsWith('https://github.com/')) {
    const username = profile.replace('https://github.com/', '')
    return `https://github.com/${username}.png?size=48`
  }
  return ''
})

function onStepCompleted(stepNumber: number) {
  completedSteps.value.add(stepNumber)
  completedSteps.value = new Set(completedSteps.value)
}

function expandAll() { allExpanded.value = true }
function collapseAll() { allExpanded.value = false }
function scrollToStep(n: number) {
  const el = document.getElementById('step-' + n)
  if (el) {
    allExpanded.value = null
    el.scrollIntoView({ behavior: 'smooth' })
  }
}

function mdInline(text: string): string {
  return text
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
}

provide('completedSteps', completedSteps)
provide('onStepCompleted', onStepCompleted)
provide('allExpanded', allExpanded)

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
      <!-- Breadcrumb -->
      <nav class="tutorial-breadcrumb">
        <a href="/">{{ frontmatter.missionTitle }}</a>
        <span class="breadcrumb-sep">&rsaquo;</span>
        <span>{{ frontmatter.groupTitle }}</span>
        <span class="breadcrumb-sep">&rsaquo;</span>
        <span class="breadcrumb-current">{{ frontmatter.title }}</span>
      </nav>

      <!-- Top Navigation -->
      <div class="tutorial-nav">
        <a v-if="frontmatter.prev" :href="`/tutorials/${frontmatter.prev}`" class="nav-pill">
          &larr; Previous
        </a>
        <div class="nav-spacer"></div>
        <a v-if="frontmatter.next" :href="`/tutorials/${frontmatter.next}`" class="nav-pill nav-pill--primary">
          Next &rarr;
        </a>
      </div>

      <!-- Title -->
      <h1 class="tutorial-title">{{ frontmatter.title }}</h1>

      <!-- Meta row -->
      <div class="tutorial-meta">
        <span class="meta-item">
          <span class="meta-icon">&#127891;</span>
          <span class="meta-level">{{ frontmatter.level }}</span>
        </span>
        <span class="meta-item">
          <span class="meta-icon">&#9201;</span>
          <span>{{ frontmatter.time }} min.</span>
        </span>
      </div>

      <!-- Tags -->
      <div v-if="displayTags.length" class="tutorial-tags">
        <span class="meta-icon">&#127991;</span>
        <span v-for="tag in displayTags" :key="tag" class="tutorial-tag">{{ tag }}</span>
      </div>

      <!-- Description -->
      <p class="tutorial-description">{{ frontmatter.description }}</p>

      <!-- You will learn -->
      <div v-if="youWillLearn.length" class="you-will-learn">
        <h3>You will learn</h3>
        <ul>
          <li v-for="(item, i) in youWillLearn" :key="i">
            <span class="check-icon">&#10004;</span>
            <span v-html="mdInline(item)"></span>
          </li>
        </ul>
      </div>

      <!-- Author -->
      <div class="tutorial-author" v-if="frontmatter.author">
        <img v-if="authorAvatar" :src="authorAvatar" :alt="frontmatter.author" class="author-avatar" />
        <strong>{{ frontmatter.author }}</strong>
      </div>

      <!-- Prerequisites -->
      <div v-if="prerequisites.length" class="prerequisites-box">
        <h4>Prerequisites</h4>
        <ul>
          <li v-for="(item, i) in prerequisites" :key="i" v-html="mdInline(item)"></li>
        </ul>
      </div>

      <!-- Progress -->
      <ProgressBar :completed="completedCount" :total="stepCount" label="Tutorial Progress" />
      <PointsBadge :points="points" :badges="badges" />

      <!-- Step TOC -->
      <div v-if="stepsList.length" class="step-toc">
        <a
          v-for="step in stepsList"
          :key="step.number"
          class="step-toc-item"
          href="#"
          @click.prevent="scrollToStep(step.number)"
        >
          <span class="step-toc-number">{{ step.number }}</span>
          <span class="step-toc-label">Step {{ step.number }}:</span>
          <span class="step-toc-title">{{ step.title }}</span>
        </a>
        <a href="#" class="step-toc-back" @click.prevent="window.scrollTo({ top: 0, behavior: 'smooth' })">Back to Top</a>
      </div>

      <!-- Step controls -->
      <div class="step-controls">
        <a href="#" @click.prevent="expandAll">Open all</a>
        <a href="#" @click.prevent="collapseAll">Close all</a>
      </div>

      <!-- Tutorial steps -->
      <div class="tutorial-steps">
        <Content />
      </div>

      <!-- Bottom Navigation -->
      <div class="tutorial-nav tutorial-nav-bottom">
        <a v-if="frontmatter.prev" :href="`/tutorials/${frontmatter.prev}`" class="nav-pill">
          &larr; Previous
        </a>
        <div class="nav-spacer"></div>
        <a v-if="frontmatter.next" :href="`/tutorials/${frontmatter.next}`" class="nav-pill nav-pill--primary">
          Next &rarr;
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
  background: var(--sapBackgroundColor, #f5f6f7);
  min-height: 100vh;
}
.tutorial-sidebar {
  width: 280px;
  flex-shrink: 0;
}
.tutorial-main {
  flex: 1;
  min-width: 0;
  background: var(--sapBaseColor, #fff);
  border-radius: 0.5rem;
  padding: 2rem;
}

/* Breadcrumb */
.tutorial-breadcrumb {
  font-size: 0.8125rem;
  margin-bottom: 1rem;
  color: var(--sapNeutralTextColor, #6a6d70);
  line-height: 1.5;
}
.tutorial-breadcrumb a {
  color: var(--sapLinkColor, #0064d9);
  text-decoration: none;
}
.tutorial-breadcrumb a:hover {
  text-decoration: underline;
}
.breadcrumb-sep {
  margin: 0 0.25rem;
  color: var(--sapNeutralTextColor, #6a6d70);
}
.breadcrumb-current {
  color: var(--sapTextColor, #32363a);
}

/* Navigation pills */
.tutorial-nav {
  display: flex;
  align-items: center;
  margin-bottom: 1.5rem;
}
.tutorial-nav-bottom {
  margin-top: 2rem;
  margin-bottom: 0;
}
.nav-spacer {
  flex: 1;
}
.nav-pill {
  display: inline-flex;
  align-items: center;
  padding: 0.5rem 1.25rem;
  border-radius: 2rem;
  border: 1px solid var(--sapBrandColor, #0070f2);
  color: var(--sapBrandColor, #0070f2);
  text-decoration: none;
  font-size: 0.875rem;
  font-weight: 600;
  transition: all 0.15s;
}
.nav-pill:hover {
  background: var(--sapBrandColor, #0070f2);
  color: #fff;
}
.nav-pill--primary {
  background: var(--sapBrandColor, #0070f2);
  color: #fff;
}
.nav-pill--primary:hover {
  background: var(--sapHighlightColor, #0064d9);
  color: #fff;
}

/* Title */
.tutorial-title {
  font-size: 2rem;
  font-weight: 600;
  line-height: 1.25;
  margin: 0 0 1rem;
  color: var(--sapTextColor, #32363a);
}

/* Meta */
.tutorial-meta {
  display: flex;
  gap: 1.5rem;
  align-items: center;
  margin-bottom: 0.75rem;
  font-size: 0.875rem;
  color: var(--sapTextColor, #32363a);
}
.meta-item {
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
}
.meta-icon {
  font-size: 1rem;
}
.meta-level {
  text-transform: capitalize;
}

/* Tags */
.tutorial-tags {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 0.5rem;
  margin-bottom: 1rem;
}
.tutorial-tag {
  display: inline-block;
  padding: 0.2rem 0.75rem;
  border: 1px solid var(--sapBrandColor, #0070f2);
  border-radius: 1rem;
  color: var(--sapBrandColor, #0070f2);
  font-size: 0.75rem;
  font-weight: 600;
}

/* Description */
.tutorial-description {
  color: var(--sapTextColor, #32363a);
  font-size: 1rem;
  line-height: 1.6;
  margin-bottom: 1.5rem;
}

/* You will learn */
.you-will-learn {
  margin-bottom: 1.5rem;
}
.you-will-learn h3 {
  font-size: 1rem;
  font-weight: 600;
  margin-bottom: 0.5rem;
  color: var(--sapTextColor, #32363a);
}
.you-will-learn ul {
  list-style: none;
  padding: 0;
  margin: 0;
}
.you-will-learn li {
  display: flex;
  gap: 0.5rem;
  margin-bottom: 0.35rem;
  line-height: 1.5;
}
.check-icon {
  color: var(--sapPositiveColor, #107e3e);
  flex-shrink: 0;
  font-size: 0.875rem;
  margin-top: 0.15rem;
}
.you-will-learn :deep(a) {
  color: var(--sapLinkColor, #0064d9);
}

/* Author */
.tutorial-author {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  margin-bottom: 1.5rem;
  font-size: 0.875rem;
}
.author-avatar {
  width: 40px;
  height: 40px;
  border-radius: 50%;
  border: 1px solid var(--sapNeutralBorderColor, #d9d9d9);
}

/* Prerequisites */
.prerequisites-box {
  background: #e8f4fd;
  border-left: 4px solid var(--sapBrandColor, #0070f2);
  padding: 1rem 1.25rem;
  border-radius: 0 0.5rem 0.5rem 0;
  margin-bottom: 1.5rem;
}
.prerequisites-box h4 {
  margin: 0 0 0.5rem;
  font-size: 1rem;
  font-weight: 600;
  color: var(--sapTextColor, #32363a);
}
.prerequisites-box ul {
  margin: 0;
  padding-left: 1.25rem;
}
.prerequisites-box li {
  margin-bottom: 0.35rem;
  line-height: 1.5;
}
.prerequisites-box :deep(a) {
  color: var(--sapLinkColor, #0064d9);
}

/* Step TOC */
.step-toc {
  border: 1px solid var(--sapNeutralBorderColor, #d9d9d9);
  border-radius: 0.5rem;
  padding: 1rem;
  margin: 1.5rem 0;
}
.step-toc-item {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  padding: 0.5rem 0;
  text-decoration: none;
  color: var(--sapLinkColor, #0064d9);
  font-size: 0.875rem;
}
.step-toc-item:hover {
  text-decoration: underline;
}
.step-toc-number {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 1.75rem;
  height: 1.75rem;
  border-radius: 50%;
  border: 2px solid var(--sapBrandColor, #0070f2);
  color: var(--sapBrandColor, #0070f2);
  font-weight: 600;
  font-size: 0.75rem;
  flex-shrink: 0;
}
.step-toc-label {
  font-weight: 600;
}
.step-toc-title {
  color: var(--sapLinkColor, #0064d9);
}
.step-toc-back {
  display: block;
  text-align: right;
  margin-top: 0.5rem;
  font-size: 0.875rem;
  font-weight: 600;
  color: var(--sapTextColor, #32363a);
  text-decoration: none;
}

/* Step controls */
.step-controls {
  display: flex;
  justify-content: flex-end;
  gap: 1.5rem;
  margin-bottom: 0.75rem;
  font-size: 0.875rem;
}
.step-controls a {
  color: var(--sapLinkColor, #0064d9);
  text-decoration: none;
  font-weight: 600;
}
.step-controls a:hover {
  text-decoration: underline;
}

@media (max-width: 768px) {
  .tutorial-page {
    flex-direction: column;
  }
  .tutorial-sidebar {
    width: 100%;
  }
  .tutorial-title {
    font-size: 1.5rem;
  }
}
</style>
