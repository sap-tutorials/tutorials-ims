export type UnsupportedReason = 'camera-api' | 'wasm' | 'offscreen-canvas' | 'raf' | 'mobile';

export interface SupportReport {
  supported: boolean;
  reasons: UnsupportedReason[];
  prefersReducedMotion: boolean;
}

function mq(query: string): boolean {
  try { return window.matchMedia(query).matches; } catch { return false; }
}

export function detectSupport(): SupportReport {
  const reasons: UnsupportedReason[] = [];
  if (!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== 'function') reasons.push('camera-api');
  if (typeof (globalThis as any).WebAssembly === 'undefined') reasons.push('wasm');
  if (typeof (globalThis as any).OffscreenCanvas === 'undefined') reasons.push('offscreen-canvas');
  if (typeof requestAnimationFrame !== 'function') reasons.push('raf');
  if (!mq('(pointer: fine)') || !mq('(min-width: 768px)')) reasons.push('mobile');
  return {
    supported: reasons.length === 0,
    reasons,
    prefersReducedMotion: mq('(prefers-reduced-motion: reduce)')
  };
}
