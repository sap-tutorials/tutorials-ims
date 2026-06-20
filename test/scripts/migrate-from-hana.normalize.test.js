/**
 * Unit tests for the status-normalization helpers exported by
 * scripts/migrate-from-hana.js.
 *
 * Issue #477 — Java IMS source uses TASK_STATUS=NULL to mean "active" and
 * 'DELETED' for soft-deleted; there are no 'ACTIVE' literals in source.
 * CAP catalog filters require strict status='ACTIVE' (catalog-data.js:137),
 * so without normalization at migration time /build/catalog returns zero
 * missions/groups. Java IMS also has no `published` column at all; CAP's
 * implicit `false` default leaves migrated missions/groups invisible. The
 * 2026-06-20 DEV re-migration required 6 manual SQL UPDATEs to unblock
 * /build/catalog — these tests pin the helpers that fix the source bug.
 */
import { describe, it, expect } from 'vitest';
import {
  normalizeStatus,
  derivePublished,
} from '../../scripts/migrate-from-hana.js';

describe('normalizeStatus()', () => {
  it('treats NULL as ACTIVE (Java IMS source convention)', () => {
    expect(normalizeStatus(null)).toBe('ACTIVE');
  });

  it('treats undefined as ACTIVE', () => {
    expect(normalizeStatus(undefined)).toBe('ACTIVE');
  });

  it('treats empty string as ACTIVE', () => {
    expect(normalizeStatus('')).toBe('ACTIVE');
  });

  it('preserves DELETED literal', () => {
    expect(normalizeStatus('DELETED')).toBe('DELETED');
  });

  it('case-normalizes deleted → DELETED', () => {
    expect(normalizeStatus('deleted')).toBe('DELETED');
  });

  it('preserves ACTIVE literal', () => {
    expect(normalizeStatus('ACTIVE')).toBe('ACTIVE');
  });

  it('case-normalizes active → ACTIVE', () => {
    expect(normalizeStatus('active')).toBe('ACTIVE');
  });
});

describe('derivePublished()', () => {
  it('NULL source → published=true (active rows are visible)', () => {
    expect(derivePublished(null)).toBe(true);
  });

  it('empty string → published=true', () => {
    expect(derivePublished('')).toBe(true);
  });

  it('DELETED source → published=false', () => {
    expect(derivePublished('DELETED')).toBe(false);
  });

  it('case-insensitive: deleted → published=false', () => {
    expect(derivePublished('deleted')).toBe(false);
  });

  it('ACTIVE source → published=true', () => {
    expect(derivePublished('ACTIVE')).toBe(true);
  });
});
