export interface TutorialFrontmatter {
  time: number
  author_name: string
  author_profile: string
  tags: string[]
  primary_tag: string
  parser?: string
  title?: string
  description?: string
}

export interface ValidationQuestion {
  id: string
  question: string
  type: 'multiple-choice' | 'text'
  options?: string[]
  correctAnswer: string
}

export interface TutorialStep {
  number: number
  title: string
  content: string
  validation?: ValidationQuestion[]
}

export interface ParsedTutorial {
  slug: string
  title: string
  description: string
  time: number
  level: string
  tags: string[]
  primaryTag: string
  author: string
  authorProfile: string
  repo: string
  branch: string
  youWillLearn: string[]
  prerequisites: string
  steps: TutorialStep[]
}

export interface TutorialNavEntry {
  slug: string
  title: string
  description: string
  time: number
  level: string
  stepCount: number
  primaryTag: string
  displayTags: string[]
  repo?: string
  branch?: string
  missionId?: number
  missionTitle?: string
  groupId?: number
  groupTitle?: string
  missionSlug?: string
  groupSlug?: string
  prev: string | null
  next: string | null
  recommendations?: string[]
  // ISO timestamp of the oldest commit on the tutorial markdown file —
  // used by the navigator to render a "NEW" badge for tutorials authored in the last 31 days.
  createdAt?: string
}

export interface GroupRef {
  id: number
  title: string
  slug: string
  missionId: number
  tutorials: string[]
}

export interface MissionMeta {
  id: number
  title: string
  slug: string
  groups: GroupRef[]
}

export interface NavData {
  tutorials: TutorialNavEntry[]
  missions: MissionMeta[]
  groups: GroupRef[]
}

export const RAW_BASE_URL = 'https://raw.githubusercontent.com'

export interface GitHubContributor {
  name: string
  login: string
  avatarUrl: string
}

export interface Mission {
  imsId: number
  title: string
  slug: string
  description: string
  level: string
  time: number
  icon: string
  tasksCount: number
}

export interface HierarchyGroup {
  imsId: number
  title: string
  slug: string
  description: string
  tutorialSlugs: string[]
}

export interface MissionHierarchy {
  missionImsId: number
  groups: HierarchyGroup[]
  tutorialSlugs: string[]
}

export interface StandaloneGroup {
  imsId: number
  title: string
  slug: string
  description: string
  tutorialSlugs: string[]
}
