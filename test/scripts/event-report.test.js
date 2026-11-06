import { describe, it, expect } from 'vitest';
import { parseEventId, renderTrackSection } from '../../scripts/event-report.mjs';

describe('parseEventId', () => {
  it('returns a bare id unchanged', () => {
    expect(parseEventId('10000003')).toBe('10000003');
  });

  it('extracts eventId from an app-space URL', () => {
    expect(
      parseEventId('https://developers.sap.com/app-space/?eventId=10000003&theme=joule'),
    ).toBe('10000003');
  });

  it('throws when a URL has no eventId', () => {
    expect(() => parseEventId('https://developers.sap.com/app-space/?theme=x')).toThrow();
  });
});

describe('renderTrackSection', () => {
  it('renders total + a track row with count and share', () => {
    const md = renderTrackSection(
      { buckets: [{ bucketName: 'ABAP', count: 227, percentage: 6.9 }], totalCompletions: 3285 },
      { name: 'E' },
    );
    expect(md).toContain('Total completions: 3,285');
    expect(md).toContain('ABAP');
    expect(md).toContain('227');
    expect(md).toContain('6.9%');
  });

  it('reports no completions instead of an empty table', () => {
    const md = renderTrackSection({ buckets: [], totalCompletions: 0 }, { name: 'E' });
    expect(md).toMatch(/no completions/i);
  });
});
