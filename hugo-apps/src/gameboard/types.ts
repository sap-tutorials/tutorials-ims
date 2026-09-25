export interface LeaderboardRow {
  rank: number
  displayName: string
  score: number
  level: number
  communityUrl: string | null
}

// Paged leaderboard envelope (issue #2510). getLeaderboard now returns this
// object as the response body directly (a CAP function returning a structured
// type is NOT wrapped under `value` the way an array is): { rows, total } plus
// an @odata.context annotation the UI ignores. `total` is the full field size —
// powers "Page X of Y", the participant counter, and "would I make the board".
export interface LeaderboardPage {
  rows: LeaderboardRow[]
  total: number
}

// ---- Plan B's getGameboard/getMyGameboard contract (verbatim field names) ----
export interface LevelThreshold { level: number; minScore: number; label?: string }
export interface WeekTrackTotal { week: string; trackId: string; totalPoints: number; totalCount: number }
export interface TrackRef { trackId: string; title: string }
export interface WeekTrackBreakdown {
  week: string; trackId: string
  earnedPoints: number; earnedCount: number
  remainingPoints: number; remainingCount: number
}
export interface MyGameboard {
  status?: 'joined' | 'not_joined' | 'no_event'  // backend CTA hint
  userId: string
  score: number
  level: number
  rank?: number | null           // caller's shared-rank position in the full field (issue #2510); null if not located / not joined
  total?: number                 // total participants in the ranked field — for "#N of M" / "would I make the board"
  avatarIndex: number            // 0..37 — client maps to Group-<n>.png
  breakdown: WeekTrackBreakdown[]
}
export interface GameboardConfig {
  thresholds: LevelThreshold[]
  totals: WeekTrackTotal[]        // flat; group by .week client-side
  tracks: TrackRef[]              // trackId -> title lookup (fail-soft [])
  hasActiveEvent?: boolean        // is a Devtoberfest config active?
  activityCount?: number          // 0 with hasActiveEvent → 'coming soon' empty-state
  personalized: MyGameboard | null  // null unless caller authenticated & a participant
}

export type ConnectionState = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'error'

export interface MountConfig {
  apiLeaderboard: string
  apiGameboard: string
  apiMyGameboard: string
  ws: string          // '' → same-origin
  imgBase: string
  top: number         // page size (rows per page); maps to the API `top` param (issue #2510 pagination)
}
