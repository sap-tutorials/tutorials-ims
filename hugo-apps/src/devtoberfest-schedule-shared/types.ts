export interface Edition { id: string; name: string; year?: string; isCurrent: boolean; startsAt?: string; endsAt?: string; timeZone?: string }
export interface Session { id: string; kind: 'session'; title: string; abstract?: string; trackId?: string; trackName?: string; trackDay?: string; week?: string; scheduledStart?: string; scheduledTimeZone?: string; recordingStart?: string; youtubeUrl?: string; communityEventUrl?: string; activityId?: string | null; status?: string }
export interface Activity { id: string; kind: 'activity'; title: string; week?: string; points: number; trackId?: string; trackName?: string; taskType?: string; taskSlug?: string; taskTitle?: string; taskId?: string; status?: string }
export interface Feed { activeEditionId: string | null; editions: Edition[]; sessions: Session[]; activities: Activity[] }
export interface MyCompletions { authenticated: boolean; completedSlugs?: string[]; earnedPoints?: number; maxPoints?: number; completedActivityIds?: string[] }
export type ScheduleRow = (Session | Activity) & { complete?: boolean };
