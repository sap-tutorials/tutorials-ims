import { ref } from 'vue'

/**
 * useExport — wraps POST /admin/analytics/export (shipped in Phase 1).
 * Triggers a browser download via a programmatic <a> link with a
 * generated blob URL. The endpoint streams text/csv with attachment
 * headers; we just need to force the browser to save it locally.
 */
export function useExport() {
  const isExporting = ref(false)
  const lastError = ref<string | null>(null)

  async function exportCsv(sql: string, filename = `analytics-${Date.now()}.csv`): Promise<void> {
    isExporting.value = true
    lastError.value = null
    try {
      const r = await fetch('/admin/analytics/export', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sql }),
      })
      if (!r.ok) {
        const text = await r.text().catch(() => '')
        throw new Error(`exportCsv ${r.status}: ${text || 'request failed'}`)
      }
      const blob = await r.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = filename
      document.body.appendChild(a)
      a.click()
      a.remove()
      // Defer revoke so the browser has time to start the download.
      setTimeout(() => URL.revokeObjectURL(url), 1000)
    } catch (e: any) {
      lastError.value = e.message
      throw e
    } finally {
      isExporting.value = false
    }
  }

  return { exportCsv, isExporting, lastError }
}
