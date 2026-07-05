import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';

describe('graphql breaking-change guard (#996)', () => {
  it('graphql/.last-release.graphql exists', () => {
    expect(existsSync('graphql/.last-release.graphql')).toBe(true);
  });

  it('current schema is additive-compatible with .last-release.graphql', async () => {
    const { diffSchemas } = await import('../../scripts/check-graphql-breaking.ts');
    const oldSdl = readFileSync('graphql/.last-release.graphql', 'utf8');
    const newSdl = readFileSync('graphql/schema.graphql', 'utf8');
    const result = diffSchemas(oldSdl, newSdl);
    // Breaking changes are only allowed if the outgoing element is @deprecated.
    const unmitigated = result.breaking.filter(b => !b.deprecated);
    if (unmitigated.length) {
      console.error('Unmitigated breaking changes:', unmitigated);
    }
    expect(unmitigated).toEqual([]);
  });
});
