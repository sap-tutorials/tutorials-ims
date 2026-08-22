// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest';
import { computeGazeFrame } from './eye-tracking';

// Build a landmark array with only the indices computeGazeFrame reads.
// Indices: 1 (nose), 33/133 (right corners), 263/362 (left corners),
// 468 (right iris), 473 (left iris).
function lmWith(overrides: Record<number, { x: number; y: number }>) {
  const arr = Array.from({ length: 478 }, () => ({ x: 0, y: 0, z: 0 }));
  for (const [i, p] of Object.entries(overrides)) arr[+i] = { ...p, z: 0 };
  return arr;
}

// A neutral, forward-looking face at a fixed scale.
function neutralFace(irisY: number) {
  return lmWith({
    33:  { x: 0.30, y: 0.50 }, 133: { x: 0.40, y: 0.50 },   // right eye corners
    263: { x: 0.70, y: 0.50 }, 362: { x: 0.60, y: 0.50 },   // left eye corners
    468: { x: 0.35, y: irisY }, 473: { x: 0.65, y: irisY },  // iris centers
    1:   { x: 0.50, y: 0.55 }                                // nose slightly below eye line
  });
}

describe('computeGazeFrame', () => {
  it('gazeY increases as the iris moves down', () => {
    const up = computeGazeFrame(neutralFace(0.48));    // iris above corner line
    const down = computeGazeFrame(neutralFace(0.56));  // iris below corner line
    expect(down.gazeY).toBeGreaterThan(up.gazeY);
  });

  it('is stable across a simulated blink (eyelids move, corners do not)', () => {
    // Our metric reads corners+iris only, never eyelids — so a blink that would
    // move lid landmarks must not change gazeY. Same corners+iris → same value.
    const a = computeGazeFrame(neutralFace(0.52));
    const b = computeGazeFrame(neutralFace(0.52));
    expect(b.gazeY).toBeCloseTo(a.gazeY, 6);
  });

  it('is invariant to uniform distance scaling', () => {
    const near = neutralFace(0.56);
    // Move face "farther": scale all coords toward the centroid (0.5,0.5) by 0.5.
    const far = near.map((p) => ({ x: 0.5 + (p.x - 0.5) * 0.5, y: 0.5 + (p.y - 0.5) * 0.5, z: 0 }));
    expect(computeGazeFrame(far).gazeY).toBeCloseTo(computeGazeFrame(near).gazeY, 4);
  });

  it('headForward is false when the nose drops far below the eye line', () => {
    const head = neutralFace(0.52);
    head[1] = { x: 0.5, y: 0.95, z: 0 };  // nose way down → head tilted down
    expect(computeGazeFrame(head).headForward).toBe(false);
  });
});
