import { describe, it, expect } from 'vitest';
import { parsePayload, MAX_ROWS, MAX_BYTES } from '../../../srv/lib/tag-import/parser.js';

describe('parsePayload — CSV', () => {
  it('parses a valid 2-row CSV with required headers', () => {
    const csv = 'name,titlePath\nABAP,Languages:ABAP\nFiori,UI:Fiori';
    const { rows, parseErrors } = parsePayload(csv, 'csv');
    expect(rows).toEqual([
      { name: 'ABAP', titlePath: 'Languages:ABAP' },
      { name: 'Fiori', titlePath: 'UI:Fiori' }
    ]);
    expect(parseErrors).toEqual([]);
  });

  it('strips a UTF-8 BOM', () => {
    const csv = '﻿name,titlePath\nABAP,Languages:ABAP';
    const { rows } = parsePayload(csv, 'csv');
    expect(rows[0].name).toBe('ABAP');
  });

  it('trims values and ignores empty lines', () => {
    const csv = 'name,titlePath\n  ABAP  ,  Languages:ABAP  \n\n';
    const { rows } = parsePayload(csv, 'csv');
    expect(rows).toEqual([{ name: 'ABAP', titlePath: 'Languages:ABAP' }]);
  });

  it('throws when required headers missing', () => {
    expect(() => parsePayload('foo,bar\n1,2', 'csv')).toThrow(/required header/i);
  });

  it('marks rows with missing fields as invalid', () => {
    const csv = 'name,titlePath\nGood,Path\n,MissingName\nMissingPath,';
    const { rows } = parsePayload(csv, 'csv');
    expect(rows).toHaveLength(3);
    expect(rows[0]).toEqual({ name: 'Good', titlePath: 'Path' });
    expect(rows[1]).toMatchObject({ invalid: true, reason: expect.stringMatching(/name/i) });
    expect(rows[2]).toMatchObject({ invalid: true, reason: expect.stringMatching(/titlePath/i) });
  });

  it('marks rows that exceed 255 chars as invalid', () => {
    const longName = 'x'.repeat(256);
    const csv = `name,titlePath\n${longName},Path`;
    const { rows } = parsePayload(csv, 'csv');
    expect(rows[0]).toMatchObject({ invalid: true, reason: expect.stringMatching(/255/) });
  });

  it('drops within-file duplicates (case-insensitive) and reports them', () => {
    const csv = 'name,titlePath\nABAP,Path1\nabap,Path2\nFiori,Path3';
    const { rows, parseErrors } = parsePayload(csv, 'csv');
    expect(rows.map(r => r.name)).toEqual(['ABAP', 'Fiori']);
    expect(parseErrors).toContainEqual(expect.objectContaining({
      reason: expect.stringMatching(/duplicate/i)
    }));
  });

  it('rejects payload exceeding MAX_BYTES', () => {
    const big = 'x'.repeat(MAX_BYTES + 1);
    expect(() => parsePayload(big, 'csv')).toThrow(/payload/i);
  });

  it('rejects rows exceeding MAX_ROWS', () => {
    const lines = ['name,titlePath'];
    for (let i = 0; i < MAX_ROWS + 1; i++) lines.push(`tag${i},path${i}`);
    expect(() => parsePayload(lines.join('\n'), 'csv')).toThrow(/rows/i);
  });
});

describe('parsePayload — JSON', () => {
  it('parses a valid JSON array', () => {
    const json = JSON.stringify([
      { name: 'ABAP', titlePath: 'Languages:ABAP' }
    ]);
    const { rows } = parsePayload(json, 'json');
    expect(rows).toEqual([{ name: 'ABAP', titlePath: 'Languages:ABAP' }]);
  });

  it('rejects non-array JSON', () => {
    expect(() => parsePayload('{"name":"x","titlePath":"y"}', 'json'))
      .toThrow(/array/i);
  });

  it('marks JSON rows missing fields as invalid', () => {
    const json = JSON.stringify([{ name: 'Only' }]);
    const { rows } = parsePayload(json, 'json');
    expect(rows[0]).toMatchObject({ invalid: true });
  });
});

describe('parsePayload — format guard', () => {
  it('rejects unknown format', () => {
    expect(() => parsePayload('x', 'xml')).toThrow(/format/i);
  });
});
