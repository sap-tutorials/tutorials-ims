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
  normalizeExperienceTag,
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

// Issue: PROD Groups (0/359) and Missions (0/888) were migrated without
// experienceTag because the migrator only selected EXPERIENCE_TAG_ID for
// Tutorials. Groups/Missions now map it via normalizeExperienceTag, which
// canonicalizes the IMS tag NAME onto the CAP ExperienceLevel enum
// (schema.cds:15, @assert.range). The migrated Tutorials stored raw mixed-case
// names ('Beginner'/'beginner'), half violating the lowercase enum — this
// helper deliberately does NOT replicate that.
describe('normalizeExperienceTag()', () => {
  it('lowercases canonical values', () => {
    expect(normalizeExperienceTag('beginner')).toBe('beginner');
    expect(normalizeExperienceTag('intermediate')).toBe('intermediate');
    expect(normalizeExperienceTag('advanced')).toBe('advanced');
  });

  it('canonicalizes mixed / upper case to the lowercase enum', () => {
    expect(normalizeExperienceTag('Beginner')).toBe('beginner');
    expect(normalizeExperienceTag('INTERMEDIATE')).toBe('intermediate');
    expect(normalizeExperienceTag('Advanced')).toBe('advanced');
  });

  it('trims surrounding whitespace', () => {
    expect(normalizeExperienceTag('  beginner ')).toBe('beginner');
  });

  it('returns null for null/undefined (field is nullable)', () => {
    expect(normalizeExperienceTag(null)).toBeNull();
    expect(normalizeExperienceTag(undefined)).toBeNull();
  });

  it('returns null for blank string', () => {
    expect(normalizeExperienceTag('')).toBeNull();
    expect(normalizeExperienceTag('   ')).toBeNull();
  });

  it('returns null for unknown tag names rather than an @assert.range violator', () => {
    expect(normalizeExperienceTag('Expert')).toBeNull();
    expect(normalizeExperienceTag('SAP HANA Cloud')).toBeNull();
    expect(normalizeExperienceTag('beginner-friendly')).toBeNull();
  });
});
