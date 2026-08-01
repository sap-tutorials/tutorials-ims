const MAX = 20 * 1024 * 1024
export async function uploadSelfie(apiUrl: string, file: File, frameName: string): Promise<string> {
  if (!file || !/^image\//.test(file.type)) throw new Error('Please choose an image file.')
  if (file.size > MAX) throw new Error('Image is too large (max 20 MB).')
  const fd = new FormData()
  fd.append('file', file)
  fd.append('selectedPic', frameName)
  let res: Response
  try {
    res = await fetch(apiUrl, { method: 'POST', body: fd })
  } catch {
    // A raw fetch() rejection (offline / DNS / CORS) must not leak "Failed to
    // fetch" — surface the same friendly, actionable text as any other failure.
    throw new Error('Could not reach the server — please check your connection and try again.')
  }
  if (!res.ok) throw new Error('Could not build your selfie — please try again.')
  const b64 = await res.text()
  return `data:image/png;base64,${b64}`
}
