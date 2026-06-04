<!--
  hugo-apps/src/shared/cards/TutorialCard.vue
  Tutorial card variant. Shared between the / navigator and /browse/.
  Markup migrated from TutorialNavigator.vue:870-916 (verbatim, no
  CSS drift permitted). Per-user state (progress, completed badge)
  is delegated to ProgressOverlay which gates itself on hydration.
-->
<script setup lang="ts">
import type { CardItem } from '@shared/types'
import type { ProgressPayload } from '../../navigator/cardProgress'
import { cardProgress } from '../../navigator/cardProgress'
import { requiresLicense } from '../license'
import LicenseIcon from '../LicenseIcon.vue'
import ProgressOverlay from './ProgressOverlay.vue'
import { capitalizeLevel, formatTime } from './format'
import './card.css'

defineProps<{
  item: CardItem
  progress: ProgressPayload
}>()

const TYPE_LABEL = 'TUTORIAL'
</script>

<template>
  <a
    :href="item.href"
    class="nav-card"
    data-vt-card="navigator"
    :class="{
      'nav-card--new': item.isNew,
      'nav-card--has-progress': !!cardProgress(item, progress),
    }"
  >
    <ProgressOverlay :item="item" :progress="progress" />
    <span v-if="item.isNew" class="nav-card__new-badge" aria-label="New tutorial">NEW</span>
    <LicenseIcon v-if="requiresLicense(item)" class="nav-card__license" />
    <div class="nav-card__type nav-card__type--tutorial">{{ TYPE_LABEL }}</div>

    <h3 class="nav-card__title">{{ item.title }}</h3>

    <p class="nav-card__desc">{{ item.description }}</p>

    <div class="nav-card__meta">
      <span class="nav-card__meta-item">
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M2 13V3h4l2 2h6v8H2z"/></svg>
        {{ capitalizeLevel(item.level) }}
      </span>
      <span class="nav-card__meta-sep">&middot;</span>
      <span class="nav-card__meta-item">
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><circle cx="8" cy="8" r="6.5"/><path d="M8 4.5V8l2.5 1.5"/></svg>
        {{ formatTime(item.time) }}
      </span>
    </div>

    <div class="nav-card__tag">
      <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M2 3h5l7 7-5 5-7-7V3zm3 2a1 1 0 100 2 1 1 0 000-2z"/></svg>
      {{ item.primaryTag }}
    </div>
  </a>
</template>
