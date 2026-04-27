import { ref } from 'vue'

export interface AemTutorialNode {
  title: string
  description?: string
  imsId: number
  progress: number
  taskType: string
  url?: string
  timeToComplete?: number
  includes?: AemTutorialNode[]
}

export interface AemEnrichedData {
  description: string
  progress: number
  icon: string
  groups: Array<{
    title: string
    description: string
    progress: number
    tutorials: Array<{
      title: string
      slug: string
      progress: number
      timeToComplete: number
    }>
  }>
}

function extractSlug(url: string): string {
  const match = url?.match(/\/tutorials\/([^/.]+)/)
  return match?.[1] ?? ''
}

function parseMiniNavigator(data: { context: AemTutorialNode[] }): AemEnrichedData | null {
  const mission = data.context?.[0]
  if (!mission) return null

  return {
    description: mission.description ?? '',
    progress: mission.progress ?? 0,
    icon: '',
    groups: (mission.includes ?? [])
      .filter(g => g.taskType === 'Group')
      .map(group => ({
        title: group.title,
        description: group.description ?? '',
        progress: group.progress ?? 0,
        tutorials: (group.includes ?? [])
          .filter(t => t.taskType === 'Tutorial')
          .map(tut => ({
            title: tut.title,
            slug: extractSlug(tut.url ?? ''),
            progress: tut.progress ?? 0,
            timeToComplete: (tut.timeToComplete ?? 0) / 60,
          })),
      })),
  }
}

function parseProgressSeries(data: { paths?: Array<{ title: string; description?: string; items?: Array<{ title: string; url?: string; progress?: number; timeToComplete?: number }> }> }): AemEnrichedData | null {
  if (!data.paths?.length) return null

  return {
    description: '',
    progress: 0,
    icon: '',
    groups: data.paths.map(path => ({
      title: path.title,
      description: path.description ?? '',
      progress: 0,
      tutorials: (path.items ?? []).map(item => ({
        title: item.title,
        slug: extractSlug(item.url ?? ''),
        progress: item.progress ?? 0,
        timeToComplete: (item.timeToComplete ?? 0) / 60,
      })),
    })),
  }
}

export function useAemEnrichment() {
  const data = ref<AemEnrichedData | null>(null)
  const loading = ref(false)

  async function fetchForMission(missionId: number): Promise<void> {
    loading.value = true
    try {
      const miniRes = await fetch(`/bin/sapdx/v2/tutorial/miniNavigator.${missionId}.json`)
      if (miniRes.ok) {
        const json = await miniRes.json()
        data.value = parseMiniNavigator(json)
        if (data.value) {
          fetchMissionIcon(missionId)
          return
        }
      }
    } catch {}

    try {
      const seriesRes = await fetch(`/bin/sapdx/tutorials/v3/progress/series?missionId=${missionId}`)
      if (seriesRes.ok) {
        const json = await seriesRes.json()
        data.value = parseProgressSeries(json)
      }
    } catch {}

    loading.value = false
  }

  async function fetchMissionIcon(missionId: number): Promise<void> {
    try {
      const query = JSON.stringify({ searchterm: '', taskTypes: ['mission'], additionalIds: [missionId] })
      const res = await fetch(`/bin/sapdx/v3/solr/search?json=${encodeURIComponent(query)}`)
      if (res.ok) {
        const json = await res.json()
        const icon = json.result?.[0]?.icon
        if (icon && data.value) {
          data.value = { ...data.value, icon }
        }
      }
    } catch {}
  }

  return { data, loading, fetchForMission }
}
