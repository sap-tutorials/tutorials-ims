// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createDebugOverlay, isCamDebugEnabled } from './cam-debug';

describe('createDebugOverlay', () => {
  afterEach(() => {
    document.getElementById('tut-cam-debug')?.remove();
  });

  it('returns null and mounts nothing when disabled', () => {
    const handle = createDebugOverlay(false);
    expect(handle).toBeNull();
    expect(document.getElementById('tut-cam-debug')).toBeNull();
  });

  it('mounts a fixed-position overlay when enabled', () => {
    const handle = createDebugOverlay(true);
    expect(handle).not.toBeNull();
    const root = document.getElementById('tut-cam-debug');
    expect(root).not.toBeNull();
    expect(root!.style.position).toBe('fixed');
    expect(root!.getAttribute('role')).toBe('status');
  });

  it('renders eye fields with threshold ticks', () => {
    const handle = createDebugOverlay(true)!;
    handle.report({
      kind: 'eye', faceSeen: true, gazeY: 0.85, pitch: 0.04,
      headForward: true, dwellMs: 300
    });
    const block = document.querySelector<HTMLElement>('[data-kind="eye"]')!;
    const text = block.textContent ?? '';
    expect(text).toContain('EYE');
    expect(text).toContain('gazeY      0.85');
    expect(text).toContain('pitch      0.040');
    expect(text).toContain('dwell      300');
    // gazeY 0.85 > 0.7 and headForward true → eligible should be ✓
    expect(text).toContain('eligible   ✓');
  });

  it('marks eye eligible ✗ when gaze is high', () => {
    const handle = createDebugOverlay(true)!;
    handle.report({
      kind: 'eye', faceSeen: true, gazeY: 0.4, pitch: 0.04,
      headForward: true, dwellMs: 0
    });
    const block = document.querySelector<HTMLElement>('[data-kind="eye"]')!;
    expect(block.textContent).toContain('eligible   ✗');
  });

  it('renders hand fields with state and dx/v ticks', () => {
    const handle = createDebugOverlay(true)!;
    handle.report({
      kind: 'hand', palmSeen: true, palmOpen: true, x: 0.5,
      dxFromArmed: 0.4, dtMs: 150, velocity: 2.0, state: 'ARMED'
    });
    const block = document.querySelector<HTMLElement>('[data-kind="hand"]')!;
    const text = block.textContent ?? '';
    expect(text).toContain('HAND');
    expect(text).toContain('state      ARMED');
    expect(text).toContain('dx         0.40  >= 0.3  ✓');
    expect(text).toContain('v          2.00  >= 1.5  ✓');
  });

  it('destroy() removes the overlay node', () => {
    const handle = createDebugOverlay(true)!;
    expect(document.getElementById('tut-cam-debug')).not.toBeNull();
    handle.destroy();
    expect(document.getElementById('tut-cam-debug')).toBeNull();
  });
});

describe('isCamDebugEnabled', () => {
  let originalSearch: string;
  beforeEach(() => { originalSearch = location.search; });
  afterEach(() => {
    history.replaceState(null, '', location.pathname + originalSearch);
  });

  it('returns false when ?debug-cam is absent', () => {
    history.replaceState(null, '', location.pathname);
    expect(isCamDebugEnabled()).toBe(false);
  });

  it('returns true when ?debug-cam is present (no value)', () => {
    history.replaceState(null, '', location.pathname + '?debug-cam');
    expect(isCamDebugEnabled()).toBe(true);
  });

  it('returns true when ?debug-cam has any value', () => {
    history.replaceState(null, '', location.pathname + '?debug-cam=1');
    expect(isCamDebugEnabled()).toBe(true);
  });
});
