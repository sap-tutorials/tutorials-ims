export interface ScanResult {
  uid: string
  payload: {
    recordId: string
    status: string
  }
}

export interface ContestantData {
  uid: string
  recordId: string
  status: string
  tutorialsCompleted: number
  groupsCompleted: number
  missionsCompleted: number
  prizeRecords: string
}
