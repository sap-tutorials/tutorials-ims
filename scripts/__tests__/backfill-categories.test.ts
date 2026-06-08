import { describe, it, expect } from 'vitest';
import { parseArgs } from '../backfill-categories.cjs';

describe('parseArgs', () => {
  it('defaults kind=all, concurrency=4', () => {
    expect(parseArgs([])).toMatchObject({ kind: 'all', fromId: null, concurrency: 4, dryRun: false });
  });
  it('parses --kind=mission', () => {
    expect(parseArgs(['--kind=mission'])).toMatchObject({ kind: 'mission' });
  });
  it('parses --from-id <UUID>', () => {
    expect(parseArgs(['--from-id', 'abc-123'])).toMatchObject({ fromId: 'abc-123' });
  });
  it('parses --concurrency=8', () => {
    expect(parseArgs(['--concurrency=8'])).toMatchObject({ concurrency: 8 });
  });
  it('--dry-run is a boolean', () => {
    expect(parseArgs(['--dry-run'])).toMatchObject({ dryRun: true });
  });
  it('rejects unknown kind', () => {
    expect(() => parseArgs(['--kind=banana'])).toThrow();
  });
});
