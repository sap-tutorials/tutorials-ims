<script setup lang="ts">
import { ref, computed, reactive, onMounted, onUnmounted, watch } from 'vue'
import { useRealtimeProgress } from './useRealtimeProgress'
import { useConfetti } from '../composables/useConfetti'
import { checkpointBarcodeUrl as _checkpointBarcodeUrl, shouldShowCheckpointBarcode as _shouldShowCheckpointBarcode } from './checkpoint-barcode'
import { isItemUnlocked as _isItemUnlocked, isTutorialOpenable as _isTutorialOpenable } from './app-space-gating'
import type { GatingItem } from './app-space-gating'

// ── Configuration ─────────────────────────────────────────────────
const eventId = ref<number | null>(null)

// ── Theme ─────────────────────────────────────────────────────────
// Dark mode is driven by html[data-theme] (set pre-paint in head.html from
// localStorage/prefers-color-scheme, and toggled at runtime by the header
// theme switch, which flips data-theme + .dark in lockstep). A one-shot ref
// read at module-eval can latch a stale value (island hydrates before/after
// the toggle) — which left html[data-dark] stuck on in light mode and let the
// higher-specificity .app-space[data-theme="joule"][data-dark] .hero rule
// override the correct light Joule gradient. Keep it in sync via an observer.
const readIsDark = () => document.documentElement.dataset.theme === 'dark'
const isDark = ref(readIsDark())
const activeTheme = ref<'joule' | 'sapphire' | null>(null)
const loadedEventName = ref('')
const loadedEventDescription = ref('')
const hasLogo = ref(false)

const eventName = computed(() => {
  if (loadedEventName.value) return loadedEventName.value
  if (activeTheme.value === 'sapphire') return 'SAP Sapphire 2026'
  return 'SAP TechEd'
})

// Event description pulled from the related event (#2133); falls back to the
// generic App Space blurb when the event has no description maintained.
const eventDescription = computed(() =>
  loadedEventDescription.value ||
  'Pick a track, complete the tutorials, and earn prizes along the way.'
)

// Logo lockup served anonymously from HANA when the event has one (#2133).
const logoUrl = computed(() =>
  hasLogo.value && eventId.value
    ? `/api/event-logo?eventLegacyId=${eventId.value}`
    : ''
)

// ── Interfaces ─────────────────────────────────────────────────────
interface AppSpaceItem {
  imsId: number | null
  title: string
  type: 'TUTORIAL' | 'CHECKPOINT' | 'PRIZE'
  status: string
  progress: number
  experience: string
  timeToComplete: number
  url: string
  description: string
  recordId?: number
  // #2887: server-computed per-item unlock flag (Task 3). Preferred by
  // app-space-gating's isItemUnlocked over the legacy index-adjacency fallback.
  unlocked?: boolean
  // #2864: a path item flagged temporarily unavailable upstream (admin-toggled),
  // with an optional human-readable reason.
  temporarilyUnavailable?: boolean
  unavailableReason?: string
  // #2887: synthetic lane-end prize checkpoints carry the prize legacyId. The
  // item still has type==='CHECKPOINT' so it flows through the normal barcode
  // path (shouldShowCheckpointBarcode keys only on type/unlocked/authenticated).
  prizeId?: number | null
}

// #2887: nested segment structure produced by srv/lib/path-item-task-resolver.js
// (buildPathSegments) and annotated with per-item `unlocked` by
// srv/lib/app-space-segments.js (annotateUnlocked). The detail view renders
// from these; the legacy flat `items[]` is kept for back-compat (overview grid
// counts) and older payloads that predate segments.
interface ForkLane {
  label: string
  items: AppSpaceItem[]
}
interface LinearSegment {
  order: number
  kind: 'linear'
  items: AppSpaceItem[]
}
interface ClusterSegment {
  order: number
  kind: 'parallel-any'
  items: AppSpaceItem[]
}
interface ForkSegment {
  order: number
  kind: 'fork'
  lanes: ForkLane[]
}
type AppSpaceSegment = LinearSegment | ClusterSegment | ForkSegment

interface AppSpaceTrack {
  id: number
  title: string
  description: string
  items: AppSpaceItem[]
  segments?: AppSpaceSegment[]
}

interface AppSpaceData {
  eventId: number
  eventName: string
  eventDescription?: string
  hasLogo?: boolean
  authenticated?: boolean
  type: string
  paths: AppSpaceTrack[]
}

// ── State ──────────────────────────────────────────────────────────
const tracks = ref<AppSpaceTrack[]>([])
const selectedTrack = ref<AppSpaceTrack | null>(null)
const loading = ref(true)
const isLoggedIn = ref(false)
const authenticated = ref(false)
const loadError = ref('')

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
    const param = eventId.value ? `eventLegacyId=${eventId.value}` : `eventLegacyId=0`
    const res = await fetch(`/api/getAppSpaceProgress(${param})`)
    if (res.ok) {
      const data = await res.json()
      // #2314: endpoint is anonymous-readable now, so a 200 no longer implies a
      // login. Trust the server's `authenticated` flag to gate the logged-in-only
      // realtime/confetti path (older payloads without the flag → treated as anon).
      isLoggedIn.value = Boolean(data.authenticated)
      authenticated.value = Boolean(data.authenticated)
      if (data.eventId) eventId.value = data.eventId
      return data
    }
    // Non-OK from the configured endpoint (e.g. 400 "no mission configured",
    // 404 "event not found"). Capture the reason so the UI can show a clear
    // empty state instead of silently falling back to the default hero.
    try {
      const body = await res.json()
      if (body?.error?.message) loadError.value = body.error.message
    } catch {}
  } catch {}
  try {
    const res = await fetch('/app-space-data.json')
    if (res.ok) return await res.json()
  } catch {}
  return null
}

onMounted(async () => {
  // Re-sync dark mode after the pre-paint head script has settled, then track
  // runtime theme toggles so html[data-dark] never latches a stale value.
  const html = document.documentElement
  isDark.value = readIsDark()
  const themeObserver = new MutationObserver(() => { isDark.value = readIsDark() })
  themeObserver.observe(html, { attributes: true, attributeFilter: ['data-theme'] })
  onUnmounted(() => themeObserver.disconnect())

  const params = new URLSearchParams(window.location.search)
  const theme = params.get('theme')
  if (theme === 'joule' || theme === 'sapphire') {
    activeTheme.value = theme
  }

  // Read `eventId` case-insensitively: users land on links like
  // /app-space/?eventid=... (lowercase) and URLSearchParams.get is case-sensitive.
  let eidParam: string | null = null
  for (const [k, v] of params) {
    if (k.toLowerCase() === 'eventid') { eidParam = v; break }
  }
  if (eidParam) eventId.value = Number(eidParam)

  const data = await loadData()
  if (data) {
    tracks.value = data.paths
    if (data.eventName) loadedEventName.value = data.eventName
    if (data.eventDescription) loadedEventDescription.value = data.eventDescription
    hasLogo.value = Boolean(data.hasLogo)
  }
  loading.value = false
})

// ── Real-time progress (requires login + event context) ───────────
const eventIdForWs = ref<string>('')

watch([() => tracks.value, isLoggedIn, eventId], ([t, loggedIn, eid]) => {
  if (!loggedIn || !t.length) return
  if (eid) eventIdForWs.value = String(eid)
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
function formatTime(minutes: number): string {
  if (minutes <= 0) return ''
  const mins = Math.round(minutes)
  if (mins < 60) return `${mins} min`
  const hrs = Math.floor(mins / 60)
  const rem = mins % 60
  return rem > 0 ? `${hrs} hr ${rem} min` : `${hrs} hr`
}

function tutorialItems(track: AppSpaceTrack): AppSpaceItem[] {
  return track.items.filter(i => i.type === 'TUTORIAL')
}

// Tutorial count that works for both segment and legacy flat tracks.
function trackTutorialCount(track: AppSpaceTrack): number {
  return hasSegments(track) ? segmentTutorials(track).length : tutorialItems(track).length
}

// ── Segment helpers (#2887) ────────────────────────────────────────
// The detail view renders from `track.segments`. Aggregates (counts, percent,
// complete, barcode eligibility) are computed over segments when present so the
// AUTHORED completion rule is honored — a per-lane prize means that lane
// completing can satisfy the track's reward, while a downstream checkpoint
// after the fork requires all lanes. We do NOT define "complete" as "every flat
// tutorial COMPLETED" — that would contradict a prize already earned on one lane.

function trackSegments(track: AppSpaceTrack): AppSpaceSegment[] {
  return track.segments ?? []
}

function hasSegments(track: AppSpaceTrack): boolean {
  return Array.isArray(track.segments) && track.segments.length > 0
}

// Widest fork in the track (max lanes across all fork segments; 1 if none).
// Drives the timeline's max-width so multi-lane forks get the horizontal room
// they need instead of being squished into the single-column 740px cap — a
// 3-4 lane fork at 740px wraps titles to one word per line (#2887 follow-up).
function maxLaneCount(track: AppSpaceTrack): number {
  return trackSegments(track).reduce(
    (max, seg) => (seg.kind === 'fork' ? Math.max(max, seg.lanes.length) : max),
    1,
  )
}

// Flatten every item a segment contains (cluster/linear items, or all lane items
// for a fork). Used for progress math and "all tutorials" totals.
function segmentItems(seg: AppSpaceSegment): AppSpaceItem[] {
  if (seg.kind === 'fork') return seg.lanes.flatMap(l => l.items)
  return seg.items
}

// All items across a track's segments (flattened). Synthetic lane prizes
// (CHECKPOINT with prizeId) are included — they render and claim like any
// checkpoint.
function allSegmentItems(track: AppSpaceTrack): AppSpaceItem[] {
  return trackSegments(track).flatMap(segmentItems)
}

// #2896: horizontal position of lane `li`'s bubble center within a fork/join
// connector whose width spans the `.lanes` grid (N equal 1fr columns, 1rem gap).
// = lane left edge + the bubble's fixed inset from its lane's left edge
// (1px border + 0.6rem lane padding + 1.125rem half-bubble ≈ 1.8rem). Keeps the
// drop/up stubs aligned to each lane's lock bubble at any lane count / width.
function laneBubbleLeft(li: number, laneCount: number): string {
  return `calc((100% - ${laneCount - 1}rem) / ${laneCount} * ${li} + ${li}rem + 1.8rem)`
}

// TUTORIAL items across all segments — the denominator for progress.
function segmentTutorials(track: AppSpaceTrack): AppSpaceItem[] {
  return allSegmentItems(track).filter(i => i.type === 'TUTORIAL')
}

// An item counts as "done" only on a strict COMPLETED (mirrors the server's
// isComplete in app-space-segments.js; #2866 COMPLETED_OUT_OF_WINDOW and #2864
// temporarilyUnavailable never count).
function itemDone(item: AppSpaceItem): boolean {
  if (item.temporarilyUnavailable) return false
  return item.status === 'COMPLETED'
}

// A lane is complete when all its non-prize items are done (the server uses the
// same rule to unlock the lane's synthetic prize + any downstream join).
function laneTutorialsDone(lane: ForkLane): boolean {
  const work = lane.items.filter(i => !i.prizeId)
  return work.length > 0 && work.every(itemDone)
}

// #2890: a GROUP's temporarilyUnavailable/unavailableReason now DOES propagate
// onto its expanded child tutorials server-side (buildPathSegments stamps the
// GROUP path-item onto each child). A lane is unavailable when any of its items
// carries the flag — which, post-propagation, covers a GROUP-level toggle too.
// The lane column gets a visibly-unavailable state (dimmed + a notice).
function laneUnavailable(lane: ForkLane): boolean {
  return lane.items.some(i => i.temporarilyUnavailable)
}

function completedCount(track: AppSpaceTrack): number {
  if (hasSegments(track)) return segmentTutorials(track).filter(itemDone).length
  return tutorialItems(track).filter(i => i.status === 'COMPLETED').length
}

function trackTotalTime(track: AppSpaceTrack): number {
  if (hasSegments(track)) return segmentTutorials(track).reduce((sum, i) => sum + i.timeToComplete, 0)
  return tutorialItems(track).reduce((sum, i) => sum + i.timeToComplete, 0)
}

// #2887 authored completion rule: a track is complete when its reward is
// satisfiable. A segment carrying a synthetic lane prize (CHECKPOINT+prizeId)
// completes the track's reward as soon as THAT lane's tutorials are done; a
// downstream CHECKPOINT (no prizeId) requires all preceding work. We model this
// as: the track is complete when a reward is claimable, OR (no checkpoints
// authored) when all tutorials are done.
//
// #2889: prize-aware restriction of the old `checkpoints.some(unlocked)` rule.
// Two checkpoint kinds, by authoring intent:
//   • lane-prize (prizeId set) — authored to earn the reward the moment ITS lane
//     finishes, so ANY unlocked lane-prize completes the track (keeps `some`).
//   • plain downstream (no prizeId) — a join that requires preceding work; only
//     the TERMINAL one marks the whole track done. Keying off *any* unlocked
//     plain checkpoint would falsely complete a track whose authored checkpoint
//     sits at a non-terminal order while later tutorials remain. `allSegmentItems`
//     flattens segments in authored (ascending `order`) order, so the LAST
//     non-prize checkpoint is the highest-order one.
function isTrackComplete(track: AppSpaceTrack): boolean {
  if (!hasSegments(track)) {
    const tuts = tutorialItems(track)
    return tuts.length > 0 && tuts.every(i => i.status === 'COMPLETED')
  }
  const items = allSegmentItems(track)
  const checkpoints = items.filter(i => i.type === 'CHECKPOINT')
  if (checkpoints.length > 0) {
    // Any lane-prize checkpoint being unlocked earns the reward on its own.
    const lanePrizeUnlocked = checkpoints.some(c => c.prizeId != null && isSegmentItemUnlocked(c))
    // Otherwise, only the highest-order plain (non-prize) checkpoint counts —
    // the terminal join. Lower-order plain checkpoints never complete the track.
    const plainCheckpoints = checkpoints.filter(c => c.prizeId == null)
    const terminalPlain = plainCheckpoints[plainCheckpoints.length - 1]
    const terminalPlainUnlocked = terminalPlain != null && isSegmentItemUnlocked(terminalPlain)
    return lanePrizeUnlocked || terminalPlainUnlocked
  }
  const tuts = segmentTutorials(track)
  return tuts.length > 0 && tuts.every(itemDone)
}

function progressPercent(track: AppSpaceTrack): number {
  const tuts = hasSegments(track) ? segmentTutorials(track) : tutorialItems(track)
  if (tuts.length === 0) return 0
  return Math.round((completedCount(track) / tuts.length) * 100)
}

// Per-item unlock. Prefers the server flag (set on every segment item by
// annotateUnlocked). Segment items always carry `unlocked`; fall back to the
// shared gating helper (single-item array) only for the defensive case where
// the flag is missing.
function isSegmentItemUnlocked(item: AppSpaceItem): boolean {
  if (typeof item.unlocked === 'boolean') return item.unlocked
  return _isItemUnlocked([item as unknown as GatingItem], 0)
}

// A TUTORIAL's link stays live if it's a redo (#2866) or unlocked.
function isSegmentTutorialOpenable(item: AppSpaceItem): boolean {
  if (item.type !== 'TUTORIAL') return false
  if (item.status === 'COMPLETED_OUT_OF_WINDOW') return true
  return isSegmentItemUnlocked(item)
}

function segmentItemStatusClass(item: AppSpaceItem): string {
  if (item.status === 'COMPLETED') return 'step--completed'
  if (item.status === 'COMPLETED_OUT_OF_WINDOW') return 'step--redo'
  if (item.status === 'EARNED') return 'step--earned'
  if (item.status === 'IN_PROGRESS') return 'step--in-progress'
  if (isSegmentItemUnlocked(item)) return 'step--available'
  return 'step--locked'
}

function handleSegmentItemClick(item: AppSpaceItem) {
  if (item.type === 'TUTORIAL' && isSegmentTutorialOpenable(item) && item.url) {
    window.open(item.url, '_blank')
  }
}

// Barcode parity (#2887): the synthetic lane-end CHECKPOINT (prizeId) and a
// normal downstream CHECKPOINT flow through the exact same predicate — it keys
// only on type==='CHECKPOINT' && unlocked && authenticated.
function shouldShowSegmentBarcode(item: AppSpaceItem): boolean {
  return _shouldShowCheckpointBarcode(item, isSegmentItemUnlocked(item), authenticated.value)
}

function isItemUnlocked(track: AppSpaceTrack, index: number): boolean {
  return _isItemUnlocked(track.items, index)
}

// #2866: thin wrapper over the extracted gating helper; keeps a redo
// (COMPLETED_OUT_OF_WINDOW) tutorial's link live without letting it advance the
// track or unlock the prize. See app-space-gating.ts.
function isTutorialOpenable(track: AppSpaceTrack, index: number): boolean {
  return _isTutorialOpenable(track.items, index)
}

function itemStatusClass(track: AppSpaceTrack, index: number): string {
  const item = track.items[index]
  if (item.status === 'COMPLETED') return 'step--completed'
  // #2866: completed before/after the event window — distinct "redo" state.
  // Does NOT count toward the track or unlock the prize (gating is strict === 'COMPLETED').
  if (item.status === 'COMPLETED_OUT_OF_WINDOW') return 'step--redo'
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

// Start the deliberate sign-in flow — same destination as the shellbar profile
// click in hugo/layouts/partials/header.html: the /signin IdP chooser, carrying
// a safe relative returnTo so the user lands back on this page after auth.
function startLogin() {
  const returnTo = window.location.pathname + window.location.search
  window.location.href = '/signin?returnTo=' + encodeURIComponent(returnTo)
}

function handleItemClick(track: AppSpaceTrack, index: number, item: AppSpaceItem) {
  if (item.type === 'TUTORIAL' && isTutorialOpenable(track, index) && item.url) {
    window.open(item.url, '_blank')
  }
}

function checkpointBarcodeUrl(): string {
  return _checkpointBarcodeUrl(eventId.value)
}

function shouldShowCheckpointBarcode(track: AppSpaceTrack, index: number): boolean {
  return _shouldShowCheckpointBarcode(track.items[index], isItemUnlocked(track, index), authenticated.value)
}

// ── Computed ───────────────────────────────────────────────────────
const totalTutorials = computed(() =>
  tracks.value.reduce((sum, t) => sum + (hasSegments(t) ? segmentTutorials(t).length : tutorialItems(t).length), 0)
)

const totalCompleted = computed(() =>
  tracks.value.reduce((sum, t) => sum + completedCount(t), 0)
)

const completedTracks = computed(() =>
  tracks.value.filter(isTrackComplete).length
)

// Message for the empty state shown when no tracks resolve for the event.
// Distinguishes a mission-less / not-found event (from the API error) from a
// generic "nothing yet" so the visitor isn't left staring at the default hero.
const emptyStateMessage = computed(() => {
  const msg = loadError.value
  if (/no mission configured/i.test(msg)) {
    return 'This event doesn’t have a mission with tracks configured yet. Once a mission is linked to the event, its tracks will appear here.'
  }
  if (/not found/i.test(msg)) {
    return 'We couldn’t find that event. Check the event ID in the link, or come back once it’s set up.'
  }
  return 'There are no tracks to show for this event yet. Please check back soon.'
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
          <img
            v-if="!loading && logoUrl"
            class="hero-logo"
            :src="logoUrl"
            :alt="eventName + ' logo'"
          />
          <!-- #2314: hold the real event name/description until the event resolves.
               Rendering the computed default ('SAP TechEd') on mount caused a flash
               of the wrong event before the URL eventId loaded. Skeleton keeps the
               layout stable and avoids the swap. -->
          <template v-if="!loading">
            <h1 class="hero-title">{{ eventName }}</h1>
            <p class="hero-subtitle">Developer Garage &mdash; Agent Lab &mdash; App Space</p>
            <!-- #2296: eventDescription is server-rendered Markdown → safe HTML
                 (markdown-it html:false escapes raw HTML). Block element, not <p>,
                 because markdown emits its own <p> and <p>-in-<p> is invalid. -->
            <div class="hero-desc" v-html="eventDescription"></div>
          </template>
          <template v-else>
            <div class="hero-title-skeleton" aria-hidden="true"></div>
            <p class="hero-subtitle">Developer Garage &mdash; Agent Lab &mdash; App Space</p>
          </template>
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
          <!-- Step 1 is a live sign-in affordance while anonymous: starts the
               same flow as the shellbar profile click (→ /signin chooser). Once
               logged in it reverts to a passive label. -->
          <a
            v-if="i === 0 && !isLoggedIn"
            class="instruction-text instruction-text--login"
            href="#"
            @click.prevent="startLogin()"
          >{{ step.text }}</a>
          <span v-else class="instruction-text">{{ step.text }}</span>
        </div>
      </div>
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

    <!-- ── Empty / not-configured state ───────────────────── -->
    <div class="content-area" v-else-if="!selectedTrack && tracks.length === 0">
      <div class="empty-state">
        <svg class="empty-state__icon" width="56" height="56" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <rect x="3" y="4" width="18" height="16" rx="2" stroke="currentColor" stroke-width="1.5"/>
          <path d="M3 9h18M8 14h8M8 17h5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
        </svg>
        <h2 class="empty-state__title">No tracks configured yet</h2>
        <p class="empty-state__desc">{{ emptyStateMessage }}</p>
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
            <span class="track-card__count">{{ trackTutorialCount(track) }} tutorials</span>
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
          <span class="detail-progress">{{ completedCount(selectedTrack) }} / {{ trackTutorialCount(selectedTrack) }} completed</span>
        </div>
        <p class="detail-desc">{{ selectedTrack.description }}</p>
      </div>

      <!-- ── Segment timeline (#2887) ──────────────────────────────
           Renders from selectedTrack.segments: linear nodes, side-by-side fork
           lanes with fork/join connectors, and any-order clusters. Falls back
           to the legacy flat timeline for payloads without segments. -->
      <div class="timeline" v-if="hasSegments(selectedTrack)" :style="{ '--max-lanes': maxLaneCount(selectedTrack) }">
        <template v-for="(seg, segIndex) in trackSegments(selectedTrack)" :key="seg.order">

          <!-- Linear segment: one node per item (as today) -->
          <template v-if="seg.kind === 'linear'">
            <div
              v-for="item in seg.items"
              :key="item.imsId ?? item.title"
              class="timeline-item"
              :class="[segmentItemStatusClass(item), `timeline-item--${item.type.toLowerCase()}`]"
            >
              <div class="timeline-line" v-if="segIndex < trackSegments(selectedTrack).length - 1"></div>
              <div
                class="timeline-bubble"
                @click="handleSegmentItemClick(item)"
                :class="{ clickable: item.type === 'TUTORIAL' && isSegmentTutorialOpenable(item) }"
              >
                <svg v-if="!isSegmentItemUnlocked(item) && item.status !== 'COMPLETED' && item.status !== 'EARNED' && item.status !== 'COMPLETED_OUT_OF_WINDOW'"
                  width="18" height="18" viewBox="0 0 24 24" fill="none">
                  <rect x="3" y="11" width="18" height="11" rx="2" stroke="currentColor" stroke-width="2"/>
                  <path d="M7 11V7a5 5 0 0 1 10 0v4" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
                </svg>
                <svg v-else-if="item.status === 'COMPLETED'" width="18" height="18" viewBox="0 0 24 24" fill="none">
                  <path d="M5 13l4 4L19 7" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
                </svg>
                <svg v-else-if="item.status === 'COMPLETED_OUT_OF_WINDOW'" width="18" height="18" viewBox="0 0 24 24" fill="none">
                  <path d="M3 12a9 9 0 0 1 15-6.7L21 8M21 3v5h-5M21 12a9 9 0 0 1-15 6.7L3 16M3 21v-5h5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                </svg>
                <svg v-else-if="item.type === 'PRIZE' || item.type === 'CHECKPOINT'" width="18" height="18" viewBox="0 0 24 24" fill="none">
                  <path d="M8 21h8M12 17v4M7 4h10M7 4V3h10v1M7 4H5a2 2 0 0 0 0 4h2M17 4h2a2 2 0 0 1 0 4h-2M7 8c0 3 2 5 5 5s5-2 5-5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
                </svg>
                <span v-else-if="item.status === 'IN_PROGRESS'" class="bubble-progress">{{ item.progress }}%</span>
                <span v-else class="bubble-number">{{ segIndex + 1 }}</span>
              </div>
              <div class="timeline-content">
                <div class="timeline-content__header">
                  <span class="item-type-label" :class="`item-type--${item.type.toLowerCase()}`">
                    {{ item.type === 'TUTORIAL' ? 'Tutorial' : item.type === 'CHECKPOINT' ? 'Checkpoint' : 'Prize' }}
                  </span>
                  <span v-if="item.experience" class="item-experience">{{ item.experience }}</span>
                  <span v-if="item.timeToComplete > 0" class="item-time">{{ formatTime(item.timeToComplete) }}</span>
                </div>
                <h4 class="timeline-content__title"
                  :class="{ clickable: item.type === 'TUTORIAL' && isSegmentTutorialOpenable(item) }"
                  @click="handleSegmentItemClick(item)"
                >{{ item.title }}</h4>
                <p class="timeline-content__desc" v-if="item.description && item.type !== 'PRIZE'">{{ item.description }}</p>
                <p class="redo-hint" v-if="item.status === 'COMPLETED_OUT_OF_WINDOW'">
                  Completed before the event — reset your progress and complete it again during the event to earn your prize.
                </p>
                <div v-if="shouldShowSegmentBarcode(item)" class="checkpoint-barcode">
                  <img :src="checkpointBarcodeUrl()" alt="Prize barcode" class="checkpoint-barcode__img" width="150" height="150" />
                  <p class="checkpoint-barcode__caption">Show this to an instructor to claim your prize.</p>
                </div>
                <p v-else-if="item.type === 'CHECKPOINT' && isSegmentItemUnlocked(item) && !authenticated" class="checkpoint-signin-hint">
                  <a href="#" @click.prevent="startLogin">Sign in</a> to get your prize code.
                </p>
                <div v-if="(item.type === 'PRIZE' || item.type === 'CHECKPOINT') && !isSegmentItemUnlocked(item) && item.status !== 'EARNED'" class="prize-locked">
                  <p class="prize-locked__text">Complete the required tutorials to unlock your prize.</p>
                </div>
              </div>
            </div>
          </template>

          <!-- parallel-any cluster: grid of cards, all available once unlocked -->
          <template v-else-if="seg.kind === 'parallel-any'">
            <div class="cluster-wrap">
              <div class="cluster-header">Complete these in any order</div>
              <div class="cluster">
                <div
                  v-for="item in seg.items"
                  :key="item.imsId ?? item.title"
                  class="timeline-item timeline-item--cluster"
                  :class="[segmentItemStatusClass(item), `timeline-item--${item.type.toLowerCase()}`]"
                >
                  <div
                    class="timeline-bubble"
                    @click="handleSegmentItemClick(item)"
                    :class="{ clickable: item.type === 'TUTORIAL' && isSegmentTutorialOpenable(item) }"
                  >
                    <svg v-if="!isSegmentItemUnlocked(item) && item.status !== 'COMPLETED' && item.status !== 'EARNED' && item.status !== 'COMPLETED_OUT_OF_WINDOW'"
                      width="18" height="18" viewBox="0 0 24 24" fill="none">
                      <rect x="3" y="11" width="18" height="11" rx="2" stroke="currentColor" stroke-width="2"/>
                      <path d="M7 11V7a5 5 0 0 1 10 0v4" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
                    </svg>
                    <svg v-else-if="item.status === 'COMPLETED'" width="18" height="18" viewBox="0 0 24 24" fill="none">
                      <path d="M5 13l4 4L19 7" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
                    </svg>
                    <svg v-else-if="item.status === 'COMPLETED_OUT_OF_WINDOW'" width="18" height="18" viewBox="0 0 24 24" fill="none">
                      <path d="M3 12a9 9 0 0 1 15-6.7L21 8M21 3v5h-5M21 12a9 9 0 0 1-15 6.7L3 16M3 21v-5h5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                    </svg>
                    <svg v-else-if="item.type === 'PRIZE' || item.type === 'CHECKPOINT'" width="18" height="18" viewBox="0 0 24 24" fill="none">
                      <path d="M8 21h8M12 17v4M7 4h10M7 4V3h10v1M7 4H5a2 2 0 0 0 0 4h2M17 4h2a2 2 0 0 1 0 4h-2M7 8c0 3 2 5 5 5s5-2 5-5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
                    </svg>
                    <span v-else-if="item.status === 'IN_PROGRESS'" class="bubble-progress">{{ item.progress }}%</span>
                    <span v-else class="bubble-dot">&bull;</span>
                  </div>
                  <div class="timeline-content">
                    <div class="timeline-content__header">
                      <span class="item-type-label" :class="`item-type--${item.type.toLowerCase()}`">
                        {{ item.type === 'TUTORIAL' ? 'Tutorial' : item.type === 'CHECKPOINT' ? 'Checkpoint' : 'Prize' }}
                      </span>
                      <span v-if="item.experience" class="item-experience">{{ item.experience }}</span>
                      <span v-if="item.timeToComplete > 0" class="item-time">{{ formatTime(item.timeToComplete) }}</span>
                    </div>
                    <h4 class="timeline-content__title"
                      :class="{ clickable: item.type === 'TUTORIAL' && isSegmentTutorialOpenable(item) }"
                      @click="handleSegmentItemClick(item)"
                    >{{ item.title }}</h4>
                    <p class="timeline-content__desc" v-if="item.description && item.type !== 'PRIZE'">{{ item.description }}</p>
                    <p class="redo-hint" v-if="item.status === 'COMPLETED_OUT_OF_WINDOW'">
                      Completed before the event — reset your progress and complete it again during the event to earn your prize.
                    </p>
                    <div v-if="shouldShowSegmentBarcode(item)" class="checkpoint-barcode">
                      <img :src="checkpointBarcodeUrl()" alt="Prize barcode" class="checkpoint-barcode__img" width="150" height="150" />
                      <p class="checkpoint-barcode__caption">Show this to an instructor to claim your prize.</p>
                    </div>
                    <p v-else-if="item.type === 'CHECKPOINT' && isSegmentItemUnlocked(item) && !authenticated" class="checkpoint-signin-hint">
                      <a href="#" @click.prevent="startLogin">Sign in</a> to get your prize code.
                    </p>
                  </div>
                </div>
              </div>
            </div>
          </template>

          <!-- fork: side-by-side labeled lanes with fork/join connectors -->
          <template v-else>
            <div class="fork-connector" aria-hidden="true">
              <span class="fork-connector__stem"></span>
              <!-- #2896 follow-up: bar starts at the STEM (backbone bubble center,
                   1.175rem) not at lane-0's bubble, so the vertical stem and the
                   horizontal bar connect instead of leaving a ~10px jog. -->
              <span
                class="fork-connector__bar"
                :style="{ left: '1.175rem', right: `calc(100% - (${laneBubbleLeft(seg.lanes.length - 1, seg.lanes.length)}))` }"
              ></span>
              <span
                v-for="(lane, li) in seg.lanes"
                :key="'fd-' + li"
                class="fork-connector__drop"
                :style="{ left: laneBubbleLeft(li, seg.lanes.length) }"
              ></span>
            </div>
            <div class="lanes" :style="{ '--lane-count': seg.lanes.length }">
              <div
                v-for="(lane, li) in seg.lanes"
                :key="'lane-' + li"
                class="lane"
                :class="{ 'lane--unavailable': laneUnavailable(lane), 'lane--complete': laneTutorialsDone(lane) }"
              >
                <div class="lane__label">
                  <span class="lane__name">{{ lane.label }}</span>
                  <span class="lane__badge">Branch</span>
                </div>
                <p v-if="laneUnavailable(lane)" class="lane__unavailable-note">
                  Temporarily unavailable — check back soon.
                </p>
                <div
                  v-for="(item, ii) in lane.items"
                  :key="item.imsId ?? (item.prizeId != null ? 'prize-' + item.prizeId : item.title)"
                  class="timeline-item lane__step"
                  :class="[segmentItemStatusClass(item), `timeline-item--${item.type.toLowerCase()}`]"
                >
                  <div class="timeline-line" v-if="ii < lane.items.length - 1"></div>
                  <div
                    class="timeline-bubble"
                    @click="handleSegmentItemClick(item)"
                    :class="{ clickable: item.type === 'TUTORIAL' && isSegmentTutorialOpenable(item) }"
                  >
                    <svg v-if="!isSegmentItemUnlocked(item) && item.status !== 'COMPLETED' && item.status !== 'EARNED' && item.status !== 'COMPLETED_OUT_OF_WINDOW'"
                      width="18" height="18" viewBox="0 0 24 24" fill="none">
                      <rect x="3" y="11" width="18" height="11" rx="2" stroke="currentColor" stroke-width="2"/>
                      <path d="M7 11V7a5 5 0 0 1 10 0v4" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
                    </svg>
                    <svg v-else-if="item.status === 'COMPLETED'" width="18" height="18" viewBox="0 0 24 24" fill="none">
                      <path d="M5 13l4 4L19 7" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
                    </svg>
                    <svg v-else-if="item.status === 'COMPLETED_OUT_OF_WINDOW'" width="18" height="18" viewBox="0 0 24 24" fill="none">
                      <path d="M3 12a9 9 0 0 1 15-6.7L21 8M21 3v5h-5M21 12a9 9 0 0 1-15 6.7L3 16M3 21v-5h5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                    </svg>
                    <svg v-else-if="item.type === 'PRIZE' || item.type === 'CHECKPOINT'" width="18" height="18" viewBox="0 0 24 24" fill="none">
                      <path d="M8 21h8M12 17v4M7 4h10M7 4V3h10v1M7 4H5a2 2 0 0 0 0 4h2M17 4h2a2 2 0 0 1 0 4h-2M7 8c0 3 2 5 5 5s5-2 5-5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
                    </svg>
                    <span v-else-if="item.status === 'IN_PROGRESS'" class="bubble-progress">{{ item.progress }}%</span>
                    <span v-else class="bubble-number">{{ ii + 1 }}</span>
                  </div>
                  <div class="timeline-content">
                    <div class="timeline-content__header">
                      <span class="item-type-label" :class="`item-type--${item.type.toLowerCase()}`">
                        {{ item.type === 'TUTORIAL' ? 'Tutorial' : item.type === 'CHECKPOINT' ? 'Checkpoint' : 'Prize' }}
                      </span>
                      <span v-if="item.experience" class="item-experience">{{ item.experience }}</span>
                      <span v-if="item.timeToComplete > 0" class="item-time">{{ formatTime(item.timeToComplete) }}</span>
                    </div>
                    <h4 class="timeline-content__title"
                      :class="{ clickable: item.type === 'TUTORIAL' && isSegmentTutorialOpenable(item) }"
                      @click="handleSegmentItemClick(item)"
                    >{{ item.title }}</h4>
                    <p class="timeline-content__desc" v-if="item.description && item.type !== 'PRIZE'">{{ item.description }}</p>
                    <p class="redo-hint" v-if="item.status === 'COMPLETED_OUT_OF_WINDOW'">
                      Completed before the event — reset your progress and complete it again during the event to earn your prize.
                    </p>
                    <div v-if="shouldShowSegmentBarcode(item)" class="checkpoint-barcode">
                      <img :src="checkpointBarcodeUrl()" alt="Prize barcode" class="checkpoint-barcode__img" width="150" height="150" />
                      <p class="checkpoint-barcode__caption">Show this to an instructor to claim your prize.</p>
                    </div>
                    <p v-else-if="item.type === 'CHECKPOINT' && isSegmentItemUnlocked(item) && !authenticated" class="checkpoint-signin-hint">
                      <a href="#" @click.prevent="startLogin">Sign in</a> to get your prize code.
                    </p>
                    <div v-if="(item.type === 'PRIZE' || item.type === 'CHECKPOINT') && !isSegmentItemUnlocked(item) && item.status !== 'EARNED'" class="prize-locked">
                      <p class="prize-locked__text">Complete this branch's tutorials to unlock your prize.</p>
                    </div>
                  </div>
                </div>
              </div>
            </div>
            <!-- join connector into the next segment, if one exists -->
            <div
              class="join-connector"
              aria-hidden="true"
              v-if="segIndex < trackSegments(selectedTrack).length - 1"
              :style="{ '--lane-count': seg.lanes.length }"
            >
              <span
                v-for="(lane, li) in seg.lanes"
                :key="'ju-' + li"
                class="join-connector__up"
                :style="{ left: laneBubbleLeft(li, seg.lanes.length) }"
              ></span>
              <!-- #2896 follow-up: bar reaches the down-stem (1.175rem) so the
                   join bar and the single stem into the next segment connect. -->
              <span
                class="join-connector__bar"
                :style="{ left: '1.175rem', right: `calc(100% - (${laneBubbleLeft(seg.lanes.length - 1, seg.lanes.length)}))` }"
              ></span>
              <span class="join-connector__down"></span>
            </div>
          </template>

        </template>
      </div>

      <!-- ── Legacy flat timeline (payloads without segments) ────── -->
      <div class="timeline" v-else>
        <div
          v-for="(item, index) in selectedTrack.items"
          :key="item.imsId ?? index"
          class="timeline-item"
          :class="[
            itemStatusClass(selectedTrack, index),
            `timeline-item--${item.type.toLowerCase()}`,
            { 'timeline-item--unavailable': item.temporarilyUnavailable }
          ]"
        >
          <!-- Connecting line -->
          <div class="timeline-line" v-if="index < selectedTrack.items.length - 1"></div>

          <!-- Step bubble -->
          <div
            class="timeline-bubble"
            @click="handleItemClick(selectedTrack, index, item)"
            :class="{ clickable: item.type === 'TUTORIAL' && isTutorialOpenable(selectedTrack, index) }"
          >
            <!-- Locked icon -->
            <svg v-if="!isItemUnlocked(selectedTrack, index) && item.status !== 'COMPLETED' && item.status !== 'EARNED' && item.status !== 'COMPLETED_OUT_OF_WINDOW'"
              width="18" height="18" viewBox="0 0 24 24" fill="none">
              <rect x="3" y="11" width="18" height="11" rx="2" stroke="currentColor" stroke-width="2"/>
              <path d="M7 11V7a5 5 0 0 1 10 0v4" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
            </svg>
            <!-- Completed check -->
            <svg v-else-if="item.status === 'COMPLETED'"
              width="18" height="18" viewBox="0 0 24 24" fill="none">
              <path d="M5 13l4 4L19 7" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
            </svg>
            <!-- #2866: completed outside the event window — redo (refresh arrows) -->
            <svg v-else-if="item.status === 'COMPLETED_OUT_OF_WINDOW'"
              width="18" height="18" viewBox="0 0 24 24" fill="none">
              <path d="M3 12a9 9 0 0 1 15-6.7L21 8M21 3v5h-5M21 12a9 9 0 0 1-15 6.7L3 16M3 21v-5h5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
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
              :class="{ clickable: item.type === 'TUTORIAL' && isTutorialOpenable(selectedTrack, index) }"
              @click="handleItemClick(selectedTrack, index, item)"
            >{{ item.title }}</h4>
            <!-- #2864: path item temporarily disabled by an admin — badge it,
                 and (via isTutorialOpenable) the title/bubble are no longer
                 clickable. Reason, when authored, shows below the badge. -->
            <div class="item-unavailable" v-if="item.temporarilyUnavailable">
              <span class="item-unavailable__badge">Temporarily Unavailable</span>
              <span class="item-unavailable__reason" v-if="item.unavailableReason">{{ item.unavailableReason }}</span>
            </div>
            <p class="timeline-content__desc" v-if="item.description && item.type !== 'PRIZE'">{{ item.description }}</p>
            <!-- #2866: completed before/after the event — doesn't count; prompt a redo during the event. -->
            <p class="redo-hint" v-if="item.status === 'COMPLETED_OUT_OF_WINDOW'">
              Completed before the event — reset your progress and complete it again during the event to earn your prize.
            </p>

            <!-- Checkpoint prize barcode — shown only when track is complete AND authenticated -->
            <div v-if="shouldShowCheckpointBarcode(selectedTrack, index)" class="checkpoint-barcode">
              <img
                :src="checkpointBarcodeUrl()"
                alt="Prize barcode"
                class="checkpoint-barcode__img"
                width="150"
                height="150"
              />
              <p class="checkpoint-barcode__caption">Show this to an instructor to claim your prize.</p>
            </div>

            <!-- Sign-in hint shown when track is complete but user is not authenticated -->
            <p
              v-else-if="item.type === 'CHECKPOINT' && isItemUnlocked(selectedTrack, index) && !authenticated"
              class="checkpoint-signin-hint"
            >
              <a href="#" @click.prevent="startLogin">Sign in</a> to get your prize code.
            </p>

            <!-- Locked prize message -->
            <div v-if="item.type === 'PRIZE' && !isItemUnlocked(selectedTrack, index) && item.status !== 'EARNED'" class="prize-locked">
              <p class="prize-locked__text">Complete all tutorials to unlock your prize.</p>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>

  <!-- Confetti overlay -->
  <div v-if="confettiActive" class="confetti-overlay" aria-hidden="true">
    <span
      v-for="p in particles"
      :key="p.id"
      class="confetti-particle"
      :style="{ left: p.x + '%', animationDelay: p.delay + 's', backgroundColor: p.color }"
    />
  </div>

  <!-- Toast notification -->
  <Transition name="toast-slide">
    <div v-if="toastVisible" class="toast-notification" role="status" aria-live="polite">
      {{ toastMessage }}
    </div>
  </Transition>
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

.hero-logo {
  max-height: 72px;
  max-width: min(70%, 360px);
  width: auto;
  height: auto;
  object-fit: contain;
  margin: 0 0 1rem;
  display: block;
}

.hero-title {
  font-size: 2rem;
  font-weight: 700;
  margin: 0 0 0.25rem;
  letter-spacing: -0.02em;
}

/* #2314: placeholder while the event resolves — matches .hero-title's height so
   the hero doesn't jump when the real name swaps in. */
.hero-title-skeleton {
  height: 2.5rem;
  width: min(60%, 20rem);
  margin: 0 0 0.25rem;
  border-radius: 0.375rem;
  background: rgba(255, 255, 255, 0.18);
  animation: pulse 1.5s ease-in-out infinite;
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
/* Markdown wraps text in its own block tags — collapse their outer margins so a
   single-paragraph description reads like the previous plain-text line (#2296).
   :deep() needed: v-html children carry no scoped-style attribute. */
.hero-desc :deep(:first-child) { margin-top: 0; }
.hero-desc :deep(:last-child) { margin-bottom: 0; }

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

/* Step 1 as a sign-in link while anonymous — inherits the hero's light text on
   its dark background rather than a clashing default link color. */
.instruction-text--login {
  color: inherit;
  text-decoration: underline;
  text-underline-offset: 2px;
  cursor: pointer;
}
.instruction-text--login:hover,
.instruction-text--login:focus-visible {
  opacity: 1;
  text-decoration-thickness: 2px;
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

/* ── Empty / not-configured state ──────────────────────── */
.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
  gap: 0.75rem;
  padding: 3rem 1.5rem;
  max-width: 32rem;
  margin: 1.5rem auto 0;
  color: var(--sapContent_LabelColor, #556b82);
}

.empty-state__icon {
  color: var(--sapContent_NonInteractiveIconColor, #a9b4be);
}

.empty-state__title {
  font-size: 1.125rem;
  font-weight: 700;
  margin: 0;
  color: var(--sapTextColor, #32363a);
}

.empty-state__desc {
  font-size: 0.875rem;
  margin: 0;
  line-height: 1.5;
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
  /* Single-column (linear/cluster) tracks stay at the readable 740px cap.
     Multi-lane forks widen to ~280px per lane so lane cards don't squish
     (#2887 follow-up) — clamped by the 1200px .content-area parent. */
  max-width: max(740px, calc(var(--max-lanes, 1) * 280px));
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

/* #2866: completed outside the event window — distinct "redo" state (critical/amber). */
.step--redo .timeline-bubble {
  border-color: var(--sapCriticalColor, #e76500);
  background: var(--sapCriticalBackground, #fef7f1);
  color: var(--sapCriticalColor, #e76500);
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

.step--redo .timeline-content {
  border-left: 3px solid var(--sapCriticalColor, #e76500);
}

.redo-hint {
  margin: 0.375rem 0 0;
  font-size: 0.8125rem;
  line-height: 1.35;
  color: var(--sapCriticalColor, #e76500);
}

/* #2864: path item temporarily disabled by an admin. Greyed + delinked (the
   title/bubble lose their .clickable via isTutorialOpenable), with a badge
   mirroring the mission-page "Temporarily Unavailable" treatment. */
.timeline-item--unavailable .timeline-content {
  opacity: 0.6;
}
.timeline-item--unavailable .timeline-content__title {
  cursor: default;
  text-decoration: none;
}
.item-unavailable {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
  margin: 0.375rem 0 0;
}
.item-unavailable__badge {
  align-self: flex-start;
  padding: 0.125rem 0.5rem;
  border-radius: 0.75rem;
  font-size: 0.75rem;
  font-weight: 600;
  line-height: 1.4;
  color: var(--sapNeutralTextColor, #5b738b);
  background: var(--sapNeutralBackground, #eaecee);
  border: 1px solid var(--sapNeutralBorderColor, #a9b4be);
}
.item-unavailable__reason {
  font-size: 0.8125rem;
  line-height: 1.35;
  color: var(--sapContent_LabelColor, #556b82);
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

/* ── Segment renderer: fork lanes + any-order clusters (#2887) ───────── */

/* Any-order cluster: grid of cards, all available at once. */
.cluster-wrap {
  margin: 0 0 0.75rem;
}

.cluster-header {
  font-size: 0.6875rem;
  font-weight: 700;
  letter-spacing: 0.03em;
  text-transform: uppercase;
  color: var(--sapContent_LabelColor, #556b82);
  margin: 0.25rem 0 0.4rem 0.79rem;
}

.cluster {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 0.6rem;
  border: 1px dashed var(--sapGroup_ContentBorderColor, #c5cfda);
  border-radius: 0.5rem;
  padding: 0.75rem;
  background: rgba(16, 126, 62, 0.02);
}

/* Cluster cards drop the vertical connecting stem — they're parallel. */
.timeline-item--cluster {
  padding-bottom: 0;
}

/* Fork lanes: side-by-side columns. */
.lanes {
  display: grid;
  grid-template-columns: repeat(var(--lane-count, 2), 1fr);
  gap: 1rem;
  margin-bottom: 0.2rem;
}

.lane {
  border: 1px dashed var(--sapGroup_ContentBorderColor, #c5cfda);
  border-radius: 0.5rem;
  padding: 0.6rem;
  background: rgba(0, 112, 242, 0.015);
  min-width: 0;
}

.lane--complete {
  border-color: var(--sapPositiveColor, #107e3e);
  background: rgba(16, 126, 62, 0.03);
}

/* #2887 cross-task note — temporarily-unavailable branch surfacing (UI-only). */
.lane--unavailable {
  opacity: 0.6;
  filter: grayscale(0.4);
}

.lane__label {
  font-size: 0.7rem;
  font-weight: 700;
  letter-spacing: 0.03em;
  text-transform: uppercase;
  color: var(--sapTextColor, #32363a);
  margin-bottom: 0.5rem;
  display: flex;
  align-items: center;
  gap: 0.4rem;
}

.lane__badge {
  font-size: 0.6rem;
  color: var(--sapAccentColor8, #6c32a9);
  background: rgba(108, 50, 169, 0.08);
  padding: 0.1rem 0.35rem;
  border-radius: 0.25rem;
  text-transform: none;
  letter-spacing: 0;
}

.lane__unavailable-note {
  font-size: 0.72rem;
  color: var(--sapCriticalColor, #e76500);
  margin: 0 0 0.5rem;
}

.lane__step {
  padding-bottom: 0.5rem;
}

.lane__step:last-child {
  padding-bottom: 0;
}

/* Fork connector: stem from the backbone, a horizontal bar, drops to each lane.
   #2896: origin matches .lanes (no left margin) so per-lane drop offsets computed
   from the grid line up with each lane's bubble center. */
.fork-connector {
  position: relative;
  height: 1.6rem;
  margin: 0.2rem 0;
}
.fork-connector__stem {
  position: absolute;
  top: 0;
  left: 1.175rem;
  width: 2px;
  height: 0.8rem;
  background: var(--sapNeutralBorderColor, #d9d9d9);
}
.fork-connector__bar {
  position: absolute;
  top: 0.8rem;
  height: 2px;
  background: var(--sapNeutralBorderColor, #d9d9d9);
}
.fork-connector__drop {
  position: absolute;
  top: 0.8rem;
  width: 2px;
  height: 0.8rem;
  background: var(--sapNeutralBorderColor, #d9d9d9);
}

/* Join connector: drops up from each lane into a bar, then a single stem down
   into the next segment. */
.join-connector {
  position: relative;
  height: 1.4rem;
  margin: 0.2rem 0;
}
.join-connector__up {
  position: absolute;
  bottom: 0.6rem;
  width: 2px;
  height: 0.8rem;
  background: var(--sapNeutralBorderColor, #d9d9d9);
}
.join-connector__bar {
  position: absolute;
  bottom: 0.6rem;
  height: 2px;
  background: var(--sapNeutralBorderColor, #d9d9d9);
}
.join-connector__down {
  position: absolute;
  bottom: 0;
  left: 1.175rem;
  width: 2px;
  height: 0.6rem;
  background: var(--sapNeutralBorderColor, #d9d9d9);
}

/* Dot bubble for any-order cluster cards (no sequential number). */
.bubble-dot {
  font-size: 1rem;
  line-height: 1;
}

/* Responsive: collapse lanes to stacked labeled blocks + cluster to 1 col. */
@media (max-width: 680px) {
  .lanes {
    grid-template-columns: 1fr;
  }
  .cluster {
    grid-template-columns: 1fr;
  }
  /* Connectors are a desktop affordance; hide the horizontal split on stacked
     lanes where columns no longer sit side by side. */
  .fork-connector__bar,
  .fork-connector__drop,
  .join-connector__up,
  .join-connector__bar {
    display: none;
  }
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
   Themed heroes — text colour (#2839)
   The Joule/Sapphire hero gradients are dark in both light AND dark mode,
   but the base .hero only inherits --sapShell_TextColor, which resolves to
   a DARK value in the Horizon light theme → near-illegible banner text on
   the purple/blue gradient. Pin white here (and on the skeleton) so the
   themed hero reads correctly regardless of the active Horizon palette.
   ═══════════════════════════════════════════════════════════════════ */

.app-space[data-theme="joule"] .hero,
.app-space[data-theme="sapphire"] .hero {
  color: #fff;
}

.app-space[data-theme="joule"] .hero-title-skeleton,
.app-space[data-theme="sapphire"] .hero-title-skeleton {
  background: rgba(255, 255, 255, 0.18);
}

/* ═══════════════════════════════════════════════════════════════════
   Joule Theme — Light Mode
   ═══════════════════════════════════════════════════════════════════ */

.app-space[data-theme="joule"] .hero {
  background: linear-gradient(135deg, #5D36FF 0%, #A100C2 100%);
}

.app-space[data-theme="joule"] .stat-card {
  background: rgba(255, 255, 255, 0.14);
  border-color: rgba(255, 255, 255, 0.22);
}

.app-space[data-theme="joule"] .instruction-icon {
  background: rgba(255, 255, 255, 0.22);
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
  background: linear-gradient(135deg, #3A1F99 0%, #660079 100%);
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

/* ── Confetti overlay ───────────────────────────────────────────── */
.confetti-overlay {
  position: fixed;
  inset: 0;
  pointer-events: none;
  z-index: 9999;
  overflow: hidden;
}

.confetti-particle {
  position: absolute;
  top: -10px;
  width: 8px;
  height: 8px;
  border-radius: 2px;
  animation: confetti-fall 3.5s ease-in forwards;
}

@keyframes confetti-fall {
  0% { transform: translateY(0) rotate(0deg); opacity: 1; }
  100% { transform: translateY(100vh) rotate(720deg); opacity: 0; }
}

/* ── Toast notification ─────────────────────────────────────────── */
.toast-notification {
  position: fixed;
  bottom: 1.5rem;
  left: 50%;
  transform: translateX(-50%);
  background: var(--sapInformationBackground, #e8f0fe);
  color: var(--sapTextColor, #32363a);
  border: 1px solid var(--sapInformationBorderColor, #0854a0);
  border-radius: 0.5rem;
  padding: 0.75rem 1.5rem;
  font-size: 0.875rem;
  font-weight: 600;
  z-index: 10000;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
}

.toast-slide-enter-active,
.toast-slide-leave-active {
  transition: opacity 0.3s, transform 0.3s;
}

.toast-slide-enter-from,
.toast-slide-leave-to {
  opacity: 0;
  transform: translateX(-50%) translateY(1rem);
}

/* ── Badge glow animation ───────────────────────────────────────── */
.badge-glow {
  animation: glow-pulse 0.5s ease-in-out 3;
}

@keyframes glow-pulse {
  0%, 100% { filter: drop-shadow(0 0 0 transparent); }
  50% { filter: drop-shadow(0 0 8px var(--sapPositiveColor, #107e3e)); }
}
</style>
