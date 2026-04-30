export interface TutorialEntry {
  slug: string
  title: string
  description: string
  time: number
  level: string
  stepCount: number
  primaryTag: string
  displayTags: string[]
  missionId?: number
  missionTitle?: string
  groupId?: number
  groupTitle?: string
  prev: string | null
  next: string | null
}

export interface CardItem {
  type: 'mission' | 'group' | 'tutorial'
  id: string
  title: string
  description: string
  time: number
  level: string
  tutorialCount: number
  primaryTag: string
  displayTags: string[]
  href: string
  stepCount: number
}

export interface MissionRef {
  id: number
  slug: string
  title: string
}

export interface GroupRef {
  id: number
  slug: string
  title: string
  missionId: number
}

export interface SearchableItem {
  ID: string
  legacyId: number
  title: string
  description: string | null
  slug: string | null
  primaryTag: string | null
  experienceTag: string | null
  averageTimeToComplete: number | null
  status: string
  taskType: 'TUTORIAL' | 'MISSION' | 'GROUP'
}

export interface SearchFacets {
  totalCount: number
  typeCounts: Array<{ name: string; count: number }>
  experienceCounts: Array<{ name: string; count: number }>
  tagCounts: Array<{ name: string; count: number }>
}
