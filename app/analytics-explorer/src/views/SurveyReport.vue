<script setup lang="ts">
import '@ui5/webcomponents/dist/Select.js'
import '@ui5/webcomponents/dist/Option.js'
import '@ui5/webcomponents/dist/Title.js'
import { ref, computed, onMounted, watch } from 'vue'
import {
  SURVEY_DIMENSIONS, aggregateDistribution,
  fetchTutorialParents, fetchSurveyDistribution, fetchSurveyComments,
  type ParentRow, type CommentRow
} from '../api/survey'

// Short tile heading + the full question authors saw on the feedback form.
// The heading is the compact label; the prompt explains what the bars mean so
// the tile is legible without prior context (#2138).
const DIMENSIONS: Record<string, { label: string; prompt: string }> = {
  structure:   { label: 'Well structured',            prompt: 'The tutorial was well structured.' },
  interesting: { label: 'Interesting',                prompt: 'It was interesting to work through the tutorial.' },
  useCase:     { label: 'Helpful for my use case',    prompt: 'The tutorial was helpful for my use case.' },
  relevance:   { label: 'Relevant to my work',        prompt: 'The tutorial was relevant to my work.' },
  duration:    { label: 'Right length',               prompt: 'The tutorial was the right length.' },
  visuals:     { label: 'Good visuals & code samples', prompt: 'The tutorial had good visuals and code samples.' },
  nps:         { label: 'Likely to recommend (NPS)',  prompt: 'How likely are you to recommend this tutorial to a colleague? (0 = not at all, 10 = extremely)' },
}

// All survey questions are scored 0–10 (db/schema.cds @assert.range: [0,10]).
const SCORES = Array.from({ length: 11 }, (_, i) => i) // 0..10

const parents = ref<ParentRow[]>([])
const comments = ref<CommentRow[]>([])
const distByDim = ref<Record<string, { score: number; count: number; pct: number }[]>>({})
const loading = ref(true)

const selMission = ref<string>('')
const selGroup = ref<string>('')
const selTutorial = ref<string>('')

const missions = computed(() =>
  [...new Set(parents.value.map(p => p.missionTitle).filter(Boolean) as string[])].sort())
const groups = computed(() =>
  [...new Set(parents.value.map(p => p.groupTitle).filter(Boolean) as string[])].sort())
const tutorials = computed(() =>
  [...new Set(parents.value.map(p => p.tutorialTitle).filter(Boolean))].sort())

// The slug set the current filter resolves to (independent filters; the data
// itself narrows results — see spec §8, no cascading value-help in v1).
const selectedSlugs = computed(() => {
  const rows = parents.value.filter(p =>
    (!selMission.value || p.missionTitle === selMission.value) &&
    (!selGroup.value || p.groupTitle === selGroup.value) &&
    (!selTutorial.value || p.tutorialTitle === selTutorial.value))
  return [...new Set(rows.map(r => r.tutorialSlug))]
})

// Per-dimension histogram over the fixed 0–10 scale: bar height = % of
// responses at that score, plus total responses and mean for the caption.
interface Bar { score: number; pct: number; count: number }
interface Histogram { bars: Bar[]; total: number; avg: number }

function histogram(dim: string): Histogram {
  const buckets = distByDim.value[dim] ?? []
  const byScore = new Map(buckets.map(b => [b.score, b]))
  const total = buckets.reduce((a, b) => a + b.count, 0)
  const weighted = buckets.reduce((a, b) => a + b.score * b.count, 0)
  const bars = SCORES.map(score => {
    const b = byScore.get(score)
    return { score, pct: b?.pct ?? 0, count: b?.count ?? 0 }
  })
  return { bars, total, avg: total ? weighted / total : 0 }
}

async function reload() {
  const slugs = selectedSlugs.value
  const [dist, cmts] = await Promise.all([
    fetchSurveyDistribution(slugs),
    fetchSurveyComments(slugs),
  ])
  distByDim.value = aggregateDistribution(dist)
  comments.value = cmts
}

onMounted(async () => {
  parents.value = await fetchTutorialParents()
  await reload()
  loading.value = false
})

watch([selMission, selGroup, selTutorial], reload)

function onSel(target: 'mission' | 'group' | 'tutorial', e: any) {
  const v = e.detail?.selectedOption?.dataset?.value ?? ''
  if (target === 'mission') selMission.value = v
  else if (target === 'group') selGroup.value = v
  else selTutorial.value = v
}
</script>

<template>
  <div class="survey-report">
    <ui5-title level="H3">Tutorial Survey</ui5-title>
    <p class="intro">
      How respondents rated tutorials on a 0–10 scale. Each tile shows the
      distribution of scores for one survey question; taller bars mean more
      responses at that score. Filter by mission, group or tutorial.
    </p>

    <div class="filter-bar">
      <div class="filter-field">
        <label>Mission</label>
        <ui5-select @change="(e:any)=>onSel('mission', e)">
          <ui5-option :data-value="''" selected>All missions</ui5-option>
          <ui5-option v-for="m in missions" :key="m" :data-value="m">{{ m }}</ui5-option>
        </ui5-select>
      </div>
      <div class="filter-field">
        <label>Group</label>
        <ui5-select @change="(e:any)=>onSel('group', e)">
          <ui5-option :data-value="''" selected>All groups</ui5-option>
          <ui5-option v-for="g in groups" :key="g" :data-value="g">{{ g }}</ui5-option>
        </ui5-select>
      </div>
      <div class="filter-field">
        <label>Tutorial</label>
        <ui5-select @change="(e:any)=>onSel('tutorial', e)">
          <ui5-option :data-value="''" selected>All tutorials</ui5-option>
          <ui5-option v-for="t in tutorials" :key="t" :data-value="t">{{ t }}</ui5-option>
        </ui5-select>
      </div>
    </div>

    <div class="chart-grid">
      <div v-for="dim in SURVEY_DIMENSIONS" :key="dim" class="chart-cell">
        <div class="chart-title">{{ DIMENSIONS[dim]?.label }}</div>
        <div class="chart-prompt">{{ DIMENSIONS[dim]?.prompt }}</div>

        <template v-if="histogram(dim).total > 0">
          <div class="chart-meta">
            {{ histogram(dim).total }} response{{ histogram(dim).total === 1 ? '' : 's' }}
            · avg {{ histogram(dim).avg.toFixed(1) }}
          </div>
          <div class="histogram" role="img"
               :aria-label="`Score distribution for ${DIMENSIONS[dim]?.label}`">
            <div v-for="bar in histogram(dim).bars" :key="bar.score" class="bar-col">
              <div class="bar-track">
                <div class="bar-fill" :style="{ height: bar.pct + '%' }"
                     :title="`Score ${bar.score}: ${bar.count} response${bar.count === 1 ? '' : 's'} (${bar.pct.toFixed(0)}%)`">
                  <span v-if="bar.pct >= 8" class="bar-pct">{{ bar.pct.toFixed(0) }}%</span>
                </div>
              </div>
              <div class="bar-label">{{ bar.score }}</div>
            </div>
          </div>
          <div class="axis-label">Score (0–10) · bar height = % of responses</div>
        </template>
        <div v-else class="empty-state">No responses yet</div>
      </div>
    </div>

    <ui5-title level="H4">Comments</ui5-title>
    <table class="comments">
      <thead><tr><th>Submitted</th><th>Tutorial</th><th>Comment</th></tr></thead>
      <tbody>
        <tr v-for="(c, i) in comments" :key="i">
          <td>{{ new Date(c.submittedAt).toLocaleDateString() }}</td>
          <td>{{ c.tutorialSlug }}</td>
          <td>{{ c.comment }}</td>
        </tr>
        <tr v-if="!loading && comments.length === 0">
          <td colspan="3" class="empty-state">No comments for the current selection</td>
        </tr>
      </tbody>
    </table>
  </div>
</template>

<style scoped>
.survey-report { padding: 1rem; display: flex; flex-direction: column; gap: 1rem; height: 100%; overflow: auto; }
.intro { margin: 0; max-width: 70ch; color: var(--sapContent_LabelColor, #6a6d70); font-size: 0.875rem; }
.filter-bar { display: flex; gap: 1rem; flex-wrap: wrap; }
.filter-field { display: flex; flex-direction: column; gap: 0.25rem; }
.filter-field label { font-size: 0.75rem; font-weight: 600; color: var(--sapContent_LabelColor, #6a6d70); }
.chart-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: 1rem; }
.chart-cell {
  border: 1px solid var(--sapList_BorderColor, #d9d9d9); border-radius: 8px;
  padding: 0.75rem; display: flex; flex-direction: column; gap: 0.35rem;
  background: var(--sapTile_Background, transparent);
}
.chart-title { font-weight: 700; }
.chart-prompt { font-size: 0.8125rem; color: var(--sapContent_LabelColor, #6a6d70); min-height: 2.4em; }
.chart-meta { font-size: 0.75rem; color: var(--sapContent_LabelColor, #6a6d70); }
.histogram { display: flex; align-items: flex-end; gap: 3px; height: 150px; }
.bar-col { flex: 1; display: flex; flex-direction: column; align-items: center; gap: 2px; height: 100%; }
.bar-track { flex: 1; width: 100%; display: flex; align-items: flex-end; }
.bar-fill {
  width: 100%; min-height: 2px; border-radius: 3px 3px 0 0;
  background: var(--sapChart_OrderedColor_1, #5899da);
  display: flex; justify-content: center; align-items: flex-start;
}
.bar-pct { font-size: 0.625rem; color: #fff; padding-top: 1px; }
.bar-label { font-size: 0.6875rem; color: var(--sapContent_LabelColor, #6a6d70); }
.axis-label { font-size: 0.6875rem; color: var(--sapContent_LabelColor, #6a6d70); text-align: center; }
.empty-state { color: var(--sapContent_LabelColor, #6a6d70); font-style: italic; padding: 1rem 0; text-align: center; }
.comments { width: 100%; border-collapse: collapse; }
.comments th, .comments td { text-align: left; padding: 0.4rem 0.6rem; border-bottom: 1px solid var(--sapList_BorderColor, #eee); vertical-align: top; }
</style>
