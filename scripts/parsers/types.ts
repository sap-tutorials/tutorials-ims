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
  missionId: number
  missionTitle: string
  groupId: number
  groupTitle: string
  prev: string | null
  next: string | null
}

export const RAW_BASE_URL = 'https://raw.githubusercontent.com'

export interface GitHubContributor {
  name: string
  login: string
  avatarUrl: string
}
