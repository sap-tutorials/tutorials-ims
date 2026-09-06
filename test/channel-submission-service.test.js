// test/channel-submission-service.test.js
import cds from '@sap/cds';
import { describe, test, expect } from 'vitest';

const project = cds.test('serve', '--project', '.', '--in-memory');
// 'developer' is a mocked user with the 'authenticated-user' role (see .cdsrc.json)
const authUser = { auth: { username: 'developer', password: 'developer' } };
const NS = 'com.sap.developers.ims';
const linked = () => cds.linked(cds.model).entities(NS);

describe('ChannelSubmissionService', () => {
  test('anonymous CREATE is rejected 401', async () => {
    await expect(
      project.post('/channel-submissions/Submissions', { kind: 'ADD', proposed: '{}' }),
    ).rejects.toMatchObject({ response: { status: 401 } });
  });

  test('authenticated CREATE stamps submitterId + forces PENDING, ignores client-sent status/reviewer', async () => {
    // Use a unique rationale so we can find this specific row in the DB after INSERT.
    // @insertonly entities return a minimal/empty response body in CAP 10; we verify
    // server-stamped fields by selecting the persisted row directly (matches model-test
    // patterns in this repo, e.g. channel-collections-model.test.js).
    const unique = `test-submit-${Date.now()}`;
    const { status: httpStatus } = await project.post(
      '/channel-submissions/Submissions',
      { kind: 'ADD', proposed: '{"name":"X","url":"https://x"}', rationale: unique,
        status: 'APPROVED', submitterId: 'spoofed', reviewerId: 'spoofed', reviewNote: 'spoofed' },
      authUser,
    );
    // CAP 10 returns 204 No Content for @insertonly entities (no SELECT round-trip)
    expect([201, 204]).toContain(httpStatus);
    const row = await SELECT.one.from(linked().ChannelSubmissions).where({ rationale: unique });
    expect(row).toBeTruthy();
    expect(row.status).toBe('PENDING');
    expect(row.submitterId).toBe('developer');
    expect(row.reviewerId).toBeNull();
    expect(row.reviewNote).toBeNull();
  });

  test('service is insert-only — READ is rejected 405 Method Not Allowed', async () => {
    // CAP 10 answers a READ on an @insertonly entity with 405 (not a generic 4xx/5xx).
    // Asserting the exact code proves the entity is insert-only rather than merely erroring.
    await expect(
      project.get('/channel-submissions/Submissions', authUser),
    ).rejects.toMatchObject({ response: { status: 405 } });
  });

  test('EDIT without a target channel is rejected at submit time (400)', async () => {
    await expect(
      project.post('/channel-submissions/Submissions', { kind: 'EDIT', proposed: '{}' }, authUser),
    ).rejects.toMatchObject({ response: { status: 400 } });
  });

  test('REMOVE without a target channel is rejected at submit time (400)', async () => {
    await expect(
      project.post('/channel-submissions/Submissions', { kind: 'REMOVE', proposed: '{}' }, authUser),
    ).rejects.toMatchObject({ response: { status: 400 } });
  });
});
