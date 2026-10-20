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
  tutorialsCompleted: number
  groupsCompleted: number
  missionsCompleted: number
  prizeRecords: string
  claimedCount: number
}
