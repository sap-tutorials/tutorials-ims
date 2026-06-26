import { describe, it, expect } from 'vitest';
import { classifyRebuildMode } from '../../srv/lib/_classify-rebuild-mode.js';

// Unit-shaped sanity test (no HANA dependency), placed under test/hybrid/
// alongside the Alerts hybrid suite for #548 visibility.

describe('Alerts rebuild classification', () => {
  it("returns mode='none' for Alerts CRUD", () => {
    expect(classifyRebuildMode('Alerts', 'crud').mode).toBe('none');
  });
});
