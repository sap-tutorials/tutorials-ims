import { ref } from 'vue'
import type { ContestantData } from './types'

export function useScannerApi() {
  const loading = ref(false)
  const error = ref<string | null>(null)
  const contestant = ref<ContestantData | null>(null)

  async function getContestant(uid: string, eventId: number): Promise<ContestantData> {
    loading.value = true
    error.value = null
    try {
      const res = await fetch(`/scanner/getContestant(accountNumber='${encodeURIComponent(uid)}',eventId=${eventId})`)
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error?.message || `HTTP ${res.status}`)
      }
      const json = await res.json()
      return json.value ?? json
    } finally {
      loading.value = false
    }
  }

  async function claimPrizeForContestant(uid: string, eventId: number): Promise<{ claimedCount: number; message: string }> {
    loading.value = true
    error.value = null
    try {
      const res = await fetch(
        `/scanner/claimPrizeForContestant(accountNumber='${encodeURIComponent(uid)}',eventId=${eventId})`
      )
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error?.message || `HTTP ${res.status}`)
      }
      const json = await res.json()
      return json.value ?? json
    } finally {
      loading.value = false
    }
  }

  function reset() {
    contestant.value = null
    error.value = null
    loading.value = false
  }

  return { loading, error, contestant, getContestant, claimPrizeForContestant, reset }
}
