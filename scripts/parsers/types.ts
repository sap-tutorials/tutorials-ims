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
  // CHANGED: correctAnswer is now optional. Omitted for AI-graded
  // questions (issue #209) — the reference answer ships server-side
  // via ValidateAnswerSpecs and never enters the public Hugo
  // frontmatter or <script id="tutorial-data"> JSON.
  // The hugo-apps consumer (`hugo-apps/src/validation/grading.ts`) defines its own local
  // interface that keeps correctAnswer: string required; AI-graded questions are routed
  // away from gradeAnswers() at the call site (Task 10).
  correctAnswer?: string
  // NEW — opted in via ###Grading: ai-judged OR via regex rule types (issue #209).
  aiGrading?: boolean
}

export interface TutorialStep {
  number: number
  title: string
  content: string
  validation?: ValidationQuestion[]
  codeCheck?: PublicCodeCheckSpec
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
  displayTagSlugs: string[]
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

// Full CodeCheckSpec — used by the publish pipeline. NEVER ship to the
// client; the referenceSolution field is author-only.
export interface CodeCheckSpec {
  stepNumber: number
  goal: string             // required
  language?: string
  hints?: string[]
  referenceSolution?: string
}

// Trimmed shape that ships in Hugo frontmatter / data-* attributes.
// Includes hasReference flag so the grader can know one exists without
// the spec having to ship it.
export interface PublicCodeCheckSpec {
  goal: string
  language?: string
  hints?: string[]
  hasReference: boolean
}
