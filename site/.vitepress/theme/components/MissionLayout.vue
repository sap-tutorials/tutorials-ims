<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useData } from 'vitepress'
import { useAemEnrichment } from '../composables/useAemEnrichment'
import ProgressBar from './ProgressBar.vue'
import TutorialNavigatorDropdown from './TutorialNavigatorDropdown.vue'
import FeedbackShareBar from './FeedbackShareBar.vue'

const { frontmatter } = useData()
const { data: aemData, loading, fetchForMission } = useAemEnrichment()

const navDropdownOpen = ref(false)
const navToggleBtn = ref<HTMLElement | null>(null)
const expandedGroups = ref<Set<number>>(new Set())

function toggleNavDropdown() { navDropdownOpen.value = !navDropdownOpen.value }
function closeNavDropdown() { navDropdownOpen.value = false }

const groups = computed(() => frontmatter.value.groups ?? [])
const displayTags = computed<string[]>(() => frontmatter.value.displayTags ?? [])
const description = computed(() =>
  aemData.value?.description ||
  `Complete this mission to build full-stack applications. Includes ${frontmatter.value.tutorialCount} tutorials across ${frontmatter.value.groupCount} groups.`
)
const progress = computed(() => aemData.value?.progress ?? 0)
const missionIcon = computed(() => {
  const raw = aemData.value?.icon ?? ''
  if (!raw || !raw.startsWith('<')) return ''
  return raw
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

function groupTime(group: any): number {
  return (group.tutorials ?? []).reduce((sum: number, t: any) => sum + (t.time ?? 0), 0)
}

function groupDescription(group: any): string {
  const aemGroup = aemData.value?.groups.find(g => g.title === group.title)
  return aemGroup?.description ||
    `${group.tutorials.length} tutorials to ${group.title.toLowerCase()}.`
}

function aemGroupProgress(groupTitle: string): number {
  return aemData.value?.groups.find(g => g.title === groupTitle)?.progress ?? 0
}

function aemTutorialProgress(slug: string): number {
  for (const g of aemData.value?.groups ?? []) {
    const t = g.tutorials.find(t => t.slug === slug)
    if (t) return t.progress
  }
  return 0
}

function toggleGroup(groupId: number) {
  const s = new Set(expandedGroups.value)
  if (s.has(groupId)) s.delete(groupId)
  else s.add(groupId)
  expandedGroups.value = s
}

function isGroupExpanded(groupId: number): boolean {
  return expandedGroups.value.has(groupId)
}

onMounted(() => {
  if (groups.value.length > 0) {
    expandedGroups.value = new Set([groups.value[0].id])
  }
  fetchForMission(frontmatter.value.missionId)
})
</script>

<template>
  <div class="mission-wrapper">
    <!-- Breadcrumb -->
    <nav class="mission-breadcrumb-bar">
      <div class="breadcrumb-inner breadcrumb-inner--with-dropdown">
        <ul class="fd-breadcrumb">
          <li class="fd-breadcrumb__item breadcrumb-nav-item">
            <a class="fd-breadcrumb__link" href="/">Tutorial Navigator</a>
            <button ref="navToggleBtn" class="breadcrumb-dropdown-trigger" @click="toggleNavDropdown" aria-label="Toggle tutorial navigation">
              <span class="breadcrumb-caret">&#9662;</span>
            </button>
          </li>
          <li class="fd-breadcrumb__item"><span class="fd-breadcrumb__link fd-breadcrumb__link--current">{{ frontmatter.title }}</span></li>
        </ul>
        <TutorialNavigatorDropdown
          :current-slug="frontmatter.slug"
          :is-open="navDropdownOpen"
          :toggle-element="navToggleBtn"
          @close="closeNavDropdown"
        />
      </div>
    </nav>

    <!-- Action bar -->
    <FeedbackShareBar :title="frontmatter.title" :slug="frontmatter.slug" page-type="mission" />

    <!-- Hero -->
    <section class="mission-hero">
      <div class="hero-inner">
        <div class="hero-top">
          <div class="hero-text">
            <span class="type-badge type-badge--mission">MISSION</span>
            <h1>{{ frontmatter.title }}</h1>
            <p class="mission-description">{{ description }}</p>
            <div class="mission-meta">
              <span class="meta-item"><span class="meta-icon">&#127891;</span> {{ capitalizeLevel(frontmatter.level) }}</span>
              <span class="meta-sep">&middot;</span>
              <span class="meta-item"><span class="meta-icon">&#9201;</span> {{ formatTime(frontmatter.totalTime) }}</span>
              <span class="meta-sep">&middot;</span>
              <span class="meta-item">{{ frontmatter.tutorialCount }} Tutorials</span>
              <span class="meta-sep">&middot;</span>
              <span class="meta-item">{{ frontmatter.groupCount }} Groups</span>
            </div>
            <div v-if="displayTags.length" class="mission-tags">
              <span v-for="tag in displayTags" :key="tag" class="tag-pill">{{ tag }}</span>
            </div>
          </div>
          <div v-if="missionIcon" class="hero-icon" v-html="missionIcon"></div>
        </div>
      </div>
    </section>

    <!-- Content -->
    <div class="mission-body">
      <!-- Progress -->
      <ProgressBar :completed="progress" :total="100" label="Mission Progress" />

      <!-- Groups -->
      <div class="groups-section">
        <h2>Groups in this Mission</h2>
        <div v-for="group in groups" :key="group.id" class="group-card">
          <div class="group-card-header" @click="toggleGroup(group.id)">
            <div class="group-header-left">
              <span class="type-badge type-badge--group">GROUP</span>
              <h3>
                <a :href="`/tutorials/group-${group.slug}`" @click.stop>{{ group.title }}</a>
              </h3>
              <span class="group-meta">{{ formatTime(groupTime(group)) }} &middot; {{ group.tutorials.length }} Tutorials</span>
              <p class="group-description">{{ groupDescription(group) }}</p>
            </div>
            <span class="group-chevron" :class="{ expanded: isGroupExpanded(group.id) }">&#9662;</span>
          </div>
          <div v-show="isGroupExpanded(group.id)" class="group-card-body">
            <ol class="group-tutorials">
              <li v-for="(tut, idx) in group.tutorials" :key="tut.slug" class="tutorial-item">
                <span class="tutorial-number" :class="{ completed: aemTutorialProgress(tut.slug) >= 100 }">
                  <span v-if="aemTutorialProgress(tut.slug) >= 100">&#10003;</span>
                  <span v-else>{{ idx + 1 }}</span>
                </span>
                <div class="tutorial-info">
                  <a :href="`/tutorials/${tut.slug}`" class="tutorial-link">{{ tut.title }}</a>
                  <div class="tutorial-meta-row">
                    <span>{{ capitalizeLevel(tut.level) }}</span>
                    <span class="meta-sep">&middot;</span>
                    <span>{{ tut.time }} min.</span>
                    <span class="meta-sep">&middot;</span>
                    <span>{{ tut.stepCount }} steps</span>
                  </div>
                </div>
              </li>
            </ol>
            <a :href="`/tutorials/group-${group.slug}`" class="group-start-link">
              View Group &rarr;
            </a>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.mission-wrapper {
  background: var(--sapBackgroundColor, #f5f6f7);
  min-height: 100vh;
}

.mission-breadcrumb-bar {
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
.breadcrumb-inner--with-dropdown {
  position: relative;
}
.breadcrumb-nav-item {
  display: inline-flex;
  align-items: center;
  gap: 0.15rem;
}
.breadcrumb-dropdown-trigger {
  background: none;
  border: none;
  padding: 0.125rem 0.25rem;
  cursor: pointer;
  color: inherit;
  line-height: 1;
  border-radius: 0.25rem;
}
.breadcrumb-dropdown-trigger:hover {
  background: var(--sapNeutralBackground, #edeff0);
}
.breadcrumb-caret {
  font-size: 0.625rem;
  vertical-align: middle;
}
.fd-breadcrumb { padding: 0; margin: 0; }
.breadcrumb-inner .fd-breadcrumb__link { font-size: 0.8125rem; }
.breadcrumb-inner .fd-breadcrumb__link--current { color: var(--sapTextColor, #32363a); cursor: default; }

.mission-hero {
  background: var(--sapShellColor, #354a5f);
  color: var(--sapShell_TextColor, #fff);
  padding: 2.5rem 2rem;
}
.hero-inner {
  max-width: 1280px;
  margin: 0 auto;
}
.hero-top {
  display: flex;
  align-items: flex-start;
  gap: 2rem;
}
.hero-text {
  flex: 1;
  min-width: 0;
}
.hero-icon {
  flex-shrink: 0;
  width: 80px;
  height: 80px;
  display: flex;
  align-items: center;
  justify-content: center;
  opacity: 0.9;
}
.hero-icon :deep(svg) {
  width: 100%;
  height: 100%;
  fill: currentColor;
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
.type-badge--mission {
  background: rgba(4, 108, 122, 0.2);
  color: #7dd3de;
  border: 1px solid rgba(125, 211, 222, 0.3);
}
.type-badge--group {
  background: rgba(108, 50, 169, 0.15);
  color: var(--sapAccentColor8, #6c32a9);
  border: 1px solid rgba(108, 50, 169, 0.25);
}
.mission-hero h1 {
  font-size: 2rem;
  font-weight: 700;
  margin: 0 0 0.75rem;
  color: inherit;
  line-height: 1.25;
}
.mission-description {
  font-size: 1rem;
  line-height: 1.7;
  opacity: 0.9;
  max-width: 700px;
  margin: 0 0 1rem;
}
.mission-meta {
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
.mission-tags {
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

.mission-body {
  max-width: 1280px;
  margin: 0 auto;
  padding: 1.5rem 2rem 3rem;
}

.groups-section h2 {
  font-size: 1.25rem;
  font-weight: 700;
  margin: 1.5rem 0 1rem;
  color: var(--sapTextColor, #32363a);
}

.group-card {
  background: var(--sapBaseColor, #fff);
  border-radius: 0.75rem;
  padding: 1.5rem;
  margin-bottom: 1rem;
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.06);
}
.group-card-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  cursor: pointer;
  user-select: none;
}
.group-header-left {
  flex: 1;
  min-width: 0;
}
.group-chevron {
  font-size: 0.875rem;
  color: var(--sapNeutralTextColor, #6a6d70);
  transition: transform 0.2s;
  flex-shrink: 0;
  margin-top: 0.25rem;
  padding: 0.25rem;
}
.group-chevron.expanded {
  transform: rotate(180deg);
}
.group-card-header h3 {
  font-size: 1.125rem;
  font-weight: 700;
  margin: 0.25rem 0 0.25rem;
  color: var(--sapTextColor, #32363a);
}
.group-card-header h3 a {
  color: inherit;
  text-decoration: none;
}
.group-card-header h3 a:hover {
  color: var(--sapBrandColor, #0070f2);
}
.group-meta {
  font-size: 0.8125rem;
  color: var(--sapNeutralTextColor, #6a6d70);
}
.group-description {
  font-size: 0.8125rem;
  line-height: 1.6;
  color: var(--sapContent_LabelColor, #556b82);
  margin: 0.5rem 0 0;
}

.group-card-body {
  margin-top: 1rem;
}

.group-tutorials {
  list-style: none;
  padding: 0;
  margin: 0;
}
.tutorial-item {
  display: flex;
  align-items: flex-start;
  gap: 0.75rem;
  padding: 0.75rem 0;
  border-bottom: 1px solid var(--sapGroup_ContentBorderColor, #e5e5e5);
}
.tutorial-item:last-child {
  border-bottom: none;
}
.tutorial-number {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 1.75rem;
  height: 1.75rem;
  border-radius: 50%;
  border: 2px solid var(--sapNeutralBorderColor, #bcc3ca);
  color: var(--sapNeutralTextColor, #6a6d70);
  font-weight: 600;
  font-size: 0.75rem;
  flex-shrink: 0;
  margin-top: 0.1rem;
}
.tutorial-number.completed {
  background: var(--sapPositiveColor, #107e3e);
  border-color: var(--sapPositiveColor, #107e3e);
  color: #fff;
}
.tutorial-info { flex: 1; min-width: 0; }
.tutorial-link {
  color: var(--sapLinkColor, #0064d9);
  text-decoration: none;
  font-size: 0.9375rem;
  font-weight: 600;
  line-height: 1.4;
}
.tutorial-link:hover { text-decoration: underline; }
.tutorial-meta-row {
  display: flex;
  align-items: center;
  gap: 0.375rem;
  font-size: 0.75rem;
  color: var(--sapNeutralTextColor, #6a6d70);
  margin-top: 0.15rem;
}
.tutorial-meta-row .meta-sep { color: var(--sapNeutralBorderColor, #d9d9d9); }

.group-start-link {
  display: inline-block;
  margin-top: 0.75rem;
  color: var(--sapBrandColor, #0070f2);
  font-size: 0.875rem;
  font-weight: 600;
  text-decoration: none;
}
.group-start-link:hover { text-decoration: underline; }

@media (max-width: 768px) {
  .mission-hero h1 { font-size: 1.5rem; }
  .mission-body { padding: 1rem; }
  .group-card { padding: 1rem; }
  .hero-top { flex-direction: column; }
  .hero-icon { width: 60px; height: 60px; }
}
</style>
