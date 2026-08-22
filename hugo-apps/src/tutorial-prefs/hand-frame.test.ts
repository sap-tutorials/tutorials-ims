// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest';
import { computeHandFrame } from './hand-gestures';

// Indices read: 0 (wrist), 9 (middle MCP, for palm center), tips 8/12/16/20,
// pips 6/10/14/18.
function hand(overrides: Record<number, { x: number; y: number }>) {
  const arr = Array.from({ length: 21 }, () => ({ x: 0.5, y: 0.5, z: 0 }));
  for (const [i, p] of Object.entries(overrides)) arr[+i] = { ...p, z: 0 };
  return arr;
}

// Open hand pointing up: wrist low (large y), tips far above pips.
function openHandUp() {
  return hand({
    0: { x: 0.5, y: 0.9 }, 9: { x: 0.5, y: 0.5 },
    6: { x: 0.42, y: 0.55 }, 8: { x: 0.42, y: 0.30 },
    10: { x: 0.50, y: 0.55 }, 12: { x: 0.50, y: 0.28 },
    14: { x: 0.58, y: 0.55 }, 16: { x: 0.58, y: 0.30 },
    18: { x: 0.66, y: 0.58 }, 20: { x: 0.66, y: 0.34 }
  });
}

describe('computeHandFrame', () => {
  it('detects an open palm pointing up', () => {
    expect(computeHandFrame(openHandUp()).palmOpen).toBe(true);
  });

  it('detects an open palm held sideways (tilt-invariant radial test)', () => {
    // Rotate the open hand ~90°: fingers now extend in +x, not −y. The old
    // strict tip.y<mcp.y test failed this; the radial test must still pass.
    const h = openHandUp().map((p) => ({ x: 0.5 + (0.5 - p.y), y: 0.5 + (p.x - 0.5), z: 0 }));
    expect(computeHandFrame(h).palmOpen).toBe(true);
  });

  it('rejects a fist (tips curled toward the wrist)', () => {
    const fist = hand({
      0: { x: 0.5, y: 0.9 }, 9: { x: 0.5, y: 0.5 },
      6: { x: 0.42, y: 0.55 }, 8: { x: 0.44, y: 0.62 },
      10: { x: 0.50, y: 0.55 }, 12: { x: 0.50, y: 0.62 },
      14: { x: 0.58, y: 0.55 }, 16: { x: 0.56, y: 0.62 },
      18: { x: 0.66, y: 0.55 }, 20: { x: 0.64, y: 0.62 }
    });
    expect(computeHandFrame(fist).palmOpen).toBe(false);
  });

  it('mirrors x so palm on the user-right yields larger x', () => {
    // palmCenterX small (left of image) → user's right in a selfie view → x large.
    const left = hand({ 0: { x: 0.2, y: 0.9 }, 9: { x: 0.2, y: 0.5 } });
    const right = hand({ 0: { x: 0.8, y: 0.9 }, 9: { x: 0.8, y: 0.5 } });
    expect(computeHandFrame(left).x).toBeGreaterThan(computeHandFrame(right).x);
  });
});
