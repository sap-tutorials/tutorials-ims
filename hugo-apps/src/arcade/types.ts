export interface MountConfig {
  apiMyGameboard: string
  joinUrl: string
  imgBase: string
  demoAvatar: number
}
export interface MyGameboard {
  userId: string
  score: number
  level: number       // 0..4
  avatarIndex: number // 0..37
  breakdown: Array<{ week: string; trackId: string; earnedPoints: number; earnedCount: number; remainingPoints: number; remainingCount: number }>
}
