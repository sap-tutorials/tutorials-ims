import { describe, expect, it } from 'vitest';
import { classifyTab, classifyGroup, forceClassify, OS_VALUES } from '../parsers/os-classifier';

describe('classifyTab — single-label canonicalization', () => {
  it.each([
    ['Windows', ['Windows']],
    ['windows', ['Windows']],
    ['Win', ['Windows']],
    ['Win32', ['Windows']],
    ['macOS', ['macOS']],
    ['Mac OS', ['macOS']],
    ['Mac', ['macOS']],
    ['OS X', ['macOS']],
    ['darwin', ['macOS']],
    ['Linux', ['Linux']],
    ['Ubuntu', ['Linux']],
    ['BAS', ['BAS']],
    ['Business Application Studio', ['BAS']],
    ['SAP BAS', ['BAS']],
    ['  Windows  ', ['Windows']],
    ['\tMac OS\n', ['macOS']],
  ])('classifies %s as %j', (label, expected) => {
    expect(classifyTab(label)).toEqual(expected);
  });

  it.each([
    ['Mac and Linux',     ['macOS', 'Linux']],
    ['Mac & Linux',       ['macOS', 'Linux']],
    ['MacOS / Linux',     ['macOS', 'Linux']],
    ['Linux & MacOS',     ['Linux', 'macOS']],
    ['MacOS and Linux',   ['macOS', 'Linux']],
    ['Linux and Mac OS',  ['Linux', 'macOS']],
    ['Mac, Linux',        ['macOS', 'Linux']],
    ['Windows and Mac',           ['Windows', 'macOS']],
    ['Windows and MacOS',         ['Windows', 'macOS']],
    ['Mac and Windows',           ['macOS', 'Windows']],
    ['Windows and Linux',         ['Windows', 'Linux']],
    ['Linux and Windows',         ['Linux', 'Windows']],
    ['Windows, MacOS and Linux',  ['Windows', 'macOS', 'Linux']],
    ['Windows, Linux and MacOS',  ['Windows', 'Linux', 'macOS']],
  ])('classifies combined label %s as %j', (label, expected) => {
    expect(classifyTab(label)).toEqual(expected);
  });

  it.each([
    'Cloud',
    'On-premise',
    'JSON',
    'XML',
    'Java',
    'Node.js',
    'SAP S/4HANA Cloud, ABAP Environment',
    'Create Individual Employee Record',
  ])('returns null for non-OS label %s', (label) => {
    expect(classifyTab(label)).toBeNull();
  });
});

describe('classifyGroup — group-level classification', () => {
  it('classifies all-OS group as os', () => {
    const r = classifyGroup(['Windows', 'Mac and Linux']);
    expect(r.kind).toBe('os');
    expect(r.assignments.get('Windows')).toEqual(['Windows']);
    expect(r.assignments.get('Mac and Linux')).toEqual(['macOS', 'Linux']);
  });

  it('returns regular when any tab is non-OS', () => {
    const r = classifyGroup(['Windows', 'Cloud']);
    expect(r.kind).toBe('regular');
    expect(r.assignments.size).toBe(0);
  });

  it('returns regular when only one canonical OS is covered (single-OS sanity)', () => {
    const r = classifyGroup(['Windows']);
    expect(r.kind).toBe('regular');
  });

  it('classifies as os when 2+ canonical OSes covered via combined labels', () => {
    const r = classifyGroup(['Windows', 'Mac and Linux']);
    expect(r.kind).toBe('os');
  });
});

describe('forceClassify — author override path', () => {
  it('classifies a single-OS group as os (skips the distinct-size sanity check)', () => {
    const r = forceClassify(['Windows']);
    expect(r.kind).toBe('os');
    expect(r.assignments.get('Windows')).toEqual(['Windows']);
  });

  it('still returns regular when any tab fails to classify', () => {
    const r = forceClassify(['Windows', 'Cloud']);
    expect(r.kind).toBe('regular');
    expect(r.assignments.size).toBe(0);
  });

  it('handles a single combined-label as os', () => {
    const r = forceClassify(['Mac and Linux']);
    expect(r.kind).toBe('os');
    expect(r.assignments.get('Mac and Linux')).toEqual(['macOS', 'Linux']);
  });
});

describe('OS_VALUES constant', () => {
  it('exports the four canonical OS values in fixed order', () => {
    expect(OS_VALUES).toEqual(['Windows', 'macOS', 'Linux', 'BAS']);
  });
});
