<script setup lang="ts">
import { ref, computed, reactive, onMounted, watch } from 'vue'
import { useRealtimeProgress } from './useRealtimeProgress'
import { useConfetti } from '../composables/useConfetti'

// ── Configuration (easily customizable per event) ──────────────────
const MISSION_ID = 24609

// ── Theme ─────────────────────────────────────────────────────────
const isDark = ref(document.documentElement.dataset.theme === 'dark')
const activeTheme = ref<'joule' | 'sapphire' | null>(null)

const eventName = computed(() => {
  if (activeTheme.value === 'sapphire') return 'SAP Sapphire 2026'
  return 'SAP TechEd'
})

// ── Interfaces ─────────────────────────────────────────────────────
interface AppSpaceItem {
  imsId: number
  title: string
  type: 'TUTORIAL' | 'CHECKPOINT' | 'PRIZE'
  status: string
  progress: number
  experience: string
  timeToComplete: number
  url: string
  description: string
  recordId?: number
}

interface AppSpaceTrack {
  id: number
  title: string
  description: string
  items: AppSpaceItem[]
}

interface AppSpaceData {
  eventId: number
  type: string
  paths: AppSpaceTrack[]
}

// ── State ──────────────────────────────────────────────────────────
const tracks = ref<AppSpaceTrack[]>([])
const selectedTrack = ref<AppSpaceTrack | null>(null)
const loading = ref(true)
const isLoggedIn = ref(false)
const demoState = ref(0) // 0=default, 1=partial, 2=track complete, 3=reset

// ── Real-time celebration ─────────────────────────────────────────
const { fireConfetti, particles, active: confettiActive } = useConfetti()
const currentUser = ref<{ displayName: string } | null>(null)

// Toast notification state
const toastMessage = ref('')
const toastVisible = ref(false)
let toastTimer: ReturnType<typeof setTimeout> | null = null

function showToast(message: string) {
  toastMessage.value = message
  toastVisible.value = true
  if (toastTimer) clearTimeout(toastTimer)
  toastTimer = setTimeout(() => { toastVisible.value = false }, 3000)
}

// ── Data loading ───────────────────────────────────────────────────
async function loadData(): Promise<AppSpaceData | null> {
  try {
    const res = await fetch(`/api/getEventProgress(missionLegacyId=${MISSION_ID})`)
    if (res.ok) {
      isLoggedIn.value = true
      return await res.json()
    }
  } catch {}
  try {
    const res = await fetch('/app-space-data.json')
    if (res.ok) return await res.json()
  } catch {}
  return null
}

onMounted(async () => {
  const params = new URLSearchParams(window.location.search)
  const theme = params.get('theme')
  if (theme === 'joule' || theme === 'sapphire') {
    activeTheme.value = theme
  }

  const data = await loadData()
  if (data) {
    tracks.value = data.paths
  }
  loading.value = false
})

// ── Real-time progress (requires login + event context) ───────────
const eventIdForWs = ref<string>('')

watch([() => tracks.value, isLoggedIn], ([t, loggedIn]) => {
  if (!loggedIn || !t.length) return
  const params = new URLSearchParams(window.location.search)
  const eid = params.get('eventId') || ''
  if (eid) eventIdForWs.value = eid
}, { immediate: true })

const realtimeActive = computed(() => isLoggedIn.value && eventIdForWs.value !== '')

// Dev: VITE_CAP_URL=http://localhost:4004, Prod: empty (same-origin via AppRouter)
const wsBaseUrl = import.meta.env.VITE_CAP_URL || ''

let rtCleanup: (() => void) | null = null
watch(realtimeActive, (active) => {
  if (active && !rtCleanup) {
    const { lastCompletion, connected } = useRealtimeProgress(wsBaseUrl, eventIdForWs.value)

    let debounceTimer: ReturnType<typeof setTimeout> | null = null
    let debounceQueue: string[] = []

    watch(lastCompletion, (completion) => {
      if (!completion) return

      debounceQueue.push(completion.userName)

      if (debounceTimer) clearTimeout(debounceTimer)
      debounceTimer = setTimeout(() => {
        if (debounceQueue.length > 1) {
          showToast(`${debounceQueue.length} people just completed tutorials!`)
          fireConfetti('large')
        } else {
          const isMe = completion.userName === currentUser.value?.displayName
          fireConfetti(isMe ? 'large' : 'normal')
          showToast(`${completion.userName} completed "${completion.tutorialTitle}"!`)
          if (isMe) {
            document.querySelector('.app-space-badge')?.classList.add('badge-glow')
            setTimeout(() => {
              document.querySelector('.app-space-badge')?.classList.remove('badge-glow')
            }, 2000)
          }
        }
        debounceQueue = []
      }, 500)
    })
  }
}, { immediate: true })

// ── Helpers ────────────────────────────────────────────────────────
function formatTime(seconds: number): string {
  if (seconds <= 0) return ''
  const mins = Math.round(seconds / 60)
  if (mins < 60) return `${mins} min`
  const hrs = Math.floor(mins / 60)
  const rem = mins % 60
  return rem > 0 ? `${hrs} hr ${rem} min` : `${hrs} hr`
}

function tutorialItems(track: AppSpaceTrack): AppSpaceItem[] {
  return track.items.filter(i => i.type === 'TUTORIAL')
}

function completedCount(track: AppSpaceTrack): number {
  return tutorialItems(track).filter(i => i.status === 'COMPLETED').length
}

function trackTotalTime(track: AppSpaceTrack): number {
  return tutorialItems(track).reduce((sum, i) => sum + i.timeToComplete, 0)
}

function isTrackComplete(track: AppSpaceTrack): boolean {
  const tuts = tutorialItems(track)
  return tuts.length > 0 && tuts.every(i => i.status === 'COMPLETED')
}

function progressPercent(track: AppSpaceTrack): number {
  const tuts = tutorialItems(track)
  if (tuts.length === 0) return 0
  return Math.round((completedCount(track) / tuts.length) * 100)
}

function isItemUnlocked(track: AppSpaceTrack, index: number): boolean {
  const item = track.items[index]
  if (item.type === 'TUTORIAL') {
    if (index === 0) return true
    const prev = track.items[index - 1]
    return prev.status === 'COMPLETED'
  }
  if (item.type === 'CHECKPOINT') {
    const prevTuts = track.items.slice(0, index).filter(i => i.type === 'TUTORIAL')
    return prevTuts.every(i => i.status === 'COMPLETED')
  }
  if (item.type === 'PRIZE') {
    const allTuts = track.items.filter(i => i.type === 'TUTORIAL')
    return allTuts.every(i => i.status === 'COMPLETED')
  }
  return false
}

function itemStatusClass(track: AppSpaceTrack, index: number): string {
  const item = track.items[index]
  if (item.status === 'COMPLETED') return 'step--completed'
  if (item.status === 'EARNED') return 'step--earned'
  if (item.status === 'IN_PROGRESS') return 'step--in-progress'
  if (isItemUnlocked(track, index)) return 'step--available'
  return 'step--locked'
}

function selectTrack(track: AppSpaceTrack) {
  selectedTrack.value = track
}

function goBack() {
  selectedTrack.value = null
}

function handleItemClick(track: AppSpaceTrack, index: number, item: AppSpaceItem) {
  if (item.type === 'TUTORIAL' && isItemUnlocked(track, index) && item.url) {
    window.open(item.url, '_blank')
  }
}

function qrCodeUrl(item: AppSpaceItem): string {
  return `/api/qrcode?imsId=${item.imsId}&type=${item.type}&eventId=38&recordId=${item.recordId ?? 0}`
}

// ── Computed ───────────────────────────────────────────────────────
const totalTutorials = computed(() =>
  tracks.value.reduce((sum, t) => sum + tutorialItems(t).length, 0)
)

const totalCompleted = computed(() =>
  tracks.value.reduce((sum, t) => sum + completedCount(t), 0)
)

const completedTracks = computed(() =>
  tracks.value.filter(isTrackComplete).length
)

// ── Demo mode ──────────────────────────────────────────────────────
function cycleDemo() {
  demoState.value = (demoState.value + 1) % 4

  for (const track of tracks.value) {
    for (const item of track.items) {
      item.status = ''
      item.progress = 0
    }
  }

  if (demoState.value === 1) {
    // Partial progress: complete some items in first 3 tracks
    for (let t = 0; t < Math.min(3, tracks.value.length); t++) {
      const tuts = tutorialItems(tracks.value[t])
      const completeCount = Math.min(Math.floor(tuts.length / 2) + 1, tuts.length)
      for (let i = 0; i < completeCount; i++) {
        tuts[i].status = 'COMPLETED'
        tuts[i].progress = 100
      }
      if (completeCount < tuts.length) {
        tuts[completeCount].status = 'IN_PROGRESS'
        tuts[completeCount].progress = 40
      }
    }
  } else if (demoState.value === 2) {
    // Full track complete: complete all items in first track + prize
    const track = tracks.value[0]
    for (const item of track.items) {
      if (item.type === 'TUTORIAL') {
        item.status = 'COMPLETED'
        item.progress = 100
      } else if (item.type === 'PRIZE') {
        item.status = 'EARNED'
      }
    }
    // Partial in second track
    const tuts2 = tutorialItems(tracks.value[1])
    if (tuts2.length > 0) {
      tuts2[0].status = 'COMPLETED'
      tuts2[0].progress = 100
    }
  }
  // demoState 3 = reset (already cleared above)
  if (demoState.value === 3) demoState.value = 0
}

const demoLabel = computed(() => {
  if (demoState.value === 0) return 'Demo: Default'
  if (demoState.value === 1) return 'Demo: In Progress'
  if (demoState.value === 2) return 'Demo: Track Complete'
  return 'Demo: Default'
})
</script>

<template>
  <div class="app-space"
    :data-theme="activeTheme ?? undefined"
    :data-dark="isDark ? '' : undefined"
  >
    <!-- ── Hero Banner ────────────────────────────────────── -->
    <section class="hero">
      <div class="hero-inner">
        <div class="hero-text">
          <h1 class="hero-title">{{ eventName }}</h1>
          <p class="hero-subtitle">Developer Garage &mdash; App Space</p>
          <p class="hero-desc">
            Pick a track, complete the tutorials, and earn prizes along the way.
          </p>
        </div>
        <div class="hero-stats" v-if="tracks.length > 0">
          <div class="stat-card">
            <span class="stat-number">{{ tracks.length }}</span>
            <span class="stat-label">Tracks</span>
          </div>
          <div class="stat-card">
            <span class="stat-number">{{ totalTutorials }}</span>
            <span class="stat-label">Tutorials</span>
          </div>
          <div class="stat-card">
            <span class="stat-number">{{ totalCompleted }}</span>
            <span class="stat-label">Completed</span>
          </div>
        </div>
      </div>
      <div class="hero-instructions">
        <div class="instruction-step" v-for="(step, i) in [
          { icon: '1', text: 'Log in with your SAP ID' },
          { icon: '2', text: 'Pick a track below' },
          { icon: '3', text: 'Complete each tutorial' },
          { icon: '4', text: 'Earn your prize!' }
        ]" :key="i">
          <span class="instruction-icon">{{ step.icon }}</span>
          <span class="instruction-text">{{ step.text }}</span>
        </div>
      </div>
      <button class="demo-toggle fd-button fd-button--transparent" @click="cycleDemo">
        {{ demoLabel }}
      </button>
    </section>

    <!-- ── Loading ────────────────────────────────────────── -->
    <div class="content-area" v-if="loading">
      <div class="loading-grid">
        <div class="skeleton-card" v-for="i in 8" :key="i">
          <div class="skeleton-line wide"></div>
          <div class="skeleton-line medium"></div>
          <div class="skeleton-line short"></div>
        </div>
      </div>
    </div>

    <!-- ── Track Overview Grid ────────────────────────────── -->
    <div class="content-area" v-else-if="!selectedTrack">
      <div class="section-header">
        <h2 class="section-title">Choose Your Track</h2>
        <span class="track-count">{{ completedTracks }} of {{ tracks.length }} tracks completed</span>
      </div>
      <div class="track-grid">
        <button
          v-for="track in tracks"
          :key="track.id"
          class="track-card"
          :class="{ 'track-card--complete': isTrackComplete(track) }"
          @click="selectTrack(track)"
        >
          <div class="track-card__header">
            <div class="track-card__progress-ring">
              <svg viewBox="0 0 36 36" class="progress-ring-svg">
                <path class="progress-ring-bg"
                  d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831"
                  fill="none" stroke-width="3" />
                <path class="progress-ring-fill"
                  d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831"
                  fill="none" stroke-width="3"
                  :stroke-dasharray="`${progressPercent(track)}, 100`" />
              </svg>
              <span class="progress-ring-text">{{ progressPercent(track) }}%</span>
            </div>
            <div v-if="isTrackComplete(track)" class="track-card__badge">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
                <path d="M9 12l2 2 4-4" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
                <circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="2"/>
              </svg>
            </div>
          </div>
          <h3 class="track-card__title">{{ track.title }}</h3>
          <p class="track-card__desc">{{ track.description }}</p>
          <div class="track-card__meta">
            <span class="track-card__count">{{ tutorialItems(track).length }} tutorials</span>
            <span class="track-card__time">{{ formatTime(trackTotalTime(track)) }}</span>
          </div>
          <div class="track-card__progress-bar">
            <div class="track-card__progress-fill" :style="{ width: progressPercent(track) + '%' }"></div>
          </div>
        </button>
      </div>
    </div>

    <!-- ── Track Detail View (Step Timeline) ──────────────── -->
    <div class="content-area" v-else>
      <div class="detail-header">
        <button class="fd-button fd-button--transparent back-button" @click="goBack">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
            <path d="M19 12H5M5 12l7 7M5 12l7-7" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
          All Tracks
        </button>
        <div class="detail-title-row">
          <h2 class="detail-title">{{ selectedTrack.title }}</h2>
          <span class="detail-progress">{{ completedCount(selectedTrack) }} / {{ tutorialItems(selectedTrack).length }} completed</span>
        </div>
        <p class="detail-desc">{{ selectedTrack.description }}</p>
      </div>

      <div class="timeline">
        <div
          v-for="(item, index) in selectedTrack.items"
          :key="item.imsId"
          class="timeline-item"
          :class="[
            itemStatusClass(selectedTrack, index),
            `timeline-item--${item.type.toLowerCase()}`
          ]"
        >
          <!-- Connecting line -->
          <div class="timeline-line" v-if="index < selectedTrack.items.length - 1"></div>

          <!-- Step bubble -->
          <div
            class="timeline-bubble"
            @click="handleItemClick(selectedTrack, index, item)"
            :class="{ clickable: item.type === 'TUTORIAL' && isItemUnlocked(selectedTrack, index) }"
          >
            <!-- Locked icon -->
            <svg v-if="!isItemUnlocked(selectedTrack, index) && item.status !== 'COMPLETED' && item.status !== 'EARNED'"
              width="18" height="18" viewBox="0 0 24 24" fill="none">
              <rect x="3" y="11" width="18" height="11" rx="2" stroke="currentColor" stroke-width="2"/>
              <path d="M7 11V7a5 5 0 0 1 10 0v4" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
            </svg>
            <!-- Completed check -->
            <svg v-else-if="item.status === 'COMPLETED'"
              width="18" height="18" viewBox="0 0 24 24" fill="none">
              <path d="M5 13l4 4L19 7" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
            </svg>
            <!-- Prize/trophy icon -->
            <svg v-else-if="item.type === 'PRIZE' || item.type === 'CHECKPOINT'"
              width="18" height="18" viewBox="0 0 24 24" fill="none">
              <path d="M8 21h8M12 17v4M7 4h10M7 4V3h10v1M7 4H5a2 2 0 0 0 0 4h2M17 4h2a2 2 0 0 1 0 4h-2M7 8c0 3 2 5 5 5s5-2 5-5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
            </svg>
            <!-- In progress percentage -->
            <span v-else-if="item.status === 'IN_PROGRESS'" class="bubble-progress">{{ item.progress }}%</span>
            <!-- Available: step number -->
            <span v-else class="bubble-number">{{ index + 1 }}</span>
          </div>

          <!-- Step content -->
          <div class="timeline-content">
            <div class="timeline-content__header">
              <span class="item-type-label" :class="`item-type--${item.type.toLowerCase()}`">
                {{ item.type === 'TUTORIAL' ? 'Tutorial' : item.type === 'CHECKPOINT' ? 'Checkpoint' : 'Prize' }}
              </span>
              <span v-if="item.experience" class="item-experience">{{ item.experience }}</span>
              <span v-if="item.timeToComplete > 0" class="item-time">{{ formatTime(item.timeToComplete) }}</span>
            </div>
            <h4 class="timeline-content__title"
              :class="{ clickable: item.type === 'TUTORIAL' && isItemUnlocked(selectedTrack, index) }"
              @click="handleItemClick(selectedTrack, index, item)"
            >{{ item.title }}</h4>
            <p class="timeline-content__desc" v-if="item.description && item.type !== 'PRIZE'">{{ item.description }}</p>

            <!-- Prize QR code section -->
            <div v-if="item.type === 'PRIZE' && (item.status === 'EARNED' || isItemUnlocked(selectedTrack, index))" class="prize-section">
              <div class="prize-qr">
                <div class="qr-placeholder" v-if="item.status !== 'EARNED'">
                  <svg width="120" height="120" viewBox="0 0 120 120" fill="none">
                    <rect width="120" height="120" rx="8" fill="currentColor" opacity="0.06"/>
                    <rect x="15" y="15" width="35" height="35" rx="4" stroke="currentColor" opacity="0.3" stroke-width="2"/>
                    <rect x="70" y="15" width="35" height="35" rx="4" stroke="currentColor" opacity="0.3" stroke-width="2"/>
                    <rect x="15" y="70" width="35" height="35" rx="4" stroke="currentColor" opacity="0.3" stroke-width="2"/>
                    <rect x="22" y="22" width="21" height="21" rx="2" fill="currentColor" opacity="0.15"/>
                    <rect x="77" y="22" width="21" height="21" rx="2" fill="currentColor" opacity="0.15"/>
                    <rect x="22" y="77" width="21" height="21" rx="2" fill="currentColor" opacity="0.15"/>
                    <rect x="70" y="70" width="8" height="8" fill="currentColor" opacity="0.15"/>
                    <rect x="82" y="70" width="8" height="8" fill="currentColor" opacity="0.15"/>
                    <rect x="94" y="70" width="8" height="8" fill="currentColor" opacity="0.15"/>
                    <rect x="70" y="82" width="8" height="8" fill="currentColor" opacity="0.15"/>
                    <rect x="94" y="82" width="8" height="8" fill="currentColor" opacity="0.15"/>
                    <rect x="70" y="94" width="8" height="8" fill="currentColor" opacity="0.15"/>
                    <rect x="82" y="94" width="8" height="8" fill="currentColor" opacity="0.15"/>
                    <rect x="94" y="94" width="8" height="8" fill="currentColor" opacity="0.15"/>
                  </svg>
                </div>
                <img v-else :src="qrCodeUrl(item)" alt="Prize QR code" class="qr-image" width="150" height="150" />
                <p class="prize-message" v-if="item.status === 'EARNED'">
                  {{ item.description || 'Congratulations! You earned a prize. Scan this code then contact an App Space expert to claim it.' }}
                </p>
                <p class="prize-message prize-message--locked" v-else>
                  Complete all tutorials above to unlock this prize.
                </p>
              </div>
            </div>

            <!-- Locked prize message -->
            <div v-if="item.type === 'PRIZE' && !isItemUnlocked(selectedTrack, index) && item.status !== 'EARNED'" class="prize-locked">
              <p class="prize-locked__text">Complete all tutorials to unlock your prize.</p>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.app-space {
  font-family: var(--sapFontFamily, '72', '72full', Arial, Helvetica, sans-serif);
  color: var(--sapTextColor, #32363a);
  overflow-x: hidden;
  min-height: 100vh;
}

/* ── Hero ──────────────────────────────────────────────── */
.hero {
  background: var(--sapShellColor, #354a5f);
  color: var(--sapShell_TextColor, #fff);
  padding: 2.5rem 2rem 1.5rem;
  position: relative;
}

.hero-inner {
  max-width: 1200px;
  margin: 0 auto;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 2rem;
}

.hero-title {
  font-size: 2rem;
  font-weight: 700;
  margin: 0 0 0.25rem;
  letter-spacing: -0.02em;
}

.hero-subtitle {
  font-size: 1.125rem;
  opacity: 0.85;
  margin: 0 0 0.5rem;
  font-weight: 400;
}

.hero-desc {
  font-size: 0.875rem;
  opacity: 0.7;
  margin: 0;
}

.hero-stats {
  display: flex;
  gap: 1rem;
}

.stat-card {
  background: rgba(255, 255, 255, 0.12);
  border: 1px solid rgba(255, 255, 255, 0.18);
  border-radius: 0.75rem;
  padding: 1rem 1.25rem;
  text-align: center;
  min-width: 5.5rem;
}

.stat-number {
  display: block;
  font-size: 1.5rem;
  font-weight: 700;
  line-height: 1.2;
}

.stat-label {
  display: block;
  font-size: 0.75rem;
  opacity: 0.75;
  margin-top: 0.125rem;
}

.hero-instructions {
  max-width: 1200px;
  margin: 1.5rem auto 0;
  display: flex;
  gap: 1.5rem;
  flex-wrap: wrap;
}

.instruction-step {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.instruction-icon {
  width: 1.75rem;
  height: 1.75rem;
  border-radius: 50%;
  background: rgba(255, 255, 255, 0.2);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 0.8125rem;
  font-weight: 700;
  flex-shrink: 0;
}

.instruction-text {
  font-size: 0.8125rem;
  opacity: 0.9;
}

.demo-toggle {
  position: absolute;
  top: 1rem;
  right: 1rem;
  color: rgba(255, 255, 255, 0.7) !important;
  font-size: 0.75rem !important;
  border: 1px solid rgba(255, 255, 255, 0.25) !important;
  background: rgba(255, 255, 255, 0.08) !important;
  border-radius: 1rem !important;
  padding: 0.25rem 0.75rem !important;
  height: auto !important;
  cursor: pointer;
}

.demo-toggle:hover {
  background: rgba(255, 255, 255, 0.16) !important;
  color: #fff !important;
}

/* ── Content Area ──────────────────────────────────────── */
.content-area {
  max-width: 1200px;
  margin: 0 auto;
  padding: 1.5rem 2rem 3rem;
}

.section-header {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  margin-bottom: 1.25rem;
  flex-wrap: wrap;
  gap: 0.5rem;
}

.section-title {
  font-size: 1.25rem;
  font-weight: 700;
  margin: 0;
  color: var(--sapTextColor, #32363a);
}

.track-count {
  font-size: 0.8125rem;
  color: var(--sapContent_LabelColor, #556b82);
}

/* ── Track Grid ────────────────────────────────────────── */
.track-grid {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 1rem;
}

.track-card {
  all: unset;
  cursor: pointer;
  display: flex;
  flex-direction: column;
  background: var(--sapTile_Background, #fff);
  border: 1px solid var(--sapGroup_ContentBorderColor, #d9d9d9);
  border-radius: 0.75rem;
  padding: 1.25rem;
  transition: box-shadow 0.2s ease, border-color 0.2s ease;
  box-sizing: border-box;
}

.track-card:hover {
  box-shadow: var(--sapContent_Shadow2, 0 0.25rem 1rem rgba(0, 0, 0, 0.15));
  border-color: var(--sapBrandColor, #0070f2);
}

.track-card:focus-visible {
  outline: 2px solid var(--sapBrandColor, #0070f2);
  outline-offset: 2px;
}

.track-card--complete {
  border-color: var(--sapPositiveColor, #107e3e);
}

.track-card--complete:hover {
  border-color: var(--sapPositiveColor, #107e3e);
}

.track-card__header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  margin-bottom: 0.75rem;
}

.track-card__progress-ring {
  position: relative;
  width: 3rem;
  height: 3rem;
  flex-shrink: 0;
}

.progress-ring-svg {
  width: 100%;
  height: 100%;
  transform: rotate(-90deg);
}

.progress-ring-bg {
  stroke: var(--sapNeutralBorderColor, #d9d9d9);
}

.progress-ring-fill {
  stroke: var(--sapBrandColor, #0070f2);
  transition: stroke-dasharray 0.4s ease;
}

.track-card--complete .progress-ring-fill {
  stroke: var(--sapPositiveColor, #107e3e);
}

.progress-ring-text {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 0.6875rem;
  font-weight: 700;
  color: var(--sapTextColor, #32363a);
}

.track-card__badge {
  color: var(--sapPositiveColor, #107e3e);
}

.track-card__title {
  font-size: 0.9375rem;
  font-weight: 700;
  margin: 0 0 0.375rem;
  color: var(--sapTextColor, #32363a);
  line-height: 1.3;
}

.track-card__desc {
  font-size: 0.8125rem;
  color: var(--sapContent_LabelColor, #556b82);
  margin: 0 0 auto;
  line-height: 1.5;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  padding-bottom: 0.75rem;
}

.track-card__meta {
  display: flex;
  justify-content: space-between;
  font-size: 0.75rem;
  color: var(--sapContent_LabelColor, #556b82);
  margin-bottom: 0.5rem;
}

.track-card__progress-bar {
  height: 4px;
  background: var(--sapNeutralBorderColor, #d9d9d9);
  border-radius: 2px;
  overflow: hidden;
}

.track-card__progress-fill {
  height: 100%;
  background: var(--sapBrandColor, #0070f2);
  border-radius: 2px;
  transition: width 0.4s ease;
}

.track-card--complete .track-card__progress-fill {
  background: var(--sapPositiveColor, #107e3e);
}

/* ── Detail Header ─────────────────────────────────────── */
.detail-header {
  margin-bottom: 1.5rem;
}

.back-button {
  display: inline-flex;
  align-items: center;
  gap: 0.375rem;
  margin-bottom: 1rem;
  font-size: 0.875rem !important;
}

.detail-title-row {
  display: flex;
  align-items: baseline;
  gap: 1rem;
  flex-wrap: wrap;
}

.detail-title {
  font-size: 1.5rem;
  font-weight: 700;
  margin: 0;
  color: var(--sapTextColor, #32363a);
}

.detail-progress {
  font-size: 0.875rem;
  color: var(--sapContent_LabelColor, #556b82);
}

.detail-desc {
  font-size: 0.875rem;
  color: var(--sapContent_LabelColor, #556b82);
  margin: 0.5rem 0 0;
}

/* ── Timeline ──────────────────────────────────────────── */
.timeline {
  position: relative;
  max-width: 740px;
}

.timeline-item {
  position: relative;
  display: flex;
  gap: 1rem;
  padding-bottom: 0.75rem;
}

.timeline-item:last-child {
  padding-bottom: 0;
}

/* Connecting line */
.timeline-line {
  position: absolute;
  left: 1.125rem;
  top: calc(100% - 0.75rem);
  height: 0.75rem;
  width: 2px;
  background: var(--sapNeutralBorderColor, #d9d9d9);
}

.step--completed .timeline-line {
  background: var(--sapPositiveColor, #107e3e);
}

/* Bubble */
.timeline-bubble {
  position: relative;
  z-index: 1;
  width: 2.25rem;
  height: 2.25rem;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  font-size: 0.75rem;
  font-weight: 700;
  transition: all 0.2s ease;
  border: 1.5px solid var(--sapNeutralBorderColor, #d9d9d9);
  background: var(--sapTile_Background, #fff);
  color: var(--sapContent_LabelColor, #556b82);
  margin-top: 0.875rem;
}

.timeline-bubble.clickable {
  cursor: pointer;
}

.timeline-bubble.clickable:hover {
  box-shadow: 0 0 0 3px rgba(0, 112, 242, 0.08);
}

/* Step card wrapper */
.timeline-content {
  flex: 1;
  min-width: 0;
  background: var(--sapTile_Background, #fff);
  border: 1px solid var(--sapGroup_ContentBorderColor, #d9d9d9);
  border-radius: var(--sapButton_BorderCornerRadius, 0.5rem);
  padding: 0.875rem 1rem;
  transition: box-shadow 0.15s ease, border-color 0.15s ease;
}

.timeline-content:hover {
  box-shadow: var(--sapContent_Shadow0, 0 1px 4px rgba(0, 0, 0, 0.06));
}

/* Status-specific bubble styles */
.step--locked .timeline-bubble {
  border-color: var(--sapNeutralBorderColor, #d9d9d9);
  color: var(--sapContent_DisabledTextColor, #bcc3ca);
  background: var(--sapNeutralBackground, #f5f6f7);
}

.step--available .timeline-bubble {
  border-color: var(--sapBrandColor, #0070f2);
  color: var(--sapBrandColor, #0070f2);
  background: var(--sapTile_Background, #fff);
}

.step--in-progress .timeline-bubble {
  border-color: var(--sapInformationBorderColor, #0070f2);
  background: var(--sapInformationBackground, #e1f4ff);
  color: var(--sapBrandColor, #0070f2);
}

.step--completed .timeline-bubble {
  border-color: var(--sapPositiveColor, #107e3e);
  background: var(--sapPositiveBackground, #f1fdf4);
  color: var(--sapPositiveColor, #107e3e);
}

.step--earned .timeline-bubble {
  border-color: var(--sapAccentColor1, #e38b16);
  background: rgba(227, 139, 22, 0.08);
  color: var(--sapAccentColor1, #e38b16);
}

/* Status-specific card borders */
.step--available .timeline-content {
  border-color: var(--sapBrandColor, #0070f2);
}

.step--in-progress .timeline-content {
  border-color: var(--sapInformationBorderColor, #0070f2);
  background: var(--sapInformationBackground, #e1f4ff);
}

.step--completed .timeline-content {
  border-left: 3px solid var(--sapPositiveColor, #107e3e);
}

.step--earned .timeline-content {
  border-left: 3px solid var(--sapAccentColor1, #e38b16);
}

.step--locked .timeline-content {
  opacity: 0.65;
}

.timeline-content__header {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  margin-bottom: 0.375rem;
  flex-wrap: wrap;
}

/* Info-label style type badges */
.item-type-label {
  font-size: 0.6875rem;
  font-weight: 600;
  letter-spacing: 0.02em;
  padding: 0.125rem 0.5rem;
  border-radius: 0.25rem;
}

.item-type--tutorial {
  background: rgba(0, 112, 242, 0.08);
  color: var(--sapBrandColor, #0070f2);
}

.item-type--checkpoint {
  background: rgba(108, 50, 169, 0.08);
  color: var(--sapAccentColor8, #6c32a9);
}

.item-type--prize {
  background: rgba(227, 139, 22, 0.08);
  color: var(--sapAccentColor1, #e38b16);
}

.item-experience {
  font-size: 0.6875rem;
  padding: 0.125rem 0.5rem;
  border-radius: 0.25rem;
  background: var(--sapNeutralBackground, #f5f6f7);
  color: var(--sapContent_LabelColor, #556b82);
  border: 1px solid var(--sapNeutralBorderColor, #d9d9d9);
}

.item-time {
  font-size: 0.6875rem;
  color: var(--sapContent_LabelColor, #556b82);
  display: flex;
  align-items: center;
  gap: 0.25rem;
}

.item-time::before {
  content: '';
  display: inline-block;
  width: 0.75rem;
  height: 0.75rem;
  border: 1.5px solid var(--sapContent_LabelColor, #556b82);
  border-radius: 50%;
}

.timeline-content__title {
  font-size: 0.9375rem;
  font-weight: 600;
  margin: 0 0 0.25rem;
  color: var(--sapTextColor, #32363a);
  line-height: 1.4;
}

.timeline-content__title.clickable {
  cursor: pointer;
  color: var(--sapLinkColor, #0064d9);
}

.timeline-content__title.clickable:hover {
  text-decoration: underline;
}

.step--locked .timeline-content__title {
  color: var(--sapContent_LabelColor, #556b82);
}

.timeline-content__desc {
  font-size: 0.8125rem;
  color: var(--sapContent_LabelColor, #556b82);
  margin: 0;
  line-height: 1.5;
}

.step--locked .timeline-content__desc {
  color: var(--sapContent_LabelColor, #556b82);
}

/* ── Prize Section ─────────────────────────────────────── */
.prize-section {
  margin-top: 0.75rem;
}

.prize-qr {
  display: flex;
  align-items: flex-start;
  gap: 1rem;
  background: var(--sapNeutralBackground, #f5f6f7);
  border: 1px solid var(--sapGroup_ContentBorderColor, #d9d9d9);
  border-radius: 0.75rem;
  padding: 1rem;
}

.qr-placeholder {
  flex-shrink: 0;
  color: var(--sapTextColor, #32363a);
}

.qr-image {
  flex-shrink: 0;
  border-radius: 0.5rem;
}

.prize-message {
  font-size: 0.8125rem;
  color: var(--sapPositiveTextColor, #107e3e);
  margin: 0;
  line-height: 1.5;
}

.prize-message--locked {
  color: var(--sapContent_LabelColor, #556b82);
}

.prize-locked {
  margin-top: 0.5rem;
}

.prize-locked__text {
  font-size: 0.8125rem;
  color: var(--sapContent_DisabledTextColor, #bcc3ca);
  margin: 0;
  font-style: italic;
}

/* ── Skeleton Loading ──────────────────────────────────── */
.loading-grid {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 1rem;
  padding-top: 1.5rem;
}

.skeleton-card {
  background: var(--sapTile_Background, #fff);
  border: 1px solid var(--sapGroup_ContentBorderColor, #d9d9d9);
  border-radius: 0.75rem;
  padding: 1.25rem;
}

.skeleton-line {
  height: 0.75rem;
  background: var(--sapNeutralBorderColor, #d9d9d9);
  border-radius: 0.25rem;
  margin-bottom: 0.75rem;
  animation: pulse 1.5s ease-in-out infinite;
}

.skeleton-line.wide { width: 80%; }
.skeleton-line.medium { width: 60%; }
.skeleton-line.short { width: 40%; margin-bottom: 0; }

@keyframes pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.4; }
}

/* ── Responsive ────────────────────────────────────────── */
@media (max-width: 1024px) {
  .track-grid,
  .loading-grid {
    grid-template-columns: repeat(2, 1fr);
  }
}

@media (max-width: 768px) {
  .hero-inner {
    flex-direction: column;
    text-align: center;
  }

  .hero-stats {
    justify-content: center;
  }

  .hero-instructions {
    justify-content: center;
  }

  .detail-title-row {
    flex-direction: column;
    gap: 0.25rem;
  }
}

@media (max-width: 640px) {
  .hero {
    padding: 1.5rem 1rem 1rem;
  }

  .content-area {
    padding: 1rem 1rem 2rem;
  }

  .track-grid,
  .loading-grid {
    grid-template-columns: 1fr;
  }

  .hero-stats {
    gap: 0.5rem;
  }

  .stat-card {
    padding: 0.75rem 1rem;
    min-width: 4rem;
  }

  .hero-instructions {
    flex-direction: column;
    gap: 0.5rem;
    align-items: flex-start;
  }

  .timeline-item {
    gap: 0.75rem;
  }

  .prize-qr {
    flex-direction: column;
    align-items: center;
    text-align: center;
  }
}

/* ═══════════════════════════════════════════════════════════════════
   Joule Theme — Light Mode
   ═══════════════════════════════════════════════════════════════════ */

.app-space[data-theme="joule"] .hero {
  background: linear-gradient(135deg, #5D36FF 0%, #7B42F0 40%, #A100C2 100%);
}

.app-space[data-theme="joule"] .stat-card {
  background: rgba(255, 255, 255, 0.14);
  border-color: rgba(255, 255, 255, 0.22);
}

.app-space[data-theme="joule"] .instruction-icon {
  background: rgba(255, 255, 255, 0.22);
}

.app-space[data-theme="joule"] .demo-toggle {
  border-color: rgba(255, 255, 255, 0.3) !important;
  background: rgba(255, 255, 255, 0.1) !important;
}

.app-space[data-theme="joule"] .demo-toggle:hover {
  background: rgba(255, 255, 255, 0.2) !important;
}

.app-space[data-theme="joule"] .track-card:hover {
  border-color: #5D36FF;
  box-shadow: 0 0.25rem 1rem rgba(93, 54, 255, 0.15);
}

.app-space[data-theme="joule"] .track-card:focus-visible {
  outline-color: #5D36FF;
}

.app-space[data-theme="joule"] .progress-ring-fill {
  stroke: #5D36FF;
}

.app-space[data-theme="joule"] .track-card--complete .progress-ring-fill {
  stroke: var(--sapPositiveColor, #107e3e);
}

.app-space[data-theme="joule"] .track-card__progress-fill {
  background: linear-gradient(90deg, #5D36FF, #A100C2);
}

.app-space[data-theme="joule"] .track-card--complete .track-card__progress-fill {
  background: var(--sapPositiveColor, #107e3e);
}

.app-space[data-theme="joule"] .step--available .timeline-bubble {
  border-color: #5D36FF;
  color: #5D36FF;
}

.app-space[data-theme="joule"] .step--available .timeline-content {
  border-color: #5D36FF;
}

.app-space[data-theme="joule"] .step--in-progress .timeline-bubble {
  border-color: #5D36FF;
  background: rgba(93, 54, 255, 0.08);
  color: #5D36FF;
}

.app-space[data-theme="joule"] .step--in-progress .timeline-content {
  border-color: #5D36FF;
  background: rgba(93, 54, 255, 0.04);
}

.app-space[data-theme="joule"] .item-type--tutorial {
  background: rgba(93, 54, 255, 0.08);
  color: #5D36FF;
}

.app-space[data-theme="joule"] .timeline-content__title.clickable {
  color: #5D36FF;
}

.app-space[data-theme="joule"] .timeline-bubble.clickable:hover {
  box-shadow: 0 0 0 3px rgba(93, 54, 255, 0.1);
}

.app-space[data-theme="joule"] .back-button:hover {
  color: #5D36FF !important;
}

/* ═══════════════════════════════════════════════════════════════════
   Joule Theme — Dark Mode
   ═══════════════════════════════════════════════════════════════════ */

.app-space[data-theme="joule"][data-dark] .hero {
  background: linear-gradient(135deg, #2A1066 0%, #4B1A8A 40%, #6B0080 100%);
}

.app-space[data-theme="joule"][data-dark] .stat-card {
  background: rgba(93, 54, 255, 0.12);
  border-color: rgba(93, 54, 255, 0.25);
}

.app-space[data-theme="joule"][data-dark] .instruction-icon {
  background: rgba(93, 54, 255, 0.25);
}

.app-space[data-theme="joule"][data-dark] .track-card:hover {
  border-color: #8B6FFF;
  box-shadow: 0 0.25rem 1rem rgba(93, 54, 255, 0.25);
}

.app-space[data-theme="joule"][data-dark] .track-card:focus-visible {
  outline-color: #8B6FFF;
}

.app-space[data-theme="joule"][data-dark] .progress-ring-fill {
  stroke: #8B6FFF;
}

.app-space[data-theme="joule"][data-dark] .track-card__progress-fill {
  background: linear-gradient(90deg, #8B6FFF, #C040E0);
}

.app-space[data-theme="joule"][data-dark] .track-card--complete .track-card__progress-fill {
  background: var(--sapPositiveColor, #57b520);
}

.app-space[data-theme="joule"][data-dark] .step--available .timeline-bubble {
  border-color: #8B6FFF;
  color: #8B6FFF;
}

.app-space[data-theme="joule"][data-dark] .step--available .timeline-content {
  border-color: #8B6FFF;
}

.app-space[data-theme="joule"][data-dark] .step--in-progress .timeline-bubble {
  border-color: #8B6FFF;
  background: rgba(139, 111, 255, 0.15);
  color: #8B6FFF;
}

.app-space[data-theme="joule"][data-dark] .step--in-progress .timeline-content {
  border-color: #8B6FFF;
  background: rgba(139, 111, 255, 0.06);
}

.app-space[data-theme="joule"][data-dark] .item-type--tutorial {
  background: rgba(139, 111, 255, 0.12);
  color: #8B6FFF;
}

.app-space[data-theme="joule"][data-dark] .timeline-content__title.clickable {
  color: #8B6FFF;
}

.app-space[data-theme="joule"][data-dark] .timeline-bubble.clickable:hover {
  box-shadow: 0 0 0 3px rgba(139, 111, 255, 0.15);
}

/* ═══════════════════════════════════════════════════════════════════
   Sapphire 2026 Theme — Light Mode
   ═══════════════════════════════════════════════════════════════════ */

.app-space[data-theme="sapphire"] .hero {
  background: linear-gradient(135deg, #1B90FF 0%, #0070F2 45%, #002A86 100%);
}

.app-space[data-theme="sapphire"] .stat-card {
  background: rgba(255, 255, 255, 0.14);
  border-color: rgba(255, 255, 255, 0.22);
}

.app-space[data-theme="sapphire"] .instruction-icon {
  background: rgba(255, 255, 255, 0.22);
}

.app-space[data-theme="sapphire"] .demo-toggle {
  border-color: rgba(255, 255, 255, 0.3) !important;
  background: rgba(255, 255, 255, 0.1) !important;
}

.app-space[data-theme="sapphire"] .demo-toggle:hover {
  background: rgba(255, 255, 255, 0.2) !important;
}

.app-space[data-theme="sapphire"] .track-card:hover {
  border-color: #0070F2;
  box-shadow: 0 0.25rem 1rem rgba(0, 112, 242, 0.12), 0 0 0 1px rgba(200, 80, 192, 0.08);
}

.app-space[data-theme="sapphire"] .track-card:focus-visible {
  outline-color: #0070F2;
}

.app-space[data-theme="sapphire"] .progress-ring-fill {
  stroke: #0070F2;
}

.app-space[data-theme="sapphire"] .track-card--complete .progress-ring-fill {
  stroke: var(--sapPositiveColor, #107e3e);
}

.app-space[data-theme="sapphire"] .track-card__progress-fill {
  background: linear-gradient(90deg, #0070F2, #C850C0);
}

.app-space[data-theme="sapphire"] .track-card--complete .track-card__progress-fill {
  background: var(--sapPositiveColor, #107e3e);
}

.app-space[data-theme="sapphire"] .step--available .timeline-bubble {
  border-color: #0070F2;
  color: #0070F2;
}

.app-space[data-theme="sapphire"] .step--available .timeline-content {
  border-color: #0070F2;
}

.app-space[data-theme="sapphire"] .step--in-progress .timeline-bubble {
  border-color: #1B90FF;
  background: rgba(27, 144, 255, 0.08);
  color: #0070F2;
}

.app-space[data-theme="sapphire"] .step--in-progress .timeline-content {
  border-color: #1B90FF;
  background: rgba(27, 144, 255, 0.04);
}

.app-space[data-theme="sapphire"] .item-type--tutorial {
  background: rgba(0, 112, 242, 0.08);
  color: #0070F2;
}

.app-space[data-theme="sapphire"] .timeline-content__title.clickable {
  color: #0070F2;
}

.app-space[data-theme="sapphire"] .timeline-bubble.clickable:hover {
  box-shadow: 0 0 0 3px rgba(0, 112, 242, 0.1);
}

.app-space[data-theme="sapphire"] .back-button:hover {
  color: #0070F2 !important;
}

.app-space[data-theme="sapphire"] .step--earned .timeline-bubble {
  border-color: #C850C0;
  background: rgba(200, 80, 192, 0.08);
  color: #C850C0;
}

.app-space[data-theme="sapphire"] .step--earned .timeline-content {
  border-left: 3px solid #C850C0;
}

/* ═══════════════════════════════════════════════════════════════════
   Sapphire 2026 Theme — Dark Mode
   ═══════════════════════════════════════════════════════════════════ */

.app-space[data-theme="sapphire"][data-dark] .hero {
  background: linear-gradient(135deg, #002A86 0%, #00144A 60%, #0A0030 100%);
}

.app-space[data-theme="sapphire"][data-dark] .stat-card {
  background: rgba(27, 144, 255, 0.1);
  border-color: rgba(27, 144, 255, 0.2);
}

.app-space[data-theme="sapphire"][data-dark] .instruction-icon {
  background: rgba(27, 144, 255, 0.2);
}

.app-space[data-theme="sapphire"][data-dark] .track-card:hover {
  border-color: #89D1FF;
  box-shadow: 0 0.25rem 1rem rgba(0, 42, 134, 0.35), 0 0 0 1px rgba(200, 80, 192, 0.1);
}

.app-space[data-theme="sapphire"][data-dark] .track-card:focus-visible {
  outline-color: #89D1FF;
}

.app-space[data-theme="sapphire"][data-dark] .progress-ring-fill {
  stroke: #89D1FF;
}

.app-space[data-theme="sapphire"][data-dark] .track-card__progress-fill {
  background: linear-gradient(90deg, #89D1FF, #E070D0);
}

.app-space[data-theme="sapphire"][data-dark] .track-card--complete .track-card__progress-fill {
  background: var(--sapPositiveColor, #57b520);
}

.app-space[data-theme="sapphire"][data-dark] .step--available .timeline-bubble {
  border-color: #89D1FF;
  color: #89D1FF;
}

.app-space[data-theme="sapphire"][data-dark] .step--available .timeline-content {
  border-color: #89D1FF;
}

.app-space[data-theme="sapphire"][data-dark] .step--in-progress .timeline-bubble {
  border-color: #89D1FF;
  background: rgba(137, 209, 255, 0.12);
  color: #89D1FF;
}

.app-space[data-theme="sapphire"][data-dark] .step--in-progress .timeline-content {
  border-color: #89D1FF;
  background: rgba(137, 209, 255, 0.05);
}

.app-space[data-theme="sapphire"][data-dark] .item-type--tutorial {
  background: rgba(137, 209, 255, 0.1);
  color: #89D1FF;
}

.app-space[data-theme="sapphire"][data-dark] .timeline-content__title.clickable {
  color: #89D1FF;
}

.app-space[data-theme="sapphire"][data-dark] .timeline-bubble.clickable:hover {
  box-shadow: 0 0 0 3px rgba(137, 209, 255, 0.12);
}

.app-space[data-theme="sapphire"][data-dark] .step--earned .timeline-bubble {
  border-color: #E070D0;
  background: rgba(224, 112, 208, 0.12);
  color: #E070D0;
}

.app-space[data-theme="sapphire"][data-dark] .step--earned .timeline-content {
  border-left: 3px solid #E070D0;
}
</style>
