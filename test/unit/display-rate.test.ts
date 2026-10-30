import { describe, it, expect } from 'vitest';
import { completionsPerHour } from '../../app/display-app/src/rate';

describe('completionsPerHour — "Tutorials Per Hour" counts EVERY completion', () => {
  it('returns 0 with fewer than 2 samples (cannot compute a rate yet)', () => {
    expect(completionsPerHour([])).toBe(0);
    expect(completionsPerHour([1000])).toBe(0);
  });

  it('extrapolates an hourly rate from timestamps spanning a short window', () => {
    // 4 completions across 2 seconds -> very high hourly extrapolation.
    const base = 1_000_000;
    const rate = completionsPerHour([base, base + 666, base + 1333, base + 2000]);
    // ~4 events / 2s => ~7200/hr ballpark; assert it's a large positive number.
    expect(rate).toBeGreaterThan(1000);
  });

  it('is driven by ALL completions, not only track-mapped ones (regression: per-hour stuck at 0)', () => {
    // The display must feed the rate from completionTick (every completion),
    // so a stream of untracked completions still produces a non-zero per-hour.
    const base = 2_000_000;
    const ts = Array.from({ length: 10 }, (_, i) => base + i * 500); // 10 over 4.5s
    expect(completionsPerHour(ts)).toBeGreaterThan(0);
  });
});
