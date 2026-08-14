import { describe, it, expect } from 'vitest';
import { stampSubmissionId } from '../../srv/lib/task-record-submission-id.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

describe('stampSubmissionId', () => {
  it('stamps submissionIdCompleted on a COMPLETED INSERT target', () => {
    const t = stampSubmissionId({ status: 'COMPLETED' });
    expect(t.submissionIdCompleted).toMatch(UUID_RE);
    expect(t.submissionIdStarted).toBeUndefined();
  });

  it('stamps submissionIdStarted on an IN_PROGRESS INSERT target', () => {
    const t = stampSubmissionId({ status: 'IN_PROGRESS' });
    expect(t.submissionIdStarted).toMatch(UUID_RE);
    expect(t.submissionIdCompleted).toBeUndefined();
  });

  it('is a no-op for SUPERSEDED (and any non-completion status)', () => {
    expect(stampSubmissionId({ status: 'SUPERSEDED' })).toEqual({ status: 'SUPERSEDED' });
  });

  it('uses existing row status on an UPDATE .set() with no status', () => {
    const set = stampSubmissionId({ progress: 100 }, { status: 'COMPLETED' });
    expect(set.submissionIdCompleted).toMatch(UUID_RE);
  });

  it('honors only-if-null: keeps an id already on the existing row', () => {
    const set = stampSubmissionId({ status: 'COMPLETED' }, { status: 'IN_PROGRESS', submissionIdCompleted: 'keep-me' });
    expect(set.submissionIdCompleted).toBeUndefined(); // not re-generated onto target
  });

  it('honors only-if-null: keeps an id already on the target', () => {
    const t = stampSubmissionId({ status: 'COMPLETED', submissionIdCompleted: 'preset' });
    expect(t.submissionIdCompleted).toBe('preset');
  });
});
