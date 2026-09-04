// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'

// Stub the API layer so the component test does no network.
vi.mock('../../api/survey', () => ({
  SURVEY_DIMENSIONS: ['structure', 'interesting', 'useCase', 'relevance', 'duration', 'visuals', 'nps'],
  aggregateDistribution: (rows: any[]) => {
    const out: Record<string, any[]> = {}
    for (const r of rows) (out[r.dimension] ||= []).push({ score: r.score, count: r.responseCount, pct: 100 })
    return out
  },
  fetchTutorialParents: vi.fn().mockResolvedValue([
    { tutorialSlug: 'a', tutorialTitle: 'Tut A', missionTitle: 'Mission 1', groupTitle: 'Group 1' }
  ]),
  fetchSurveyDistribution: vi.fn().mockResolvedValue([
    { tutorialSlug: 'a', dimension: 'structure', score: 8, responseCount: 2 }
  ]),
  fetchSurveyComments: vi.fn().mockResolvedValue([
    { submittedAt: '2026-02-01T00:00:00Z', tutorialSlug: 'a', comment: 'Nice tutorial' }
  ]),
}))

// Stub ChartRenderer (ECharts needs a real canvas; we only assert wiring).
vi.mock('../../components/ChartRenderer.vue', () => ({
  default: { name: 'ChartRenderer', props: ['chartType', 'data', 'dimensions', 'measures'], template: '<div class="chart-stub" />' }
}))
vi.mock('../../composables/useChartTheme', () => ({ installChartTheme: vi.fn() }))
vi.mock('../../composables/useAuth', () => ({
  useAuth: () => ({ servicePath: { value: '/author/' }, userRole: { value: 'author' } })
}))

import SurveyReport from '../SurveyReport.vue'

describe('SurveyReport', () => {
  beforeEach(() => vi.clearAllMocks())

  it('renders one chart per survey dimension after loading parents + distribution', async () => {
    const w = mount(SurveyReport)
    await flushPromises()
    // 7 dimensions => 7 ChartRenderer stubs
    expect(w.findAll('.chart-stub').length).toBe(7)
  })

  it('renders the comments returned by the API', async () => {
    const w = mount(SurveyReport)
    await flushPromises()
    expect(w.text()).toContain('Nice tutorial')
  })
})
