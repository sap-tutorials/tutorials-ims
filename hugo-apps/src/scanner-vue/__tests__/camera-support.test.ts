// #badge-v2 follow-up — regression guard: camera support must NOT require the
// native BarcodeDetector API. Before the jsQR fallback, isSupported gated on
// 'BarcodeDetector' in window, leaving iOS Safari + desktop Edge/Chrome (no
// BarcodeDetector) stuck on "Camera scanning not available" even with a camera.

import { describe, expect, it } from 'vitest'
import { cameraSupported, readCameraEnv } from '../camera-support'

describe('cameraSupported (#badge-v2 fallback)', () => {
  it('is supported with getUserMedia in a secure context (no BarcodeDetector needed)', () => {
    expect(cameraSupported({ hasGetUserMedia: true, isSecureContext: true })).toBe(true)
  })

  it('is NOT supported without getUserMedia', () => {
    expect(cameraSupported({ hasGetUserMedia: false, isSecureContext: true })).toBe(false)
  })

  it('is NOT supported in an insecure context', () => {
    expect(cameraSupported({ hasGetUserMedia: true, isSecureContext: false })).toBe(false)
  })
})

describe('readCameraEnv', () => {
  it('reports getUserMedia presence from navigator.mediaDevices', () => {
    const nav = { mediaDevices: { getUserMedia: () => {} } } as unknown as Navigator
    const win = { isSecureContext: true } as unknown as Window
    expect(readCameraEnv(nav, win)).toEqual({ hasGetUserMedia: true, isSecureContext: true })
  })

  it('reports no getUserMedia when mediaDevices is absent', () => {
    const nav = {} as Navigator
    const win = { isSecureContext: true } as unknown as Window
    expect(readCameraEnv(nav, win).hasGetUserMedia).toBe(false)
  })

  it('treats undefined isSecureContext as secure', () => {
    const nav = { mediaDevices: { getUserMedia: () => {} } } as unknown as Navigator
    const win = {} as unknown as Window
    expect(readCameraEnv(nav, win).isSecureContext).toBe(true)
  })

  it('treats a false isSecureContext as insecure', () => {
    const nav = { mediaDevices: { getUserMedia: () => {} } } as unknown as Navigator
    const win = { isSecureContext: false } as unknown as Window
    expect(readCameraEnv(nav, win).isSecureContext).toBe(false)
  })
})
