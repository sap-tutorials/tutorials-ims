import { describe, it, expect } from 'vitest';
import {
  SCHEMA_VERSION,
  assertSchemaVersion,
  VALID_REGIONS,
  VALID_LINK_KINDS,
  advocateTableInfo,
  isHanaDb,
} from '../../scripts/lib/advocate-io.cjs';

describe('advocate-io helpers', () => {
  describe('SCHEMA_VERSION', () => {
    it('is 1 for the initial release', () => {
      expect(SCHEMA_VERSION).toBe(1);
    });
  });

  describe('assertSchemaVersion', () => {
    it('accepts the current schema version', () => {
      expect(() => assertSchemaVersion({ schemaVersion: 1 })).not.toThrow();
    });

    it('rejects an older schema version with a clear message', () => {
      expect(() => assertSchemaVersion({ schemaVersion: 0 })).toThrow(
        /schemaVersion 0/
      );
    });

    it('rejects a future schema version with a clear message', () => {
      expect(() => assertSchemaVersion({ schemaVersion: 2 })).toThrow(
        /schemaVersion 2/
      );
    });

    it('rejects a payload missing schemaVersion', () => {
      expect(() => assertSchemaVersion({})).toThrow(/missing schemaVersion/i);
    });
  });

  describe('VALID_REGIONS', () => {
    it('lists exactly the regions from the CDS enum', () => {
      expect([...VALID_REGIONS].sort()).toEqual(['AMERICAS', 'APJ', 'EMEA']);
    });
  });

  describe('VALID_LINK_KINDS', () => {
    it('matches the CDS AdvocateLinks.kind enum', () => {
      expect([...VALID_LINK_KINDS].sort()).toEqual([
        'Blog', 'BlueSky', 'Email', 'GitHub', 'LinkedIn',
        'Mastodon', 'Other', 'SapCommunity', 'X', 'YouTube',
      ]);
    });
  });

  describe('advocateTableInfo(isHana)', () => {
    it('returns UPPERCASE unquoted-style identifiers for HANA', () => {
      const t = advocateTableInfo(true);
      expect(t.advocates).toBe('COM_SAP_DEVELOPERS_IMS_ADVOCATES');
      expect(t.topics).toBe('COM_SAP_DEVELOPERS_IMS_ADVOCATETOPICS');
      expect(t.links).toBe('COM_SAP_DEVELOPERS_IMS_ADVOCATELINKS');
      expect(t.photos).toBe('COM_SAP_DEVELOPERS_IMS_ADVOCATEPHOTOS');
      expect(t.users).toBe('COM_SAP_DEVELOPERS_IMS_USERS');
      expect(t.tags).toBe('COM_SAP_DEVELOPERS_IMS_TAGS');
      expect(t.cols.slug).toBe('SLUG');
      expect(t.cols.firstName).toBe('FIRSTNAME');
      expect(t.cols.userFk).toBe('USER_ID');
      expect(t.cols.advocateFk).toBe('ADVOCATE_ID');
      expect(t.cols.tagFk).toBe('TAG_ID');
    });

    it('returns mixed-case CDS-style identifiers for SQLite', () => {
      const t = advocateTableInfo(false);
      expect(t.advocates).toBe('com_sap_developers_ims_Advocates');
      expect(t.topics).toBe('com_sap_developers_ims_AdvocateTopics');
      expect(t.links).toBe('com_sap_developers_ims_AdvocateLinks');
      expect(t.photos).toBe('com_sap_developers_ims_AdvocatePhotos');
      expect(t.users).toBe('com_sap_developers_ims_Users');
      expect(t.tags).toBe('com_sap_developers_ims_Tags');
      expect(t.cols.slug).toBe('slug');
      expect(t.cols.firstName).toBe('firstName');
      expect(t.cols.userFk).toBe('user_ID');
      expect(t.cols.advocateFk).toBe('advocate_ID');
      expect(t.cols.tagFk).toBe('tag_ID');
    });
  });

  describe('isHanaDb', () => {
    it('returns true for { kind: "hana" }', () => {
      expect(isHanaDb({ kind: 'hana' })).toBe(true);
    });

    it('returns true for { kind: "HANA" } (case-insensitive)', () => {
      expect(isHanaDb({ kind: 'HANA' })).toBe(true);
    });

    it('returns false for { kind: "sqlite" }', () => {
      expect(isHanaDb({ kind: 'sqlite' })).toBe(false);
    });

    it('returns false for null / undefined db', () => {
      expect(isHanaDb(null)).toBe(false);
      expect(isHanaDb(undefined)).toBe(false);
    });
  });
});
