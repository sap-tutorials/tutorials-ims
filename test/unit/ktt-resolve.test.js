import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

describe('ktt-service identity resolution (#2552)', () => {
  const src = readFileSync(new URL('../../srv/ktt-service.js', import.meta.url), 'utf8');

  it('no longer mis-keys Users by req.user.id', () => {
    expect(src).not.toMatch(/where\(\{\s*sapId:\s*req\.user\.id\s*\}\)/);
  });

  it('resolves the user via the shared resolver', () => {
    expect(src).toMatch(/resolveDbUser\s*\(\s*req\.user/);
  });
});
