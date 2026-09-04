<script setup lang="ts">
import '@ui5/webcomponents/dist/Select.js'
import '@ui5/webcomponents/dist/Option.js'
import '@ui5/webcomponents/dist/Table.js'
import '@ui5/webcomponents/dist/Title.js'
import { ref, computed, onMounted, watch } from 'vue'
import ChartRenderer from '../components/ChartRenderer.vue'
import { installChartTheme } from '../composables/useChartTheme'
import {
  SURVEY_DIMENSIONS, aggregateDistribution,
  fetchTutorialParents, fetchSurveyDistribution, fetchSurveyComments,
  type ParentRow, type CommentRow
} from '../api/survey'

const DIMENSION_LABELS: Record<string, string> = {
  structure: 'Well structured',
  interesting: 'Interesting',
  useCase: 'Helpful for my use case',
  relevance: 'Relevant to my work',
  duration: 'Right length',
  visuals: 'Good visuals & code samples',
  nps: 'Likely to recommend (NPS)',
}

const parents = ref<ParentRow[]>([])
const comments = ref<CommentRow[]>([])
const distByDim = ref<Record<string, { score: number; count: number; pct: number }[]>>({})

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

function chartData(dim: string) {
  const buckets = distByDim.value[dim] ?? []
  return {
    columns: ['score', 'pct'],
    data: buckets.map(b => [String(b.score), Number(b.pct.toFixed(1))]) as (string | number)[][],
  }
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
  installChartTheme()
  parents.value = await fetchTutorialParents()
  await reload()
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

    <div class="filter-bar">
      <ui5-select @change="(e:any)=>onSel('mission', e)">
        <ui5-option :data-value="''" selected>All missions</ui5-option>
        <ui5-option v-for="m in missions" :key="m" :data-value="m">{{ m }}</ui5-option>
      </ui5-select>
      <ui5-select @change="(e:any)=>onSel('group', e)">
        <ui5-option :data-value="''" selected>All groups</ui5-option>
        <ui5-option v-for="g in groups" :key="g" :data-value="g">{{ g }}</ui5-option>
      </ui5-select>
      <ui5-select @change="(e:any)=>onSel('tutorial', e)">
        <ui5-option :data-value="''" selected>All tutorials</ui5-option>
        <ui5-option v-for="t in tutorials" :key="t" :data-value="t">{{ t }}</ui5-option>
      </ui5-select>
    </div>

    <div class="chart-grid">
      <div v-for="dim in SURVEY_DIMENSIONS" :key="dim" class="chart-cell">
        <div class="chart-title">{{ DIMENSION_LABELS[dim] }}</div>
        <ChartRenderer
          chart-type="bar"
          :data="chartData(dim)"
          :dimensions="['score']"
          :measures="['pct']"
        />
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
      </tbody>
    </table>
  </div>
</template>

<style scoped>
.survey-report { padding: 1rem; display: flex; flex-direction: column; gap: 1rem; height: 100%; overflow: auto; }
.filter-bar { display: flex; gap: 0.75rem; flex-wrap: wrap; }
.chart-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(340px, 1fr)); gap: 1rem; }
.chart-cell { border: 1px solid var(--sapList_BorderColor, #ddd); border-radius: 6px; padding: 0.5rem; min-height: 340px; }
.chart-title { font-weight: 600; margin-bottom: 0.25rem; }
.comments { width: 100%; border-collapse: collapse; }
.comments th, .comments td { text-align: left; padding: 0.4rem 0.6rem; border-bottom: 1px solid var(--sapList_BorderColor, #eee); vertical-align: top; }
</style>
