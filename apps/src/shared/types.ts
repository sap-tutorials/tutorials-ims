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
