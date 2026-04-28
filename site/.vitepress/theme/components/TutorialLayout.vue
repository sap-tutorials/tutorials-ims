<script setup lang="ts">
import { ref, computed, provide, onMounted } from 'vue'
import { useData } from 'vitepress'
import { useApi } from '../composables/useApi'
import ProgressBar from './ProgressBar.vue'
import PointsBadge from './PointsBadge.vue'
import TutorialNavigatorDropdown from './TutorialNavigatorDropdown.vue'
import FeedbackShareBar from './FeedbackShareBar.vue'

const { frontmatter } = useData()
const { get } = useApi()

const completedSteps = ref<Set<number>>(new Set())
const points = ref(0)
const badges = ref<Array<{ name: string; icon: string }>>([])
const allExpanded = ref<boolean | null>(null)
const navDropdownOpen = ref(false)
const navToggleBtn = ref<HTMLElement | null>(null)

function toggleNavDropdown() {
  navDropdownOpen.value = !navDropdownOpen.value
}
function closeNavDropdown() { navDropdownOpen.value = false }

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
const stepValidationMap = computed<Record<number, any[]>>(() => {
  const steps = frontmatter.value.steps ?? []
  const map: Record<number, any[]> = {}
  for (const step of steps) {
    if (step.validation && step.validation.length > 0) {
      map[step.number] = step.validation
    }
  }
  return map
})
const authorAvatar = computed(() => {
  const profile = frontmatter.value.authorProfile
  if (profile && profile.startsWith('https://github.com/')) {
    const username = profile.replace('https://github.com/', '')
    return `https://github.com/${username}.png?size=48`
  }
  return ''
})
const lastUpdatedFormatted = computed(() => {
  const d = frontmatter.value.lastUpdated
  if (!d) return ''
  return new Date(d).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })
})
const contributors = computed<Array<{ login: string; name: string; avatarUrl: string }>>(() => frontmatter.value.contributors ?? [])
const visibleContributors = computed(() => contributors.value.slice(0, 8))
const extraContributorCount = computed(() => Math.max(0, contributors.value.length - 8))

function isStepCompleted(n: number) {
  return completedSteps.value.has(n)
}

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
provide('stepValidationMap', stepValidationMap)

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
  <div class="tutorial-wrapper">
    <!-- Breadcrumb bar -->
    <nav class="tutorial-breadcrumb-bar">
      <div class="breadcrumb-inner breadcrumb-inner--with-dropdown">
        <ul class="fd-breadcrumb">
          <li class="fd-breadcrumb__item breadcrumb-nav-item">
            <a class="fd-breadcrumb__link" href="/">Tutorial Navigator</a>
            <button ref="navToggleBtn" class="breadcrumb-dropdown-trigger" @click="toggleNavDropdown" aria-label="Toggle tutorial navigation">
              <span class="breadcrumb-caret">&#9662;</span>
            </button>
          </li>
          <li v-if="frontmatter.missionSlug" class="fd-breadcrumb__item">
            <a class="fd-breadcrumb__link" :href="`/tutorials/mission-${frontmatter.missionSlug}`">{{ frontmatter.missionTitle }}</a>
          </li>
          <li v-if="frontmatter.groupSlug" class="fd-breadcrumb__item">
            <a class="fd-breadcrumb__link" :href="`/tutorials/group-${frontmatter.groupSlug}`">{{ frontmatter.groupTitle }}</a>
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
    <FeedbackShareBar :title="frontmatter.title" :slug="frontmatter.slug" :primary-tag="frontmatter.primaryTag" page-type="tutorial">
      <template #nav-left>
        <a v-if="frontmatter.prev" :href="`/tutorials/${frontmatter.prev}`" class="nav-pill">
          &larr; Previous
        </a>
      </template>
      <template #nav-right>
        <a v-if="frontmatter.next" :href="`/tutorials/${frontmatter.next}`" class="nav-pill nav-pill--primary">
          Next &rarr;
        </a>
      </template>
    </FeedbackShareBar>

    <!-- Main layout: content + right sidebar -->
    <div class="tutorial-page">
      <main class="tutorial-main">
        <!-- Title -->
        <h1 class="tutorial-title">{{ frontmatter.title }}</h1>

        <!-- Meta row + Tags inline -->
        <div class="tutorial-meta">
          <span class="meta-item">
            <span class="meta-icon">&#127891;</span>
            <span class="meta-level">{{ frontmatter.level }}</span>
          </span>
          <span class="meta-item">
            <span class="meta-icon">&#9201;</span>
            <span>{{ frontmatter.time }} min.</span>
          </span>
          <span v-if="displayTags.length" class="meta-tags">
            <span class="meta-icon">&#127991;</span>
            <span v-for="tag in displayTags" :key="tag" class="tutorial-tag">{{ tag }}</span>
          </span>
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
          <div class="author-info">
            <strong>{{ frontmatter.author }}</strong>
            <span v-if="lastUpdatedFormatted" class="last-updated">Last updated: {{ lastUpdatedFormatted }}</span>
          </div>
        </div>

        <!-- Contributors -->
        <div v-if="visibleContributors.length" class="tutorial-contributors">
          <span class="contributors-label">Contributors</span>
          <div class="contributors-avatars">
            <a
              v-for="c in visibleContributors"
              :key="c.login"
              :href="`https://github.com/${c.login}`"
              :title="c.name || c.login"
              class="contributor-avatar-link"
              target="_blank"
              rel="noopener"
            >
              <img :src="c.avatarUrl + '&s=28'" :alt="c.login" class="contributor-avatar" />
            </a>
            <span v-if="extraContributorCount > 0" class="contributor-extra">+{{ extraContributorCount }}</span>
          </div>
        </div>

        <!-- Prerequisites -->
        <div v-if="prerequisites.length" class="prerequisites-box">
          <h4>Prerequisites</h4>
          <ul>
            <li v-for="(item, i) in prerequisites" :key="i" v-html="mdInline(item)"></li>
          </ul>
        </div>

        <!-- Progress -->
        <ClientOnly>
        <ProgressBar :completed="completedCount" :total="stepCount" label="Tutorial Progress" />
        <PointsBadge :points="points" :badges="badges" />
        </ClientOnly>

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
        <div class="tutorial-nav-bottom">
          <a v-if="frontmatter.prev" :href="`/tutorials/${frontmatter.prev}`" class="nav-pill">
            &larr; Previous
          </a>
          <div class="nav-spacer"></div>
          <a v-if="frontmatter.next" :href="`/tutorials/${frontmatter.next}`" class="nav-pill nav-pill--primary">
            Next &rarr;
          </a>
        </div>
      </main>

      <!-- Right sidebar: Step TOC -->
      <aside v-if="stepsList.length" class="step-toc-sidebar">
        <div class="step-toc">
          <a
            v-for="step in stepsList"
            :key="step.number"
            class="step-toc-item"
            href="#"
            @click.prevent="scrollToStep(step.number)"
          >
            <span class="step-toc-circle" :class="{ completed: isStepCompleted(step.number) }">
              <span v-if="isStepCompleted(step.number)">&#10003;</span>
              <span v-else>{{ step.number }}</span>
            </span>
            <span class="step-toc-text">
              <span class="step-toc-label">Step {{ step.number }}:</span>
              {{ step.title }}
            </span>
          </a>
          <a href="#" class="step-toc-back" @click.prevent="scrollToStep(1)">Back to Top</a>
        </div>
      </aside>
    </div>
  </div>
</template>

<style scoped>
/* Full-width wrapper */
.tutorial-wrapper {
  background: var(--sapBackgroundColor, #f5f6f7);
  min-height: 100vh;
}

/* Breadcrumb bar */
.tutorial-breadcrumb-bar {
  background: var(--sapBaseColor, #fff);
  border-bottom: 1px solid var(--sapNeutralBorderColor, #d9d9d9);
  padding: 0.75rem 0;
}
.breadcrumb-inner {
  max-width: 1280px;
  margin: 0 auto;
  padding: 0 2rem;
  font-size: 0.8125rem;
  line-height: 1.5;
  color: var(--sapNeutralTextColor, #6a6d70);
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
.fd-breadcrumb {
  padding: 0;
  margin: 0;
}
.breadcrumb-inner .fd-breadcrumb__link {
  font-size: 0.8125rem;
}
.breadcrumb-inner .fd-breadcrumb__link--current {
  color: var(--sapTextColor, #32363a);
  cursor: default;
}

/* Nav pill overrides for action bar slot content */
:deep(.action-bar-inner) .nav-pill {
  border-color: var(--sapShell_TextColor, #fff);
  color: var(--sapShell_TextColor, #fff);
}
:deep(.action-bar-inner) .nav-pill:hover {
  background: rgba(255,255,255,0.15);
  color: var(--sapShell_TextColor, #fff);
}
:deep(.action-bar-inner) .nav-pill--primary {
  background: var(--sapContent_ContrastTextColor, #fff);
  color: var(--sapShellColor, #354a5f);
  border-color: var(--sapContent_ContrastTextColor, #fff);
}
:deep(.action-bar-inner) .nav-pill--primary:hover {
  background: rgba(255,255,255,0.9);
  color: var(--sapShellColor, #354a5f);
}

/* Main layout */
.tutorial-page {
  display: flex;
  max-width: 1280px;
  margin: 0 auto;
  padding: 1.5rem 2rem;
  gap: 2rem;
}
.tutorial-main {
  flex: 1;
  min-width: 0;
  background: var(--sapBaseColor, #fff);
  border-radius: 0.5rem;
  padding: 2rem;
}

/* Right sidebar */
.step-toc-sidebar {
  width: 320px;
  flex-shrink: 0;
  position: sticky;
  top: 1rem;
  align-self: flex-start;
}
.step-toc {
  background: var(--sapBaseColor, #fff);
  border: 1px solid var(--sapNeutralBorderColor, #d9d9d9);
  border-radius: 0.5rem;
  padding: 1rem;
}
.step-toc-item {
  display: flex;
  align-items: flex-start;
  gap: 0.75rem;
  padding: 0.4rem 0;
  text-decoration: none;
  color: var(--sapLinkColor, #0064d9);
  font-size: 0.8125rem;
  line-height: 1.4;
}
.step-toc-item:hover { text-decoration: underline; }
.step-toc-circle {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 1.625rem;
  height: 1.625rem;
  border-radius: 50%;
  border: 2px solid var(--sapNeutralBorderColor, #bcc3ca);
  color: var(--sapNeutralTextColor, #6a6d70);
  font-weight: 600;
  font-size: 0.6875rem;
  flex-shrink: 0;
  transition: all 0.2s;
}
.step-toc-circle.completed {
  background: var(--sapPositiveColor, #107e3e);
  border-color: var(--sapPositiveColor, #107e3e);
  color: #fff;
}
.step-toc-label {
  font-weight: 600;
}
.step-toc-back {
  display: block;
  text-align: right;
  margin-top: 0.75rem;
  font-size: 0.8125rem;
  font-weight: 600;
  color: var(--sapTextColor, #32363a);
  text-decoration: none;
}
.step-toc-back:hover { text-decoration: underline; }

/* Nav pills */
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

/* Meta + Tags (inline) */
.tutorial-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 0.75rem 1.5rem;
  align-items: center;
  margin-bottom: 1rem;
  font-size: 0.875rem;
  color: var(--sapTextColor, #32363a);
}
.meta-item {
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
}
.meta-icon { font-size: 1rem; }
.meta-level { text-transform: capitalize; }
.meta-tags {
  display: inline-flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 0.35rem;
}
.tutorial-tag {
  display: inline-block;
  padding: 0.125rem 0.5rem;
  border: 1px solid var(--sapBrandColor, #0070f2);
  border-radius: 1rem;
  color: var(--sapBrandColor, #0070f2);
  font-size: 0.6875rem;
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
.you-will-learn { margin-bottom: 1.5rem; }
.you-will-learn h3 {
  font-size: 1rem;
  font-weight: 600;
  margin-bottom: 0.5rem;
  color: var(--sapTextColor, #32363a);
}
.you-will-learn ul { list-style: none; padding: 0; margin: 0; }
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
.you-will-learn :deep(a) { color: var(--sapLinkColor, #0064d9); }

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
.author-info {
  display: flex;
  flex-direction: column;
  gap: 0.1rem;
}
.last-updated {
  font-size: 0.75rem;
  color: var(--sapNeutralTextColor, #6a6d70);
  font-weight: 400;
}

/* Contributors */
.tutorial-contributors {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  margin-bottom: 1.5rem;
  font-size: 0.8125rem;
}
.contributors-label {
  color: var(--sapNeutralTextColor, #6a6d70);
  font-weight: 600;
  white-space: nowrap;
}
.contributors-avatars {
  display: flex;
  align-items: center;
}
.contributor-avatar-link {
  display: inline-block;
  margin-left: -0.25rem;
  transition: transform 0.15s;
}
.contributor-avatar-link:first-child {
  margin-left: 0;
}
.contributor-avatar-link:hover {
  transform: scale(1.15);
  z-index: 1;
}
.contributor-avatar {
  width: 28px;
  height: 28px;
  border-radius: 50%;
  border: 2px solid var(--sapBaseColor, #fff);
}
.contributor-extra {
  margin-left: 0.25rem;
  font-size: 0.75rem;
  font-weight: 600;
  color: var(--sapNeutralTextColor, #6a6d70);
}

/* Prerequisites */
.prerequisites-box {
  background: var(--sapInformationBackground, #e8f4fd);
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
.prerequisites-box ul { margin: 0; padding-left: 1.25rem; }
.prerequisites-box li { margin-bottom: 0.35rem; line-height: 1.5; }
.prerequisites-box :deep(a) { color: var(--sapLinkColor, #0064d9); }

/* Step controls */
.step-controls {
  display: flex;
  justify-content: flex-end;
  gap: 1.5rem;
  margin: 1.5rem 0 0.75rem;
  font-size: 0.875rem;
}
.step-controls a {
  color: var(--sapLinkColor, #0064d9);
  text-decoration: none;
  font-weight: 600;
}
.step-controls a:hover { text-decoration: underline; }

/* Bottom nav */
.tutorial-nav-bottom {
  display: flex;
  align-items: center;
  margin-top: 2rem;
}
.nav-spacer { flex: 1; }

@media (max-width: 960px) {
  .step-toc-sidebar { display: none; }
  .tutorial-page { padding: 1rem; }
  .tutorial-main { padding: 1.5rem; }
}
@media (max-width: 768px) {
  .tutorial-title { font-size: 1.5rem; }
  .action-bar-inner { flex-wrap: wrap; gap: 0.5rem; }
}
</style>
