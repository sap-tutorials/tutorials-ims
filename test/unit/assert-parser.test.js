// test/unit/assert-parser.test.js
import { describe, it, expect, vi } from 'vitest';
import { parseAssertBlocks, attachAssertSpecs } from '../../scripts/parsers/assert.ts';

const RULES = `
[ASSERT_1]
###Type
cmd
###Run
cds compile srv
###Expect
exit 0
###Match
Deployed
[ASSERT_1]
###Type
http
###Method
get
###Path
/catalog/Books
###Expect
status 200
[ASSERT_2]
###Type
file
###Path
srv/cat-service.cds
###Expect
contains
###Match
service CatalogService
`;

describe('parseAssertBlocks', () => {
  it('parses all three types; multi-assert step keyed by ascending assertIndex', () => {
    const map = parseAssertBlocks(RULES);
    expect([...map.keys()].sort()).toEqual([1, 2]);

    const step1 = map.get(1);
    expect(step1).toHaveLength(2);
    expect(step1[0]).toMatchObject({ index: 0, stepNumber: 1, type: 'cmd', run: 'cds compile srv', expectExit: 0, match: 'Deployed' });
    expect(step1[1]).toMatchObject({ index: 1, stepNumber: 1, type: 'http', method: 'GET', path: '/catalog/Books', expectStatus: 200 });

    const step2 = map.get(2);
    expect(step2).toHaveLength(1);
    expect(step2[0]).toMatchObject({ index: 0, stepNumber: 2, type: 'file', filePath: 'srv/cat-service.cds', expectContains: true, match: 'service CatalogService' });
  });

  it('file exists → expectContains:false, no match required', () => {
    const map = parseAssertBlocks(`[ASSERT_3]\n###Type\nfile\n###Path\na/b.cds\n###Expect\nexists\n`);
    expect(map.get(3)[0]).toMatchObject({ type: 'file', filePath: 'a/b.cds', expectContains: false });
    expect(map.get(3)[0].match).toBeUndefined();
  });

  it('warn-and-skip: unknown type, missing Run, missing Match on contains, stray marker', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    warn.mockClear();
    expect(parseAssertBlocks(`[ASSERT_1]\n###Type\nquantum\n`).size).toBe(0);
    expect(warn.mock.calls.length).toBeGreaterThan(0); // unknown type warns

    warn.mockClear();
    expect(parseAssertBlocks(`[ASSERT_1]\n###Type\ncmd\n###Expect\nexit 0\n`).size).toBe(0); // no Run
    expect(warn.mock.calls.length).toBeGreaterThan(0);

    warn.mockClear();
    expect(parseAssertBlocks(`[ASSERT_1]\n###Type\nfile\n###Path\na\n###Expect\ncontains\n`).size).toBe(0); // no Match
    expect(warn.mock.calls.length).toBeGreaterThan(0);

    warn.mockClear();
    expect(parseAssertBlocks(`[ASSERT_1]\n`).size).toBe(0); // stray marker, no subsections
    expect(warn.mock.calls.length).toBeGreaterThan(0); // missing ###Type warns

    warn.mockRestore();
  });

  it('parseExpect rejects wrong keyword: cmd with "status" instead of "exit" is dropped', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const map = parseAssertBlocks(`[ASSERT_1]\n###Type\ncmd\n###Run\ncds build\n###Expect\nstatus 0\n`);
    expect(map.size).toBe(0); // rejected because parseExpect('status 0', 'exit') returns null
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe('attachAssertSpecs', () => {
  it('sets step.asserts on matching steps and returns the flat sidecar array', () => {
    const map = parseAssertBlocks(RULES);
    const steps = [{ number: 1, title: 'One' }, { number: 2, title: 'Two' }, { number: 3, title: 'Three' }];
    const sidecar = attachAssertSpecs(steps, map);
    expect(steps[0].asserts).toHaveLength(2);
    expect(steps[1].asserts).toHaveLength(1);
    expect(steps[2].asserts).toBeUndefined();
    expect(sidecar).toHaveLength(3); // 2 + 1 flattened
  });

  it('skips specs whose step number has no matching step', () => {
    const map = parseAssertBlocks(`[ASSERT_9]\n###Type\nfile\n###Path\nx\n###Expect\nexists\n`);
    const steps = [{ number: 1, title: 'One' }];
    expect(attachAssertSpecs(steps, map)).toHaveLength(0);
    expect(steps[0].asserts).toBeUndefined();
  });
});
