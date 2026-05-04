import { ref } from 'vue'
import type { ContestantData } from './types'

export function useScannerApi() {
  const loading = ref(false)
  const error = ref<string | null>(null)
  const contestant = ref<ContestantData | null>(null)

  async function getContestant(uid: string): Promise<ContestantData> {
    loading.value = true
    error.value = null
    try {
      const res = await fetch(`/scanner/getContestant(accountNumber='${encodeURIComponent(uid)}')`)
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

  async function claimPrize(recordId: string): Promise<string> {
    loading.value = true
    error.value = null
    try {
      const res = await fetch(`/scanner/claimPrize(recordId='${encodeURIComponent(recordId)}')`)
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

  return { loading, error, contestant, getContestant, claimPrize, reset }
}
