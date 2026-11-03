// Payload interfaces copied from hugo-apps/src/app-space/AppSpace.vue (lines 53–118)
// to avoid cross-island import dependency.

export interface AppSpaceItem {
  imsId: number | null
  title: string
  type: 'TUTORIAL' | 'CHECKPOINT' | 'PRIZE'
  status: string
  progress: number
  experience: string
  timeToComplete: number
  url: string
  description: string
  recordId?: number
  unlocked?: boolean
  temporarilyUnavailable?: boolean
  unavailableReason?: string
  prizeId?: number | null
}

export interface ForkLane {
  label: string
  items: AppSpaceItem[]
}

export interface LinearSegment {
  order: number
  kind: 'linear'
  items: AppSpaceItem[]
}

export interface ClusterSegment {
  order: number
  kind: 'parallel-any'
  items: AppSpaceItem[]
}

export interface ForkSegment {
  order: number
  kind: 'fork'
  lanes: ForkLane[]
}

export type AppSpaceSegment = LinearSegment | ClusterSegment | ForkSegment

export interface AppSpaceTrack {
  id: string
  title: string
  description: string
  items: AppSpaceItem[]
  segments?: AppSpaceSegment[]
}

export interface AppSpaceData {
  eventId: number
  eventName: string
  eventDescription?: string
  hasLogo?: boolean
  authenticated?: boolean
  type: string
  paths: AppSpaceTrack[]
}

// Task 2+ interfaces (declared here for future use, not implemented in Task 1)
export interface Zone {
  id: string
  name: string
}

export interface Coin {
  id: string
  value: number
}

export interface Goal {
  id: string
  description: string
}

export interface LevelModel {
  id: string
  zones: Zone[]
  coins: Coin[]
  goals: Goal[]
}
