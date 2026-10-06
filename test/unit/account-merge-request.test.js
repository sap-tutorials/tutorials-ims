import { describe, it, expect, beforeAll } from 'vitest';
import cds from '@sap/cds';
cds.test('serve', '--project', '.', '--in-memory');
describe('AccountMergeRequests schema', () => {
  it('entity exists with expected elements', async () => {
    const { AccountMergeRequests } = cds.entities('com.sap.developers.ims');
    expect(AccountMergeRequests).toBeTruthy();
    expect(AccountMergeRequests.elements.tokenHashHex).toBeTruthy();
    expect(AccountMergeRequests.elements.requesterUser).toBeTruthy();
  });
});
