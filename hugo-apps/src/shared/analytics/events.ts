// hugo-apps/src/shared/analytics/events.ts
// Type definitions for the 8 event types. Runtime validation lives server-side
// (srv/lib/ui-event-handler.js); this file is purely TS shape declarations
// + helpers for callers.

export type Surface = '/' | '/browse/' | '/tutorials/'

export type FilterKind =
  | 'type' | 'level' | 'product' | 'topic' | 'search' | 'sort'
  | 'clear-all' | 'quick-new' | 'quick-noLicense'

export type CardSource = 'grid' | 'featured-rail' | 'recent-rail'

export interface PageViewPayload { path: string; referrer: string }
export interface FilterChangePayload { kind: FilterKind; value?: string | string[] }
export interface CardClickPayload {
  cardType: 'mission' | 'group' | 'tutorial'
  cardId: string
  position: number
  source: CardSource
}
export interface PaginationChangePayload { fromPage: number; toPage: number }
export interface RailShowAllClickPayload { railType: 'featured' | 'recent'; targetPath: string }
export interface ScrollDepthPayload { maxPercent: 25 | 50 | 75 | 100 }
export interface PageLeavePayload { durationMs: number; eventCount: number }
export interface ReferredViewPayload {
  tutorialSlug: string
  fromSurface: string
  fromCardId: string
}
