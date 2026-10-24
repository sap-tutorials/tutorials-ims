// #badge-v2 follow-up — camera-support detection, extracted so the gating
// logic is unit-testable without a browser.
//
// Camera scanning is available whenever getUserMedia exists in a secure
// context. The native BarcodeDetector API is NOT required — it is
// Chromium/Android-only (absent on iOS Safari, Firefox, many desktop
// Edge/Chrome builds), and a jsQR software decoder covers its absence.
// Gating on BarcodeDetector left every non-Android browser stuck showing
// "Camera scanning not available".

export interface CameraEnv {
  hasGetUserMedia: boolean
  isSecureContext: boolean
}

export function cameraSupported(env: CameraEnv): boolean {
  return env.hasGetUserMedia && env.isSecureContext
}

export function readCameraEnv(
  nav: Navigator | undefined = typeof navigator !== 'undefined' ? navigator : undefined,
  win: Window | undefined = typeof window !== 'undefined' ? window : undefined,
): CameraEnv {
  return {
    hasGetUserMedia: !!nav?.mediaDevices?.getUserMedia,
    // Treat an undefined isSecureContext (non-browser/test) as secure so the
    // check reduces to getUserMedia presence there.
    isSecureContext: win?.isSecureContext !== false,
  }
}
