export interface ScanResult {
  uid: string
  payload: {
    recordId: string
    status: string
    eventId: number
  }
}

export interface ContestantData {
  uid: string
  eventId: number
  recordId: string
  status: string
  lastName: string
  firstInitial: string
  tutorialsCompleted: number
  groupsCompleted: number
  missionsCompleted: number
  prizeRecords: string
  claimedCount: number
  claimedPrizeNames: string[]
}

export interface EventStats {
  eventName: string | null
  prizesClaimed: number
  prizesAvailable: number
  earnedAwaitingHandover: number
  participants: number
  participantsClaimed: number
  tutorialsCompleted: number
  groupsCompleted: number
  missionsCompleted: number
}
