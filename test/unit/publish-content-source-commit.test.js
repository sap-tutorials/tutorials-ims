import { describe, it, expect } from 'vitest';
import { buildAppendBody } from '../../scripts/lib/publish-client.ts';

describe('appendBatch body', () => {
  it('includes sourceCommits when provided', () => {
    const body = buildAppendBody({ sessionId: 's', files: { a: 'x' }, sourceCommits: { a: 'sha1' } });
    expect(body.sourceCommits).toEqual({ a: 'sha1' });
  });
  it('omits sourceCommits key cleanly when absent', () => {
    const body = buildAppendBody({ sessionId: 's', files: { a: 'x' } });
    expect(body.sourceCommits).toBeUndefined();
  });
});
