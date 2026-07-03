// Phase A1 (#809) — Regression guard. The top-level `authorities` array in
// xs-security.json is auto-granted to every authenticated JWT. Prior to A1
// it contained `$XSAPPNAME.Tutorial.Author`, which defeated the `Tutorials
// Author` role-collection design (any authenticated user got QA-preview
// access). This test locks the auto-grant down to `Everyone` only.
//
// If a future change must re-add a scope here, update this test AND
// document the operational impact in xsuaa-role-collection-assignment.md.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';

describe('xs-security.json — top-level authorities auto-grant', () => {
  const cfg = JSON.parse(
    readFileSync(join(process.cwd(), 'xs-security.json'), 'utf8')
  );

  it('exposes an authorities array', () => {
    expect(Array.isArray(cfg.authorities)).toBe(true);
  });

  it('auto-grants ONLY $XSAPPNAME.Everyone (no other scopes)', () => {
    expect(cfg.authorities).toEqual(['$XSAPPNAME.Everyone']);
  });

  it('does not auto-grant Tutorial.Author (A1 regression)', () => {
    expect(cfg.authorities).not.toContain('$XSAPPNAME.Tutorial.Author');
  });
});
