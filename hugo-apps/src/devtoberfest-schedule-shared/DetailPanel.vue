<script setup lang="ts">
import type { ScheduleRow } from './types';
import { youtubeThumb, safeHref, taskHref, taskLinkLabel } from './completion';
import { youtubeId, youtubeEmbedUrl } from './youtube';
import { formatViewerLocal } from './format-session-time';
import { sessionIcsHref, sessionCalendarHref } from './calendar-links';
import { broadcastingTag } from './broadcasting';
import { renderMarkdown } from '../devtoberfest-shared/render-markdown';
import { computed, ref } from 'vue';

const props = defineProps<{
  row: ScheduleRow | null;
  editionId?: string | null;
}>();

const emit = defineEmits<{
  (e: 'close'): void;
}>();

const expanded = ref(false);

function toggleExpand() {
  expanded.value = !expanded.value;
  try { sessionStorage.setItem('dtf-detail-expanded', expanded.value ? '1' : '0'); } catch {}
}

try { expanded.value = sessionStorage.getItem('dtf-detail-expanded') === '1'; } catch {}

const thumb = computed(() => {
  if (!props.row) return null;
  const r = props.row as any;
  return r.youtubeUrl ? youtubeThumb(r.youtubeUrl) : null;
});

const embedUrl = computed(() => {
  const r = props.row as any;
  const base = r?.youtubeUrl ? youtubeEmbedUrl(r.youtubeUrl) : '';
  return base ? `${base}?enablejsapi=1` : '';
});

const transcript = ref<{ start: number; text: string }[]>([]);
const transcriptSource = ref('');
const transcriptOpen = ref(false);
const transcriptLoaded = ref(false);

async function toggleTranscript() {
  transcriptOpen.value = !transcriptOpen.value;
  if (transcriptOpen.value && !transcriptLoaded.value) {
    const id = youtubeId((props.row as any)?.youtubeUrl || '');
    if (!id) { transcriptLoaded.value = true; return; }
    try {
      const r = await fetch(`/api/devtoberfest/transcript?video=${encodeURIComponent(id)}`);
      const data = await r.json();
      transcript.value = data.segments || [];
      transcriptSource.value = data.source || '';
    } catch { transcript.value = []; }
    transcriptLoaded.value = true;
  }
}

function fmtTs(sec: number) {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

function seekTo(sec: number) {
  const iframe = document.querySelector('iframe.detail-panel__embed') as HTMLIFrameElement | null;
  iframe?.contentWindow?.postMessage(JSON.stringify({ event: 'command', func: 'seekTo', args: [sec, true] }), '*');
}

const taskUrl = computed(() => {
  const r = props.row as any;
  if (!r?.taskSlug) return null;
  return taskHref(r);
});

// DetailPanel's visible link uses Title Case ("Open Tutorial"); the schedule
// table's tooltip uses sentence case ("Open tutorial") via taskLinkLabel.
const taskLinkLabelTitle = computed(() =>
  taskLinkLabel(props.row as any).replace(/\b\w/g, (c) => c.toUpperCase()),
);

const isSession = computed(() => props.row?.kind === 'session');
const isActivity = computed(() => props.row?.kind === 'activity');

// Calendar affordances only make sense for a session that has a start time.
const showCalendar = computed(() => isSession.value && !!(props.row as any)?.scheduledStart);
const icsHref = computed(() => (showCalendar.value ? sessionIcsHref(props.row!.id, props.editionId) : ''));
const googleHref = computed(() => (showCalendar.value ? sessionCalendarHref(props.row!.id, 'google', props.editionId) : ''));
const outlookHref = computed(() => (showCalendar.value ? sessionCalendarHref(props.row!.id, 'outlook', props.editionId) : ''));

function onSpeakerPhotoError(ev: Event) { (ev.target as HTMLImageElement).style.display = 'none'; }

// Abstracts are authored in Markdown; render to sanitized HTML (same
// markdown-it + DOMPurify pipeline as the FAQ/rules islands) so authored
// paragraphs, lists, emphasis and links display instead of collapsing to
// a single run of plain text.
const abstractHtml = computed(() => {
  const raw = (props.row as any)?.abstract;
  return raw ? renderMarkdown(raw) : '';
});

const formatTag = computed(() => broadcastingTag((props.row as any)?.broadcastingPreference));

</script>

<template>
  <div v-if="row" class="detail-panel" role="dialog" aria-modal="true" :aria-label="row.title">
    <div class="detail-panel__backdrop" @click="emit('close')" />
    <div class="detail-panel__drawer" :class="{ 'detail-panel__drawer--wide': expanded }">
      <div class="detail-panel__header">
        <h2 class="detail-panel__title">{{ row.title }}</h2>
        <button class="detail-panel__enlarge" @click="toggleExpand" :aria-pressed="expanded" :aria-label="expanded ? 'Shrink panel' : 'Enlarge panel'">{{ expanded ? '⤡' : '⤢' }}</button>
        <button class="detail-panel__close" @click="emit('close')" aria-label="Close">&#x2715;</button>
      </div>

      <div v-if="embedUrl" class="detail-panel__embed-wrap">
        <iframe class="detail-panel__embed" :src="embedUrl"
          title="Session video" loading="lazy"
          allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
          allowfullscreen referrerpolicy="strict-origin-when-cross-origin"></iframe>
      </div>
      <div v-if="embedUrl" class="detail-panel__transcript-wrap">
        <button class="detail-panel__transcript-toggle" @click="toggleTranscript" :aria-expanded="transcriptOpen">
          {{ transcriptOpen ? 'Hide transcript' : 'Show transcript' }}
        </button>
        <div v-if="transcriptOpen" class="detail-panel__transcript">
          <p v-if="transcriptLoaded && !transcript.length" class="detail-panel__transcript-empty">Transcript not available.</p>
          <p v-if="transcriptSource === 'auto'" class="detail-panel__transcript-tag">auto-generated</p>
          <button v-for="(seg, i) in transcript" :key="i" class="detail-panel__transcript-line" @click="seekTo(seg.start)">
            <span class="detail-panel__transcript-ts">{{ fmtTs(seg.start) }}</span>
            <span>{{ seg.text }}</span>
          </button>
        </div>
      </div>
      <div v-else-if="thumb" class="detail-panel__thumb-wrap">
        <img :src="thumb" :alt="`Thumbnail for ${row.title}`" class="detail-panel__thumb" />
      </div>

      <div class="detail-panel__body">
        <div v-if="(row as any).speakers && (row as any).speakers.length" class="detail-panel__speakers">
          <div v-for="sp in (row as any).speakers" :key="sp.id" class="detail-panel__speaker">
            <img v-if="sp.photoUrl" :src="sp.photoUrl" :alt="sp.name" class="detail-panel__speaker-photo" loading="lazy" @error="onSpeakerPhotoError" />
            <div class="detail-panel__speaker-meta">
              <span class="detail-panel__speaker-name">{{ sp.name }}</span>
              <span v-if="sp.role || sp.company" class="detail-panel__speaker-role">{{ [sp.role, sp.company].filter(Boolean).join(' @ ') }}</span>
            </div>
          </div>
        </div>

        <!-- eslint-disable-next-line vue/no-v-html -- sanitized via DOMPurify in renderMarkdown -->
        <div v-if="abstractHtml" class="detail-panel__abstract" v-html="abstractHtml"></div>

        <dl class="detail-panel__meta">
          <template v-if="formatTag">
            <dt>Format</dt>
            <dd>
              <span class="sg-badge" :class="`sg-badge--${formatTag.modifier}`">{{ formatTag.icon }} {{ formatTag.label }}</span>
            </dd>
          </template>
          <template v-if="(row as any).trackName">
            <dt>Track</dt>
            <dd>{{ (row as any).trackName }}</dd>
          </template>
          <template v-if="row.week">
            <dt>Week</dt>
            <dd>{{ row.week }}</dd>
          </template>
          <template v-if="(row as any).scheduledStart">
            <dt>When</dt>
            <dd>
              {{ formatViewerLocal((row as any).scheduledStart) }}
            </dd>
          </template>
          <template v-if="isActivity && (row as any).points">
            <dt>Points</dt>
            <dd>{{ (row as any).points }}</dd>
          </template>
          <template v-if="isActivity && (row as any).taskType">
            <dt>Type</dt>
            <dd>{{ (row as any).taskType }}</dd>
          </template>
        </dl>

        <div class="detail-panel__links">
          <a
            v-if="(row as any).youtubeUrl"
            :href="safeHref((row as any).youtubeUrl)"
            target="_blank"
            rel="noopener noreferrer"
            class="detail-panel__link detail-panel__link--youtube"
          >Watch on YouTube</a>
          <a
            v-if="(row as any).communityEventUrl"
            :href="safeHref((row as any).communityEventUrl)"
            target="_blank"
            rel="noopener noreferrer"
            class="detail-panel__link"
          >Community Event</a>
          <a
            v-if="(row as any).linkedinUrl"
            :href="safeHref((row as any).linkedinUrl)"
            target="_blank"
            rel="noopener noreferrer"
            class="detail-panel__link detail-panel__link--linkedin"
          >LinkedIn</a>
          <a
            v-if="taskUrl"
            :href="taskUrl"
            class="detail-panel__link detail-panel__link--task"
          >{{ taskLinkLabelTitle }}</a>
        </div>

        <div v-if="showCalendar" class="detail-panel__calendar">
          <span class="detail-panel__calendar-label">Add to calendar</span>
          <div class="detail-panel__calendar-links">
            <a :href="icsHref" class="detail-panel__link detail-panel__link--ics" download>Download .ics</a>
            <a :href="googleHref" target="_blank" rel="noopener noreferrer" class="detail-panel__link">Google Calendar</a>
            <a :href="outlookHref" target="_blank" rel="noopener noreferrer" class="detail-panel__link">Outlook</a>
          </div>
        </div>

        <div v-if="row.complete" class="detail-panel__complete-badge">
          <span>&#x2713; Completed</span>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.detail-panel {
  position: fixed;
  inset: 0;
  z-index: 100;
  display: flex;
  justify-content: flex-end;
}

.detail-panel__backdrop {
  position: absolute;
  inset: 0;
  background: rgba(0, 0, 0, 0.4);
}

.detail-panel__drawer {
  position: relative;
  z-index: 1;
  width: min(480px, 100vw);
  height: 100%;
  background: var(--sapBackgroundColor, #fff);
  box-shadow: var(--sapContent_Shadow3, -4px 0 16px rgba(0,0,0,0.15));
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.detail-panel__header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 0.5rem;
  padding: 1rem 1.25rem;
  border-bottom: 1px solid var(--sapList_BorderColor, #e4e5e7);
  background: var(--sapList_HeaderBackground, #f5f6f7);
}

.detail-panel__title {
  font-size: var(--sapFontHeader4Size, 1.125rem);
  font-weight: 700;
  color: var(--sapTextColor, #32363a);
  margin: 0;
}

.detail-panel__close {
  background: none;
  border: none;
  cursor: pointer;
  font-size: 1rem;
  color: var(--sapContent_IconColor, #6a6d70);
  padding: 0.25rem;
  flex-shrink: 0;
}

.detail-panel__close:hover {
  color: var(--sapTextColor, #32363a);
}

.detail-panel__thumb-wrap {
  flex-shrink: 0;
}

.detail-panel__thumb {
  width: 100%;
  height: auto;
  display: block;
  object-fit: cover;
  max-height: 200px;
}

.detail-panel__body {
  flex: 1;
  overflow-y: auto;
  padding: 1.25rem;
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

.detail-panel__abstract {
  font-size: var(--sapFontSize, 0.875rem);
  color: var(--sapTextColor, #32363a);
  line-height: 1.5;
  margin: 0;
}

/* Rendered-markdown children: give paragraphs and lists breathing room so
   authored formatting reads like the source, not one collapsed block. */
.detail-panel__abstract :deep(> :first-child) { margin-top: 0; }
.detail-panel__abstract :deep(> :last-child) { margin-bottom: 0; }
.detail-panel__abstract :deep(p) { margin: 0 0 0.75rem; }
.detail-panel__abstract :deep(ul),
.detail-panel__abstract :deep(ol) { margin: 0 0 0.75rem; padding-left: 1.25rem; }
.detail-panel__abstract :deep(li) { margin: 0.15rem 0; }
.detail-panel__abstract :deep(a) { color: var(--sapLinkColor, #0854a0); }
.detail-panel__abstract :deep(h1),
.detail-panel__abstract :deep(h2),
.detail-panel__abstract :deep(h3),
.detail-panel__abstract :deep(h4) {
  font-size: 1rem;
  font-weight: 700;
  margin: 0.75rem 0 0.35rem;
}
.detail-panel__abstract :deep(code) {
  font-family: var(--sapContent_MonospaceFontFamily, monospace);
  font-size: 0.85em;
  background: var(--sapList_Hover_Background, #f5f6f7);
  padding: 0.05rem 0.25rem;
  border-radius: 3px;
}

.detail-panel__meta {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 0.25rem 1rem;
  font-size: var(--sapFontSize, 0.875rem);
  margin: 0;
}

.detail-panel__meta dt {
  color: var(--sapContent_LabelColor, #6a6d70);
  font-weight: 600;
}

.detail-panel__meta dd {
  color: var(--sapTextColor, #32363a);
  margin: 0;
}

.sg-badge {
  display: inline-block;
  padding: 0.05rem 0.45rem;
  border-radius: 20px;
  font-size: 0.72rem;
  font-weight: 600;
  white-space: nowrap;
}

.sg-badge--live {
  background: var(--sapErrorBackground, #ffebeb);
  color: var(--sapNegativeColor, #b00020);
}

.sg-badge--prerecorded {
  background: var(--sapNeutralBackground, #f5f6f7);
  color: var(--sapContent_LabelColor, #6a6d70);
}

.detail-panel__links {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.detail-panel__calendar {
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
  padding-top: 0.75rem;
  border-top: 1px solid var(--sapList_BorderColor, #e4e5e7);
}

.detail-panel__calendar-label {
  font-size: 0.75rem;
  font-weight: 600;
  color: var(--sapContent_LabelColor, #6a6d70);
  text-transform: uppercase;
  letter-spacing: 0.03em;
}

.detail-panel__calendar-links {
  display: flex;
  flex-wrap: wrap;
  gap: 0.75rem;
}

.detail-panel__link {
  display: inline-block;
  font-size: var(--sapFontSize, 0.875rem);
  color: var(--sapLinkColor, #0854a0);
  text-decoration: none;
}

.detail-panel__link:hover {
  text-decoration: underline;
}

.detail-panel__link--youtube {
  color: #c4302b;
}

.detail-panel__complete-badge {
  display: inline-flex;
  align-items: center;
  gap: 0.25rem;
  padding: 0.25rem 0.75rem;
  background: var(--sapSuccessBackground, #f1fdf6);
  color: var(--sapPositiveColor, #107e3e);
  border: 1px solid var(--sapSuccessBorderColor, #107e3e);
  border-radius: 1rem;
  font-size: 0.8125rem;
  font-weight: 600;
  align-self: flex-start;
}

.detail-panel__embed-wrap {
  flex-shrink: 0;
  position: relative;
  width: 100%;
  padding-top: 56.25%;
}

.detail-panel__embed {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  border: none;
  display: block;
}

.detail-panel__speakers {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}

.detail-panel__speaker {
  display: flex;
  align-items: center;
  gap: 0.75rem;
}

.detail-panel__speaker-photo {
  width: 3rem;
  height: 3rem;
  border-radius: 50%;
  object-fit: cover;
  flex-shrink: 0;
}

.detail-panel__speaker-meta {
  display: flex;
  flex-direction: column;
  gap: 0.125rem;
}

.detail-panel__speaker-name {
  font-size: var(--sapFontSize, 0.875rem);
  font-weight: 600;
  color: var(--sapTextColor, #32363a);
}

.detail-panel__speaker-role {
  font-size: 0.75rem;
  color: var(--sapContent_LabelColor, #6a6d70);
}

.detail-panel__link--linkedin {
  color: #0a66c2;
}

.detail-panel__enlarge {
  background: none;
  border: none;
  cursor: pointer;
  font-size: 1rem;
  color: var(--sapContent_IconColor, #6a6d70);
  padding: 0.25rem;
  flex-shrink: 0;
}

.detail-panel__enlarge:hover {
  color: var(--sapTextColor, #32363a);
}

.detail-panel__drawer--wide {
  width: min(70vw, 100vw);
}

.detail-panel__transcript-wrap {
  flex-shrink: 0;
  border-top: 1px solid var(--sapList_BorderColor, #e4e5e7);
}

.detail-panel__transcript-toggle {
  width: 100%;
  background: none;
  border: none;
  cursor: pointer;
  font-size: var(--sapFontSize, 0.875rem);
  color: var(--sapLinkColor, #0854a0);
  padding: 0.5rem 1.25rem;
  text-align: left;
}

.detail-panel__transcript-toggle:hover {
  text-decoration: underline;
}

.detail-panel__transcript {
  max-height: 280px;
  overflow-y: auto;
  padding: 0.5rem 1.25rem 0.75rem;
  display: flex;
  flex-direction: column;
  gap: 0.125rem;
}

.detail-panel__transcript-tag {
  font-size: 0.75rem;
  color: var(--sapContent_LabelColor, #6a6d70);
  margin: 0 0 0.25rem;
  font-style: italic;
}

.detail-panel__transcript-empty {
  font-size: var(--sapFontSize, 0.875rem);
  color: var(--sapContent_LabelColor, #6a6d70);
  margin: 0;
}

.detail-panel__transcript-line {
  display: flex;
  align-items: baseline;
  gap: 0.5rem;
  background: none;
  border: none;
  cursor: pointer;
  text-align: left;
  padding: 0.125rem 0;
  font-size: var(--sapFontSize, 0.875rem);
  color: var(--sapTextColor, #32363a);
  border-radius: 2px;
}

.detail-panel__transcript-line:hover {
  background: var(--sapList_Hover_Background, #f5f6f7);
}

.detail-panel__transcript-ts {
  font-size: 0.75rem;
  font-variant-numeric: tabular-nums;
  color: var(--sapLinkColor, #0854a0);
  min-width: 2.75rem;
  flex-shrink: 0;
}
</style>
