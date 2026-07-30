import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { KNOWN_TAGS } from '../../srv/lib/homepage/persona-tag-validator.js';

const KNOWN = new Set(KNOWN_TAGS);
const VERBS = new Set(['LEARN', 'BUILD', 'INTEGRATE', 'MODEL', 'OPERATE', 'AI', 'CONNECT']);
const SHELVES = new Set(['START_HERE', 'REFERENCE', 'TOOLS', 'KEEP_CURRENT']);

const jsonUrl = new URL('../../db/data/staging/homepage-thirdparty.json', import.meta.url);
const csvUrl = new URL('../../db/data/com.sap.developers.ims-HomepageShelves.csv', import.meta.url);

const raw = JSON.parse(readFileSync(fileURLToPath(jsonUrl), 'utf-8'));
const rows = raw.filter((r) => !r._comment);

const csvText = readFileSync(fileURLToPath(csvUrl), 'utf-8');
const csvLines = csvText.split(/\r?\n/).filter((l) => l.trim());
const csvHeader = csvLines[0].split(';');
const idIdx = csvHeader.indexOf('ID');
const verbIdx = csvHeader.indexOf('verb');
const urlIdx = csvHeader.indexOf('url');
const csvIds = new Set(csvLines.slice(1).map((l) => l.split(';')[idIdx]));
const csvVerbUrls = new Set(csvLines.slice(1).map((l) => {
  const c = l.split(';');
  return `${c[verbIdx]}|${c[urlIdx]}`;
}));

describe('homepage-thirdparty staging data', () => {
  it('parses to a non-empty array of content rows', () => {
    expect(Array.isArray(raw)).toBe(true);
    expect(rows.length).toBe(20);
  });

  it('every row has required fields with correct fixed values', () => {
    for (const r of rows) {
      expect(typeof r.ID).toBe('string');
      expect(VERBS.has(r.verb)).toBe(true);
      expect(SHELVES.has(r.shelf)).toBe(true);
      expect(Number.isInteger(r.sortOrder)).toBe(true);
      expect(r.title.length).toBeGreaterThan(0);
      expect(r.title.length).toBeLessThanOrEqual(120);
      expect(r.description.length).toBeLessThanOrEqual(280);
      expect(r.tagline.length).toBeLessThanOrEqual(140);
      expect(r.whyItMatters.length).toBeLessThanOrEqual(800);
      expect(r.badge).toBe('THIRD_PARTY');
      expect(r.isExternal).toBe(true);
      expect(r.isActive).toBe(true);
      expect(r.authoringStatus).toBe('REVIEWED');
      expect(r.personaWeight).toBe(0);
    }
  });

  it('every url is absolute https', () => {
    for (const r of rows) {
      expect(r.url.startsWith('https://')).toBe(true);
    }
  });

  it('every persona tag is in KNOWN_TAGS', () => {
    for (const r of rows) {
      expect(Array.isArray(r.personaTags)).toBe(true);
      for (const t of r.personaTags) {
        expect(KNOWN.has(t)).toBe(true);
      }
    }
  });

  it('(verb,url) pairs are unique within the file', () => {
    const seen = new Set();
    for (const r of rows) {
      const key = `${r.verb}|${r.url}`;
      expect(seen.has(key)).toBe(false);
      seen.add(key);
    }
  });

  it('does not collide with existing canonical CSV on ID or (verb,url)', () => {
    for (const r of rows) {
      expect(csvIds.has(r.ID)).toBe(false);
      expect(csvVerbUrls.has(`${r.verb}|${r.url}`)).toBe(false);
    }
  });
});
