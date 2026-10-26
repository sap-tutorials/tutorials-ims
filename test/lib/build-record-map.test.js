import { describe, it, expect } from 'vitest';
import { buildRecordMap } from '../../srv/lib/path-item-task-resolver.js';

describe('buildRecordMap', () => {
  it('prefers a COMPLETED record over SUPERSEDED for the same task, regardless of order', () => {
    // Order reversed from "natural" so last-write-wins would pick SUPERSEDED.
    const records = [
      { taskType: 'TUTORIAL', taskLegacyId: 10000027, status: 'COMPLETED', completionDate: '2026-10-26T21:08:00Z' },
      { taskType: 'TUTORIAL', taskLegacyId: 10000027, status: 'SUPERSEDED', completionDate: '2026-10-26T21:03:00Z' },
    ];
    const map = buildRecordMap(records);
    expect(map.get('TUTORIAL:10000027').status).toBe('COMPLETED');

    // And with COMPLETED first (so plain last-write-wins would have dropped it):
    const map2 = buildRecordMap([records[1], records[0]]);
    expect(map2.get('TUTORIAL:10000027').status).toBe('COMPLETED');
  });

  it('breaks status ties by latest completionDate', () => {
    const records = [
      { taskType: 'TUTORIAL', taskLegacyId: 5, status: 'SUPERSEDED', completionDate: '2023-01-01T00:00:00Z' },
      { taskType: 'TUTORIAL', taskLegacyId: 5, status: 'SUPERSEDED', completionDate: '2026-09-23T00:00:00Z' },
    ];
    expect(buildRecordMap(records).get('TUTORIAL:5').completionDate).toBe('2026-09-23T00:00:00Z');
  });

  it('keeps separate entries per (taskType, taskLegacyId)', () => {
    const records = [
      { taskType: 'TUTORIAL', taskLegacyId: 1, status: 'COMPLETED', completionDate: '2026-01-01T00:00:00Z' },
      { taskType: 'GROUP', taskLegacyId: 1, status: 'COMPLETED', completionDate: '2026-01-01T00:00:00Z' },
      { taskType: 'TUTORIAL', taskLegacyId: 2, status: 'IN_PROGRESS' },
    ];
    const map = buildRecordMap(records);
    expect(map.size).toBe(3);
    expect(map.get('TUTORIAL:1').taskType).toBe('TUTORIAL');
    expect(map.get('GROUP:1').taskType).toBe('GROUP');
  });

  it('ranks COMPLETED > SUPERSEDED > other (e.g. IN_PROGRESS)', () => {
    const records = [
      { taskType: 'TUTORIAL', taskLegacyId: 9, status: 'IN_PROGRESS' },
      { taskType: 'TUTORIAL', taskLegacyId: 9, status: 'COMPLETED', completionDate: '2026-10-26T21:00:00Z' },
      { taskType: 'TUTORIAL', taskLegacyId: 9, status: 'SUPERSEDED', completionDate: '2026-10-27T21:00:00Z' },
    ];
    // SUPERSEDED has a later date, but COMPLETED outranks it on status.
    expect(buildRecordMap(records).get('TUTORIAL:9').status).toBe('COMPLETED');
  });
});
