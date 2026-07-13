// test/unit/community-blogs-staleness.test.js
//
// (#1033 follow-up) Guards the freshness/staleness alarm added to the
// community-blogs-fetch job. The job may return HTTP 200 yet ingest 0 NEW
// posts for days (the exact mode that went unnoticed for 4 days). The alarm
// throws so the cron chassis records JobLastRun.lastErrorAt + PipelineLog
// FAILED — the admin-visible surfaces a thrown job error already hits.
//
// fetchAllSources is mocked so these tests never touch the network; the
// staleness logic reads the real in-memory CommunityBlogPosts table.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import cds from '@sap/cds';

vi.mock('../../srv/lib/community-blogs-fetcher.js', () => ({
  fetchAllSources: vi.fn(),
}));

import { fetchAllSources } from '../../srv/lib/community-blogs-fetcher.js';
import {
  runCommunityBlogsFetch,
  readStaleHours,
  newestPostAgeHours,
} from '../../srv/jobs/community-blogs-fetch-job.js';

cds.test('serve', '--project', '.', '--in-memory');

const CLEAN_SUMMARY = { sources: 3, fetched: 60, inserted: 0, updated: 60, skippedLang: 0, skippedUrl: 0, errored: 0 };

async function clearPosts(db) {
  const { CommunityBlogPosts } = cds.entities('com.sap.developers.ims');
  await db.run(DELETE.from(CommunityBlogPosts));
}

async function insertPostCreatedHoursAgo(db, hours) {
  const { CommunityBlogPosts } = cds.entities('com.sap.developers.ims');
  const createdAt = new Date(Date.now() - hours * 3_600_000).toISOString();
  await db.run(INSERT.into(CommunityBlogPosts).entries({
    ID: cds.utils.uuid(),
    sourceUrl: `https://community.sap.com/t5/x/ba-p/${Math.floor(hours)}-${Date.now()}`,
    title: 'Fixture post',
    createdAt,
  }));
}

describe('readStaleHours', () => {
  afterEach(() => { delete process.env.COMMUNITY_BLOGS_STALE_HOURS; });

  it('defaults to 48 when unset', () => {
    delete process.env.COMMUNITY_BLOGS_STALE_HOURS;
    expect(readStaleHours()).toBe(48);
  });
  it('honors an explicit value', () => {
    process.env.COMMUNITY_BLOGS_STALE_HOURS = '12';
    expect(readStaleHours()).toBe(12);
  });
  it('honors 0 (disable)', () => {
    process.env.COMMUNITY_BLOGS_STALE_HOURS = '0';
    expect(readStaleHours()).toBe(0);
  });
  it('falls back to 48 on garbage / negative', () => {
    process.env.COMMUNITY_BLOGS_STALE_HOURS = 'abc';
    expect(readStaleHours()).toBe(48);
    process.env.COMMUNITY_BLOGS_STALE_HOURS = '-5';
    expect(readStaleHours()).toBe(48);
  });
});

describe('newestPostAgeHours', () => {
  let db;
  beforeEach(async () => { db = await cds.connect.to('db'); await clearPosts(db); });
  afterEach(async () => { await clearPosts(db); });

  it('returns null on an empty table (fresh env — not stale)', async () => {
    expect(await newestPostAgeHours(db)).toBeNull();
  });
  it('returns the age of the newest row in whole hours', async () => {
    await insertPostCreatedHoursAgo(db, 50);
    await insertPostCreatedHoursAgo(db, 3); // newest
    const age = await newestPostAgeHours(db);
    expect(age).toBeGreaterThanOrEqual(2);
    expect(age).toBeLessThanOrEqual(4);
  });
});

describe('runCommunityBlogsFetch staleness alarm', () => {
  let db;
  beforeEach(async () => {
    db = await cds.connect.to('db');
    await clearPosts(db);
    vi.mocked(fetchAllSources).mockResolvedValue({ ...CLEAN_SUMMARY });
    delete process.env.COMMUNITY_BLOGS_STALE_HOURS;
  });
  afterEach(async () => {
    await clearPosts(db);
    delete process.env.COMMUNITY_BLOGS_STALE_HOURS;
    vi.clearAllMocks();
  });

  it('does NOT throw on a fresh feed (recent post, clean tick)', async () => {
    await insertPostCreatedHoursAgo(db, 2);
    await expect(runCommunityBlogsFetch()).resolves.toMatchObject({ inserted: 0 });
  });

  it('does NOT throw on an empty table (fresh env)', async () => {
    await expect(runCommunityBlogsFetch()).resolves.toBeTruthy();
  });

  it('THROWS when the newest post is older than the threshold', async () => {
    process.env.COMMUNITY_BLOGS_STALE_HOURS = '24';
    await insertPostCreatedHoursAgo(db, 100); // 100h > 24h
    await expect(runCommunityBlogsFetch()).rejects.toThrow(/feed is stale/i);
  });

  it('does NOT throw when staleness is disabled (threshold 0)', async () => {
    process.env.COMMUNITY_BLOGS_STALE_HOURS = '0';
    await insertPostCreatedHoursAgo(db, 500); // ancient, but alarm disabled
    await expect(runCommunityBlogsFetch()).resolves.toBeTruthy();
  });

  it('still throws the all-errored alarm before reaching staleness', async () => {
    vi.mocked(fetchAllSources).mockResolvedValue({ ...CLEAN_SUMMARY, errored: 3, fetched: 0, updated: 0 });
    await insertPostCreatedHoursAgo(db, 2); // fresh — staleness would NOT fire
    await expect(runCommunityBlogsFetch()).rejects.toThrow(/all 3 sources errored/i);
  });
});
