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

vi.mock('../../composables/useAuth', () => ({
  useAuth: () => ({ servicePath: { value: '/author/' }, userRole: { value: 'author' } })
}))

import SurveyReport from '../SurveyReport.vue'

describe('SurveyReport', () => {
  beforeEach(() => vi.clearAllMocks())

  it('renders one tile per survey dimension after loading parents + distribution', async () => {
    const w = mount(SurveyReport)
    await flushPromises()
    // 7 dimensions => 7 chart cells
    expect(w.findAll('.chart-cell').length).toBe(7)
  })

  it('renders a histogram for a dimension with responses and its full question prompt', async () => {
    const w = mount(SurveyReport)
    await flushPromises()
    // The 'structure' dimension has 2 responses at score 8 => one histogram with
    // 11 bars (scores 0–10) and the response count in the caption.
    expect(w.findAll('.histogram').length).toBe(1)
    expect(w.findAll('.histogram')[0].findAll('.bar-col').length).toBe(11)
    expect(w.text()).toContain('2 responses')
    expect(w.text()).toContain('The tutorial was well structured.')
  })

  it('shows an empty state for dimensions with no responses', async () => {
    const w = mount(SurveyReport)
    await flushPromises()
    // 6 of 7 dimensions have no data in the stub => 6 "No responses yet" tiles.
    expect(w.findAll('.chart-cell .empty-state').length).toBe(6)
  })

  it('renders the comments returned by the API', async () => {
    const w = mount(SurveyReport)
    await flushPromises()
    expect(w.text()).toContain('Nice tutorial')
  })
})
