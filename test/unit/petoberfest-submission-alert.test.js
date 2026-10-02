// test/unit/petoberfest-submission-alert.test.js
// Pure, I/O-free tests for the Petoberfest moderation-queue alert builder (#2597).
// Mirrors the channel-submission builder test: assert the ANS envelope shape
// without touching alerting.raise / the DB.
import { describe, test, expect } from 'vitest';
import { buildPetoberfestSubmissionAlert } from '../../srv/lib/petoberfest-upload.js';

describe('buildPetoberfestSubmissionAlert', () => {
  test('returns null when there is no submission id (nothing to announce)', () => {
    expect(buildPetoberfestSubmissionAlert({})).toBeNull();
    expect(buildPetoberfestSubmissionAlert({ petName: 'Rex' })).toBeNull();
  });

  test('builds a NOTICE envelope with pet name, uploader name, contest and a deep link', () => {
    const alert = buildPetoberfestSubmissionAlert({
      id: 'abc-123',
      petName: 'Rex',
      uploaderName: 'Tom Jung',
      contestTitle: 'Petoberfest 2026',
    });
    expect(alert).toMatchObject({
      eventType: 'PetoberfestSubmissionPending',
      severity: 'NOTICE',
    });
    expect(alert.subject).toContain('Rex');
    expect(alert.body).toContain('Rex');
    expect(alert.body).toContain('Tom Jung');
    expect(alert.body).toContain('Petoberfest 2026');
    // Deep link into the admin moderation queue (shell inbound Petoberfest-manage).
    expect(alert.body).toContain('/admin-ui/#Petoberfest-manage');
  });

  test('falls back to uploaderEmail when uploaderName is null (common: token lacks given/family name)', () => {
    const alert = buildPetoberfestSubmissionAlert({
      id: 'abc-123',
      petName: 'Rex',
      uploaderName: null,
      uploaderEmail: 'tom@example.com',
      contestTitle: 'Petoberfest 2026',
    });
    expect(alert.body).toContain('tom@example.com');
    expect(alert.body).not.toContain('null');
  });

  test('falls back to a generic entrant label when both name and email are absent', () => {
    const alert = buildPetoberfestSubmissionAlert({ id: 'abc-123', contestSlug: 'petoberfest-2026' });
    expect(alert.body).toContain('an entrant');
    expect(alert.body).not.toContain('undefined');
    // Uses contestSlug when contestTitle is absent.
    expect(alert.body).toContain('petoberfest-2026');
  });
});
