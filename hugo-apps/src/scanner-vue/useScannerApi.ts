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

  // #889: accountNumber is required — the server verifies the prize belongs
  // to the scanned contestant before flipping status. Callers must pass the
  // uid from the QR the operator just scanned (i.e. contestant.value.uid).
  async function claimPrize(recordId: string, accountNumber: string): Promise<string> {
    loading.value = true
    error.value = null
    try {
      const res = await fetch(
        `/scanner/claimPrize(recordId='${encodeURIComponent(recordId)}',accountNumber='${encodeURIComponent(accountNumber)}')`
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

  return { loading, error, contestant, getContestant, claimPrize, reset }
}
