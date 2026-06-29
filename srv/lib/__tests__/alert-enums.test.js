import { describe, it, expect } from 'vitest';
import {
  ALERT_SEVERITIES,
  ALERT_AUDIENCES,
  listAlertSeverities,
  listAlertAudiences,
} from '../alert-enums.js';

describe('alert-enums', () => {
  it('ALERT_SEVERITIES mirrors the four db/schema.cds enum values', () => {
    expect(ALERT_SEVERITIES.map((s) => s.code)).toEqual([
      'Information', 'Success', 'Warning', 'Error',
    ]);
  });

  it('ALERT_AUDIENCES mirrors the three db/schema.cds enum values', () => {
    expect(ALERT_AUDIENCES.map((a) => a.code)).toEqual([
      'ALL', 'AUTHENTICATED', 'ADMIN',
    ]);
  });

  it('every entry has a string code and a string label', () => {
    for (const e of [...ALERT_SEVERITIES, ...ALERT_AUDIENCES]) {
      expect(typeof e.code).toBe('string');
      expect(typeof e.label).toBe('string');
      expect(e.code.length).toBeGreaterThan(0);
      expect(e.label.length).toBeGreaterThan(0);
    }
  });

  it('listAlertSeverities() returns a fresh shallow copy each call', () => {
    const a = listAlertSeverities();
    const b = listAlertSeverities();
    expect(a).not.toBe(b);
    expect(a).toEqual(b);
    a.pop();
    expect(listAlertSeverities()).toHaveLength(ALERT_SEVERITIES.length);
  });

  it('listAlertAudiences() returns a fresh shallow copy each call', () => {
    const a = listAlertAudiences();
    const b = listAlertAudiences();
    expect(a).not.toBe(b);
    expect(a).toEqual(b);
  });
});
