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

  it('renders eye pitch vs calibrated down/up thresholds with ticks', () => {
    const handle = createDebugOverlay(true)!;
    handle.report({
      kind: 'eye', faceSeen: true, pitch: 1.05, gazeY: 0.1,
      downThreshold: 1.0, upThreshold: 0.6, calibrated: true, dwellMs: 300, dir: 'down'
    });
    const block = document.querySelector<HTMLElement>('[data-kind="eye"]')!;
    const text = block.textContent ?? '';
    expect(text).toContain('EYE');
    expect(text).toContain('pitch      1.050');
    expect(text).toContain('down >=    1.000  ✓');   // 1.05 >= 1.0
    expect(text).toContain('up   <=    0.600  ✗');   // 1.05 not <= 0.6
    expect(text).toContain('dwell      300');
  });

  it('shows a not-calibrated notice when no profile is active', () => {
    const handle = createDebugOverlay(true)!;
    handle.report({
      kind: 'eye', faceSeen: true, pitch: 0.8, gazeY: 0.1,
      downThreshold: null, upThreshold: null, calibrated: false, dwellMs: 0, dir: null
    });
    const block = document.querySelector<HTMLElement>('[data-kind="eye"]')!;
    expect(block.textContent).toContain('not calibrated');
  });

  it('renders hand fields with state and dx/v ticks', () => {
    const handle = createDebugOverlay(true)!;
    handle.report({
      kind: 'hand', palmSeen: true, palmOpen: true, x: 0.5,
      dxFromArmed: 0.4, dtMs: 150, velocity: 2.0, state: 'ARMED',
      dxThreshold: 0.3, vThreshold: 0.4, calibrated: false
    });
    const block = document.querySelector<HTMLElement>('[data-kind="hand"]')!;
    const text = block.textContent ?? '';
    expect(text).toContain('HAND');
    expect(text).toContain('state      ARMED');
    expect(text).toContain('dx         0.40  >= 0.30  ✓');
    expect(text).toContain('v          2.00  >= 0.40  ✓');
  });

  it('renders hand fields with active dx/v thresholds and cal flag', () => {
    const handle = createDebugOverlay(true)!;
    handle.report({
      kind: 'hand', palmSeen: true, palmOpen: true, x: 0.5,
      dxFromArmed: 0.4, dtMs: 0, velocity: 2.0, state: 'ARMED',
      dxThreshold: 0.3, vThreshold: 0.4, calibrated: false
    });
    const text = document.querySelector<HTMLElement>('[data-kind="hand"]')!.textContent ?? '';
    expect(text).toContain('dx         0.40  >= 0.30  ✓');
    expect(text).toContain('v          2.00  >= 0.40  ✓');
    expect(text).toContain('cal        ✗');
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
