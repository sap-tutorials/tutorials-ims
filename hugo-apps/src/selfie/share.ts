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
      await navigator.share({ files: [file], title: 'Selfie with an Advocate', text: 'I met an SAP Developer Advocate! #Devtoberfest' })
      return 'shared'
    } catch {
      // User cancelled or share failed → guaranteed download path.
    }
  }
  downloadBlob(blob, filename)
  return 'downloaded'
}
