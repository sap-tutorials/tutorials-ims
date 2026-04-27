<script setup lang="ts">
import { computed, onMounted } from 'vue'
import { useData } from 'vitepress'
import { useAemEnrichment } from '../composables/useAemEnrichment'
import ProgressBar from './ProgressBar.vue'

const { frontmatter } = useData()
const { data: aemData, fetchForMission } = useAemEnrichment()

const tutorials = computed(() => frontmatter.value.tutorials ?? [])
const displayTags = computed<string[]>(() => frontmatter.value.displayTags ?? [])

const description = computed(() => {
  const group = aemData.value?.groups.find(g => g.title === frontmatter.value.title)
  return group?.description ||
    `${frontmatter.value.tutorialCount} tutorials to ${frontmatter.value.title.toLowerCase()}.`
})

function capitalizeLevel(level: string): string {
  return level.charAt(0).toUpperCase() + level.slice(1)
}

function formatTime(minutes: number): string {
  if (minutes < 60) return `${minutes} min.`
  const hrs = Math.floor(minutes / 60)
  const mins = minutes % 60
  return mins > 0 ? `${hrs} hr. ${mins} min.` : `${hrs} hr.`
}

function aemTutorialProgress(slug: string): number {
  for (const g of aemData.value?.groups ?? []) {
    const t = g.tutorials.find(t => t.slug === slug)
    if (t) return t.progress
  }
  return 0
}

const completedCount = computed(() =>
  tutorials.value.filter((t: any) => aemTutorialProgress(t.slug) >= 100).length
)

onMounted(() => {
  fetchForMission(frontmatter.value.missionId)
})
</script>

<template>
  <div class="group-wrapper">
    <!-- Breadcrumb -->
    <nav class="group-breadcrumb-bar">
      <div class="breadcrumb-inner">
        <ul class="fd-breadcrumb">
          <li class="fd-breadcrumb__item"><a class="fd-breadcrumb__link" href="/">Tutorial Navigator</a></li>
          <li class="fd-breadcrumb__item">
            <a class="fd-breadcrumb__link" :href="`/tutorials/mission-${frontmatter.missionSlug}`">{{ frontmatter.missionTitle }}</a>
          </li>
          <li class="fd-breadcrumb__item"><span class="fd-breadcrumb__link fd-breadcrumb__link--current">{{ frontmatter.title }}</span></li>
        </ul>
      </div>
    </nav>

    <!-- Hero -->
    <section class="group-hero">
      <div class="hero-inner">
        <span class="type-badge type-badge--group">GROUP</span>
        <h1>{{ frontmatter.title }}</h1>
        <p class="group-description">{{ description }}</p>
        <div class="group-meta">
          <span class="meta-item"><span class="meta-icon">&#127891;</span> {{ capitalizeLevel(frontmatter.level) }}</span>
          <span class="meta-sep">&middot;</span>
          <span class="meta-item"><span class="meta-icon">&#9201;</span> {{ formatTime(frontmatter.totalTime) }}</span>
          <span class="meta-sep">&middot;</span>
          <span class="meta-item">{{ frontmatter.tutorialCount }} Tutorials</span>
        </div>
        <div v-if="displayTags.length" class="group-tags">
          <span v-for="tag in displayTags" :key="tag" class="tag-pill">{{ tag }}</span>
        </div>
      </div>
    </section>

    <!-- Content -->
    <div class="group-body">
      <ProgressBar :completed="completedCount" :total="tutorials.length" label="Group Progress" />

      <h2>Tutorials</h2>

      <div class="tutorial-timeline">
        <div v-for="(tut, idx) in tutorials" :key="tut.slug" class="timeline-item">
          <div class="timeline-connector">
            <span class="timeline-circle" :class="{ completed: aemTutorialProgress(tut.slug) >= 100 }">
              <span v-if="aemTutorialProgress(tut.slug) >= 100">&#10003;</span>
              <span v-else>{{ idx + 1 }}</span>
            </span>
            <div v-if="idx < tutorials.length - 1" class="timeline-line"></div>
          </div>
          <div class="timeline-card">
            <div class="timeline-card-header">
              <h3><a :href="`/tutorials/${tut.slug}`">{{ tut.title }}</a></h3>
              <div class="timeline-card-meta">
                <span>{{ capitalizeLevel(tut.level) }}</span>
                <span class="meta-sep">&middot;</span>
                <span>{{ tut.time }} min.</span>
                <span class="meta-sep">&middot;</span>
                <span>{{ tut.stepCount }} steps</span>
              </div>
            </div>
            <p class="timeline-card-desc">{{ tut.description }}</p>
            <div class="timeline-card-footer">
              <span class="timeline-card-tag">{{ tut.primaryTag }}</span>
              <a :href="`/tutorials/${tut.slug}`" class="start-btn">
                {{ aemTutorialProgress(tut.slug) >= 100 ? 'Review' : 'Start Tutorial' }} &rarr;
              </a>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.group-wrapper {
  background: var(--sapBackgroundColor, #f5f6f7);
  min-height: 100vh;
}

.group-breadcrumb-bar {
  background: var(--sapBaseColor, #fff);
  border-bottom: 1px solid var(--sapNeutralBorderColor, #d9d9d9);
  padding: 0.75rem 0;
}
.breadcrumb-inner {
  max-width: 1280px;
  margin: 0 auto;
  padding: 0 2rem;
  font-size: 0.8125rem;
}
.fd-breadcrumb { padding: 0; margin: 0; }
.breadcrumb-inner .fd-breadcrumb__link { font-size: 0.8125rem; }
.breadcrumb-inner .fd-breadcrumb__link--current { color: var(--sapTextColor, #32363a); cursor: default; }

.group-hero {
  background: var(--sapShellColor, #354a5f);
  color: var(--sapShell_TextColor, #fff);
  padding: 2.5rem 2rem;
}
.hero-inner {
  max-width: 1280px;
  margin: 0 auto;
}
.type-badge {
  display: inline-block;
  font-size: 0.6875rem;
  font-weight: 700;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  padding: 0.2rem 0.625rem;
  border-radius: 1rem;
  margin-bottom: 0.75rem;
}
.type-badge--group {
  background: rgba(108, 50, 169, 0.2);
  color: #c4a0ef;
  border: 1px solid rgba(196, 160, 239, 0.3);
}
.group-hero h1 {
  font-size: 2rem;
  font-weight: 700;
  margin: 0 0 0.75rem;
  color: inherit;
  line-height: 1.25;
}
.group-description {
  font-size: 1rem;
  line-height: 1.7;
  opacity: 0.9;
  max-width: 700px;
  margin: 0 0 1rem;
}
.group-meta {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  font-size: 0.875rem;
  opacity: 0.85;
  flex-wrap: wrap;
  margin-bottom: 1rem;
}
.meta-item {
  display: inline-flex;
  align-items: center;
  gap: 0.25rem;
}
.meta-icon { font-size: 1rem; }
.meta-sep { opacity: 0.5; }
.group-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 0.375rem;
}
.tag-pill {
  display: inline-block;
  padding: 0.15rem 0.5rem;
  border: 1px solid rgba(255, 255, 255, 0.35);
  border-radius: 1rem;
  font-size: 0.6875rem;
  font-weight: 600;
  color: rgba(255, 255, 255, 0.9);
}

.group-body {
  max-width: 1280px;
  margin: 0 auto;
  padding: 1.5rem 2rem 3rem;
}

.group-body h2 {
  font-size: 1.25rem;
  font-weight: 700;
  margin: 1.5rem 0 1rem;
  color: var(--sapTextColor, #32363a);
}

.tutorial-timeline {
  display: flex;
  flex-direction: column;
}

.timeline-item {
  display: flex;
  gap: 1rem;
}

.timeline-connector {
  display: flex;
  flex-direction: column;
  align-items: center;
  flex-shrink: 0;
  width: 2rem;
}

.timeline-circle {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 2rem;
  height: 2rem;
  border-radius: 50%;
  border: 2px solid var(--sapNeutralBorderColor, #bcc3ca);
  color: var(--sapNeutralTextColor, #6a6d70);
  font-weight: 700;
  font-size: 0.8125rem;
  background: var(--sapBaseColor, #fff);
  z-index: 1;
}

.timeline-circle.completed {
  background: var(--sapPositiveColor, #107e3e);
  border-color: var(--sapPositiveColor, #107e3e);
  color: #fff;
}

.timeline-line {
  width: 2px;
  flex: 1;
  background: var(--sapNeutralBorderColor, #bcc3ca);
  min-height: 1rem;
}

.timeline-card {
  flex: 1;
  background: var(--sapBaseColor, #fff);
  border-radius: 0.75rem;
  padding: 1.25rem 1.5rem;
  margin-bottom: 0.75rem;
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.06);
  transition: box-shadow 0.15s;
}
.timeline-card:hover {
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.1);
}

.timeline-card-header h3 {
  font-size: 1rem;
  font-weight: 700;
  margin: 0 0 0.25rem;
  line-height: 1.4;
}
.timeline-card-header h3 a {
  color: var(--sapTextColor, #32363a);
  text-decoration: none;
}
.timeline-card-header h3 a:hover {
  color: var(--sapBrandColor, #0070f2);
}

.timeline-card-meta {
  display: flex;
  align-items: center;
  gap: 0.375rem;
  font-size: 0.75rem;
  color: var(--sapNeutralTextColor, #6a6d70);
}
.timeline-card-meta .meta-sep { color: var(--sapNeutralBorderColor, #d9d9d9); }

.timeline-card-desc {
  font-size: 0.8125rem;
  line-height: 1.6;
  color: var(--sapContent_LabelColor, #556b82);
  margin: 0.5rem 0;
}

.timeline-card-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-top: 0.75rem;
  padding-top: 0.75rem;
  border-top: 1px solid var(--sapGroup_ContentBorderColor, #e5e5e5);
}

.timeline-card-tag {
  display: inline-flex;
  align-items: center;
  gap: 0.25rem;
  font-size: 0.75rem;
  font-weight: 600;
  color: var(--sapBrandColor, #0070f2);
}

.start-btn {
  display: inline-flex;
  align-items: center;
  padding: 0.375rem 1rem;
  border-radius: 2rem;
  background: var(--sapBrandColor, #0070f2);
  color: #fff;
  text-decoration: none;
  font-size: 0.8125rem;
  font-weight: 600;
  transition: background 0.15s;
}
.start-btn:hover {
  background: var(--sapHighlightColor, #0064d9);
  color: #fff;
}

@media (max-width: 768px) {
  .group-hero h1 { font-size: 1.5rem; }
  .group-body { padding: 1rem; }
  .timeline-card { padding: 1rem; }
}
</style>
