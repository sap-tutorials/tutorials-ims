// #badge-v2 — camera scan ordering helper.
//
// The <video ref="videoRef"> lives only in the v-if="state==='scanning'"
// branch, so it is not in the DOM until Vue has rendered that branch. The
// camera scanner reads videoRef.value synchronously; calling it in the same
// tick as the state change reads a null ref and throws "Video element not
// available", tearing the camera down. Awaiting nextTick between the state
// change and the scan lets Vue mount the <video> first.
//
// Extracted so the ordering is unit-testable without mounting the component.
export async function beginScan(
  setState: (s: 'scanning') => void,
  nextTickFn: () => Promise<void>,
  scanFn: () => Promise<string | null>,
): Promise<string | null> {
  setState('scanning')
  await nextTickFn()
  return scanFn()
}
