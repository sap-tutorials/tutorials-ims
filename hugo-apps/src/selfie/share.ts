// Single source of truth for share copy + link.
export const SHARE_TEXT = 'I met an SAP Developer Advocate! #Devtoberfest'
export const SHARE_URL = 'https://developers.sap.com/devtoberfest/'

export function xIntentUrl(): string {
  const p = new URLSearchParams({ text: SHARE_TEXT, url: SHARE_URL })
  return `https://twitter.com/intent/tweet?${p}`
}

export function linkedInIntentUrl(): string {
  const p = new URLSearchParams({ url: SHARE_URL })
  return `https://www.linkedin.com/sharing/share-offsite/?${p}`
}

export function downloadBlob(blob: Blob, filename = 'selfie.png'): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}

export function canShareImage(): boolean {
  try {
    const f = new File([new Blob()], 'selfie.png', { type: 'image/png' })
    return typeof navigator.canShare === 'function' && navigator.canShare({ files: [f] })
  } catch { return false }
}

export async function shareOrDownload(blob: Blob, filename = 'selfie.png'): Promise<'shared' | 'downloaded'> {
  if (canShareImage() && typeof navigator.share === 'function') {
    try {
      const file = new File([blob], filename, { type: 'image/png' })
      await navigator.share({ files: [file], title: 'Selfie with an Advocate', text: SHARE_TEXT })
      return 'shared'
    } catch {
      // User cancelled or share failed → guaranteed download path.
    }
  }
  downloadBlob(blob, filename)
  return 'downloaded'
}

// Copy the PNG to the clipboard. Feature-detected + fail-soft.
export async function copyImage(blob: Blob): Promise<'copied' | 'unavailable'> {
  try {
    if (typeof ClipboardItem === 'undefined' || !navigator.clipboard?.write) return 'unavailable'
    await navigator.clipboard.write([new ClipboardItem({ [blob.type || 'image/png']: blob })])
    return 'copied'
  } catch { return 'unavailable' }
}
