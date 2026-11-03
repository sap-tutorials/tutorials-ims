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

// Task 2+ interfaces: Level model for app-space gameplay
export interface Coin {
  title: string
  done: boolean
  available: boolean
}

export interface Gate {
  afterCoinIndex: number
}

export interface Goal {
  kind: 'prize' | 'checkpoint' | 'track'
  label: string
  prizeId: number | null
  trackId: string
}

export interface Zone {
  id: string
  title: string
  colorIndex: number
  cleared: boolean
  locked: boolean
  coins: Coin[]
  gates: Gate[]
  goal: Goal
}

export interface LevelModel {
  zones: Zone[]
}
