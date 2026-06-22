export interface EventInfo {
  name: string
  startDate: string
  endDate: string
}

export interface StatusResponse {
  event: EventInfo | null
  joined: boolean
  termsVersion: number
  termsRequired: boolean
  contentRulesUrl: string
  faqUrl: string
  gameboardUrl: string
  activitiesUrl: string
}

export interface TermsResponse {
  text: string    // markdown source
  version: number
}

export interface JoinResponse {
  joined: boolean
  termsVersion: number
}

export type HomeState =
  | 'loading'
  | 'event-missing'
  | 'error'
  | 'anonymous'
  | 'unregistered'
  | 'registered'

export interface MountConfig {
  apiStatus: string
  apiTerms: string
  apiJoin: string
  apiMe: string
  imgKasimir: string
  imgTeched: string
  imgDevtoberfest: string
}
