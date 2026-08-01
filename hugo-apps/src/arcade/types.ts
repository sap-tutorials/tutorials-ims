export interface MountConfig {
  apiMyGameboard: string
  joinUrl: string
  imgBase: string
  demoAvatar: number
}
export interface MyGameboard {
  status?: 'joined' | 'not_joined' | 'no_event'  // backend CTA hint
  userId: string
  score: number
  level: number       // 0..4
  avatarIndex: number // 0..37
  firstName?: string       // arcade header greeting
  eventName?: string | null // active Devtoberfest edition name (dynamic header; null when no event)
  communityUrl?: string | null  // SAP Community profile link (when linked)
  hasActiveEvent?: boolean       // is a Devtoberfest config active?
  activityCount?: number         // 0 with hasActiveEvent → 'coming soon' empty-state
  breakdown: Array<{ week: string; trackId: string; earnedPoints: number; earnedCount: number; remainingPoints: number; remainingCount: number }>
}
