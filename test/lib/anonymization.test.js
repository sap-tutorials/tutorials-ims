import { describe, it, expect } from 'vitest';
import { buildAnonymizationOps } from '../../srv/lib/anonymization.js';

describe('anonymization', () => {

  describe('buildAnonymizationOps', () => {
    it('produces operations to anonymize a user', () => {
      const user = {
        ID: 'u1',
        sapId: 'S1234567',
        firstName: 'John',
        lastName: 'Doe',
        email: 'john@example.com',
        displayName: 'John Doe',
        avatarUrl: 'https://example.com/avatar.jpg'
      };

      const ops = buildAnonymizationOps(user);

      expect(ops.userUpdate).toEqual({
        ID: 'u1',
        sapId: null,
        firstName: 'ANONYMIZED',
        lastName: 'ANONYMIZED',
        email: null,
        displayName: 'ANONYMIZED',
        avatarUrl: null
      });
      expect(ops.deleteMetadata).toBe(true);
      expect(ops.auditFieldsValue).toBe('ANONYMIZED');
    });

    it('handles already-anonymized user gracefully', () => {
      const user = {
        ID: 'u1',
        sapId: null,
        firstName: 'ANONYMIZED',
        lastName: 'ANONYMIZED',
        email: null,
        displayName: 'ANONYMIZED',
        avatarUrl: null
      };

      const ops = buildAnonymizationOps(user);
      expect(ops.userUpdate.sapId).toBeNull();
      expect(ops.userUpdate.firstName).toBe('ANONYMIZED');
    });
  });
});
