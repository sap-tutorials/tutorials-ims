import { describe, it, expect, beforeEach } from 'vitest';
import { getRegistry, resetRegistry } from '../directive-registry.js';
import { registerAllDirectives } from '../directives/register-all.js';

// All directive families must be registered — and RE-ARMED after a registry
// reset — by the single register-all hub, so no family can silently go
// unregistered (the directive-ui-instructions raw-publish class). Each family's
// register fn is idempotent, so the hub calling them is safe alongside their
// own side-effect imports.
const EXPECTED_FAMILY_SENTINELS = [
  'ui', 'menu', 'icon', 'kbd', 'ask',          // ui.ts
  'details', 'troubleshoot', 'result', 'hint', 'solution', 'spoiler', // callout
  'cast', 'compare', 'diagram',                // rich-media leaves
  'figure', 'image',                           // figure
  'include', 'tutorial', 'note', 'help', 'api', 'since', 'requires',  // content-reuse
];

describe('register-all re-arms every directive family', () => {
  beforeEach(() => {
    resetRegistry();
  });

  it('registers all families with no throw after a reset', () => {
    expect(() => registerAllDirectives()).not.toThrow();
    const reg = getRegistry();
    const missing = EXPECTED_FAMILY_SENTINELS.filter((n) => !reg.has(n));
    expect(missing).toEqual([]);
  });

  it('is idempotent — a second call after reset does not throw', () => {
    registerAllDirectives();
    resetRegistry();
    // The hub's internal _registered flag is tripped; an empty registry must
    // still re-arm rather than skip. Call again and confirm it repopulates.
    expect(() => registerAllDirectives()).not.toThrow();
    expect(getRegistry().has('ui')).toBe(true);
    expect(getRegistry().has('details')).toBe(true);
    expect(getRegistry().has('figure')).toBe(true);
  });
});
