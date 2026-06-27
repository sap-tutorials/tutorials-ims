import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runFetchAdvocates } from '../../../scripts/fetch-advocates.ts';

const SAMPLE = {
  advocates: [
    {
      ID: 'A1', slug: 'thomas-jung', firstName: 'Thomas', lastName: 'Jung',
      title: 'Chief Developer Advocate', region: 'AMERICAS',
      hasPhoto: true, photoUpdatedAt: '2026-06-27T00:00:00Z',
      bio: '**Hello** world\n\nLine 2',
      topics: [{ slug: 'cap', label: 'CAP' }],
      links: [{ kind: 'LinkedIn', url: 'https://linkedin.com/in/x', label: null, sortOrder: 100 }],
    },
    {
      ID: 'A2', slug: 'stale-advocate', firstName: 'Stale', lastName: 'One',
      region: 'EMEA', hasPhoto: false, bio: '',
      topics: [], links: [],
    },
  ],
};

describe('fetch-advocates', () => {
  let tmpDir, contentDir, cacheDir;
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'fetch-advocates-'));
    contentDir = join(tmpDir, 'hugo/content/developer-advocates');
    cacheDir = join(tmpDir, '.tutorial-cache');
    mkdirSync(contentDir, { recursive: true });
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(join(contentDir, '_index.md'), '---\n---\n');
  });
  afterEach(() => { rmSync(tmpDir, { recursive: true, force: true }); });

  it('emits one .md per active advocate with rendered bioHtml', async () => {
    const fetcher = async () => SAMPLE;
    await runFetchAdvocates({ fetcher, contentDir, cacheDir });
    const jung = readFileSync(join(contentDir, 'thomas-jung.md'), 'utf8');
    expect(jung).toMatch(/slug: thomas-jung/);
    expect(jung).toMatch(/<strong>Hello<\/strong>/);
    expect(jung).toMatch(/region: AMERICAS/);
    expect(existsSync(join(contentDir, 'stale-advocate.md'))).toBe(true);
  });

  it('skips inactive advocates', async () => {
    const fetcher = async () => ({
      advocates: [
        { ...SAMPLE.advocates[0], isActive: false },
        SAMPLE.advocates[1],
      ],
    });
    await runFetchAdvocates({ fetcher, contentDir, cacheDir });
    expect(existsSync(join(contentDir, 'thomas-jung.md'))).toBe(false);
    expect(existsSync(join(contentDir, 'stale-advocate.md'))).toBe(true);
  });

  it('removes .md files for advocates no longer in the roster', async () => {
    writeFileSync(join(contentDir, 'gone-away.md'), '---\nslug: gone-away\n---\n');
    const fetcher = async () => SAMPLE;
    await runFetchAdvocates({ fetcher, contentDir, cacheDir });
    expect(existsSync(join(contentDir, 'gone-away.md'))).toBe(false);
    expect(existsSync(join(contentDir, '_index.md'))).toBe(true);
  });

  it('caches the roster JSON', async () => {
    let calls = 0;
    const fetcher = async () => { calls++; return SAMPLE; };
    await runFetchAdvocates({ fetcher, contentDir, cacheDir });
    await runFetchAdvocates({ fetcher, contentDir, cacheDir });
    expect(existsSync(join(cacheDir, 'advocates-roster.json'))).toBe(true);
    expect(calls).toBe(2);
  });

  it('escapes script payloads in bio', async () => {
    const fetcher = async () => ({
      advocates: [{
        ...SAMPLE.advocates[0],
        bio: 'Hi <script>alert(1)</script> there',
      }],
    });
    await runFetchAdvocates({ fetcher, contentDir, cacheDir });
    const jung = readFileSync(join(contentDir, 'thomas-jung.md'), 'utf8');
    expect(jung).not.toMatch(/<script>/);
  });
});
