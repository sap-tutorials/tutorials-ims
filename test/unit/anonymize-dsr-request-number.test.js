// test/unit/anonymize-dsr-request-number.test.js
// Regression test for the 2026-06-22 fix where _executeAnonymization was
// dropping the dsrRequestNumber input on the persisted PrivacyProtectionActions
// row. The bound action `anonymizeByDsrRequest(sapId, dsrRequestNumber)`
// accepted both params and passed them down, but the INSERT only wrote
// userUuid/actionType/requestedAt/status/legacyId — dsrRequestNumber went
// to the audit-log SecurityEvent but not to the entity row itself.
//
// Schema extension in PR #554 added the column; this test asserts the
// handler now persists it.

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import cds from '@sap/cds';

const project = cds.test('serve', '--project', '.', '--in-memory');

const ADMIN_USER = { id: 'admin@test', roles: ['Admin'] };
const TEST_DSR = 'DSR-2026-06-22-REGRESSION';
const TEST_SAP_ID = 'C9999999';

describe('anonymizeByDsrRequest persists dsrRequestNumber (#554 regression)', () => {
  let Users, PrivacyProtectionActions;

  beforeAll(() => {
    ({ Users, PrivacyProtectionActions } = cds.entities('com.sap.developers.ims'));
  });

  beforeEach(async () => {
    await DELETE.from(PrivacyProtectionActions);
    await DELETE.from(Users).where({ sapId: TEST_SAP_ID });
    await INSERT.into(Users).entries({
      ID: cds.utils.uuid(),
      uuid: cds.utils.uuid(),
      sapId: TEST_SAP_ID,
      email: 'test@example.com',
      legacyId: 9999999,
    });
  });

  it('writes the DSR# to the audit row (was silently dropped pre-PR-#554)', async () => {
    const srv = await cds.connect.to('AdminService');
    await srv.tx({ user: ADMIN_USER }, (tx) =>
      tx.send({
        event: 'anonymizeByDsrRequest',
        data: { sapId: TEST_SAP_ID, dsrRequestNumber: TEST_DSR },
      })
    );

    const rows = await SELECT.from(PrivacyProtectionActions).where({ actionType: 'ANONYMIZE' });
    expect(rows.length).toBeGreaterThan(0);
    // Regression assertion: the row must carry the DSR#, NOT null.
    expect(rows[0].dsrRequestNumber).toBe(TEST_DSR);
    expect(rows[0].createdBy).toBe('admin@test');
  });

  it('still anonymizes successfully when dsrRequestNumber is null (anonymizeUser, no DSR row)', async () => {
    const srv = await cds.connect.to('AdminService');
    await srv.tx({ user: ADMIN_USER }, (tx) =>
      tx.send({ event: 'anonymizeUser', data: { sapId: TEST_SAP_ID } })
    );

    // anonymizeUser does NOT write a PrivacyProtectionActions row (only DSR-
    // tagged anonymizations get audit-table entries; non-DSR ones rely on
    // the SecurityEvent audit log).
    const rows = await SELECT.from(PrivacyProtectionActions);
    expect(rows.length).toBe(0);
  });
});
