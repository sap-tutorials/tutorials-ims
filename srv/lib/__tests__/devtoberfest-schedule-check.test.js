// Unit tests for the Devtoberfest schedule-consistency check (issue #2103).
import { describe, it, expect } from 'vitest';
import {
  extractYouTubeVideoId,
  extractCommunityMessageId,
  classifyLeg,
  assembleScheduleCheck,
  fetchYouTubeScheduledStarts,
  fetchCommunityStartTimes,
  buildScheduleCheckReport,
} from '../devtoberfest-schedule-check.js';

describe('extractYouTubeVideoId', () => {
  it('parses watch?v= URLs', () => {
    expect(extractYouTubeVideoId('https://www.youtube.com/watch?v=5u2Z6hR7-28')).toBe('5u2Z6hR7-28');
  });
  it('parses watch?v= with extra query params', () => {
    expect(extractYouTubeVideoId('https://www.youtube.com/watch?v=5u2Z6hR7-28&t=30s&list=abc')).toBe('5u2Z6hR7-28');
  });
  it('parses youtu.be short links', () => {
    expect(extractYouTubeVideoId('https://youtu.be/5u2Z6hR7-28')).toBe('5u2Z6hR7-28');
  });
  it('parses /live/ links', () => {
    expect(extractYouTubeVideoId('https://www.youtube.com/live/5u2Z6hR7-28?feature=share')).toBe('5u2Z6hR7-28');
  });
  it('returns null for non-YouTube / empty / malformed', () => {
    expect(extractYouTubeVideoId('https://zoom.us/j/123')).toBeNull();
    expect(extractYouTubeVideoId('')).toBeNull();
    expect(extractYouTubeVideoId(null)).toBeNull();
    expect(extractYouTubeVideoId('https://www.youtube.com/watch?v=tooShort')).toBeNull();
  });
});

describe('extractCommunityMessageId', () => {
  it('parses ev-p event URLs', () => {
    expect(extractCommunityMessageId('https://community.sap.com/t5/devtoberfest/intelligent-app/ev-p/14472839')).toBe('14472839');
  });
  it('strips query/hash', () => {
    expect(extractCommunityMessageId('https://community.sap.com/t5/x/ev-p/14472839?foo=1#bar')).toBe('14472839');
  });
  it('falls back to a bare trailing numeric segment', () => {
    expect(extractCommunityMessageId('https://community.sap.com/some/path/14472839/')).toBe('14472839');
  });
  it('returns null when no id is present', () => {
    expect(extractCommunityMessageId('https://community.sap.com/t5/devtoberfest')).toBeNull();
    expect(extractCommunityMessageId(null)).toBeNull();
  });
});

describe('classifyLeg', () => {
  const planned = '2026-10-09T12:30:00.000Z';
  it('no-url when the session has no asset URL', () => {
    expect(classifyLeg(planned, null, { hasUrl: false }).status).toBe('no-url');
  });
  it('unknown when URL present but external time unreadable', () => {
    expect(classifyLeg(planned, null, { hasUrl: true }).status).toBe('unknown');
    expect(classifyLeg(planned, 'not-a-date', { hasUrl: true }).status).toBe('unknown');
  });
  it('no-planner when external known but planner missing', () => {
    const r = classifyLeg(null, planned, { hasUrl: true });
    expect(r.status).toBe('no-planner');
    expect(r.externalStart).toBe(planned);
  });
  it('ok within tolerance', () => {
    // community sample: 14:30+02:00 == 12:30Z — exact match
    const r = classifyLeg(planned, '2026-10-09T14:30:00.000+02:00', { hasUrl: true, toleranceMinutes: 5 });
    expect(r.status).toBe('ok');
    expect(r.deltaMinutes).toBe(0);
  });
  it('ok at the tolerance boundary, drift just past it', () => {
    expect(classifyLeg(planned, '2026-10-09T12:35:00.000Z', { hasUrl: true, toleranceMinutes: 5 }).status).toBe('ok');
    expect(classifyLeg(planned, '2026-10-09T12:36:00.000Z', { hasUrl: true, toleranceMinutes: 5 }).status).toBe('drift');
  });
  it('reports signed delta minutes', () => {
    expect(classifyLeg(planned, '2026-10-09T13:00:00.000Z', { hasUrl: true }).deltaMinutes).toBe(30);
    expect(classifyLeg(planned, '2026-10-09T12:00:00.000Z', { hasUrl: true }).deltaMinutes).toBe(-30);
  });
});

describe('assembleScheduleCheck', () => {
  const sessions = [
    { ID: 's1', SESSIONCODE: 'DT100', TITLE: 'Aligned', SCHEDULEDSTART: '2026-10-09T12:30:00.000Z',
      YOUTUBEURL: 'https://youtu.be/aaaaaaaaaaa', COMMUNITYEVENTURL: 'https://community.sap.com/t5/x/ev-p/111' },
    { ID: 's2', SESSIONCODE: 'DT200', TITLE: 'YT drifted', SCHEDULEDSTART: '2026-10-09T12:30:00.000Z',
      YOUTUBEURL: 'https://www.youtube.com/watch?v=bbbbbbbbbbb', COMMUNITYEVENTURL: null },
    { ID: 's3', SESSIONCODE: 'DT300', TITLE: 'No URLs', SCHEDULEDSTART: '2026-10-09T12:30:00.000Z',
      YOUTUBEURL: null, COMMUNITYEVENTURL: null },
  ];
  const youtubeStartById = new Map([
    ['aaaaaaaaaaa', '2026-10-09T12:30:00.000Z'],   // aligned
    ['bbbbbbbbbbb', '2026-10-09T13:30:00.000Z'],   // +60 min → drift
  ]);
  const communityStartById = new Map([
    ['111', '2026-10-09T12:33:00.000Z'],           // +3 min → ok
  ]);

  it('classifies each leg and flags drift', () => {
    const rep = assembleScheduleCheck({ sessions, youtubeStartById, communityStartById, toleranceMinutes: 5 });
    const [r1, r2, r3] = rep.sessions;
    expect(r1.youtube.status).toBe('ok');
    expect(r1.community.status).toBe('ok');
    expect(r1.hasDrift).toBe(false);

    expect(r2.youtube.status).toBe('drift');
    expect(r2.youtube.deltaMinutes).toBe(60);
    expect(r2.community.status).toBe('no-url');
    expect(r2.hasDrift).toBe(true);

    expect(r3.youtube.status).toBe('no-url');
    expect(r3.community.status).toBe('no-url');
    expect(r3.hasDrift).toBe(false);
  });

  it('summarizes counts', () => {
    const rep = assembleScheduleCheck({ sessions, youtubeStartById, communityStartById, toleranceMinutes: 5 });
    expect(rep.summary.total).toBe(3);
    expect(rep.summary.withDrift).toBe(1);
    expect(rep.summary.youtube.ok).toBe(1);
    expect(rep.summary.youtube.drift).toBe(1);
    expect(rep.summary.youtube['no-url']).toBe(1);
  });

  it('marks a present-but-unresolved URL as unknown, never drift', () => {
    const rep = assembleScheduleCheck({
      sessions: [{ ID: 'x', SCHEDULEDSTART: '2026-10-09T12:30:00.000Z', YOUTUBEURL: 'https://youtu.be/ccccccccccc' }],
      youtubeStartById: new Map(),  // id not resolved
      toleranceMinutes: 5,
    });
    expect(rep.sessions[0].youtube.status).toBe('unknown');
    expect(rep.sessions[0].hasDrift).toBe(false);
  });
});

describe('fetchYouTubeScheduledStarts', () => {
  it('returns null for every id when no apiKey', async () => {
    const map = await fetchYouTubeScheduledStarts(['a', 'b'], { apiKey: '' });
    expect(map.get('a')).toBeNull();
    expect(map.get('b')).toBeNull();
  });

  it('maps scheduledStartTime, null when live details absent or id not returned', async () => {
    const fetchImpl = async () => ({
      ok: true,
      json: async () => ({ items: [
        { id: 'a', liveStreamingDetails: { scheduledStartTime: '2026-10-09T12:30:00Z' } },
        { id: 'b', liveStreamingDetails: {} },        // no scheduled time
        // 'c' not returned at all
      ] }),
    });
    const map = await fetchYouTubeScheduledStarts(['a', 'b', 'c'], { apiKey: 'k', fetchImpl });
    expect(map.get('a')).toBe('2026-10-09T12:30:00.000Z');
    expect(map.get('b')).toBeNull();
    expect(map.get('c')).toBeNull();
  });

  it('fails soft on non-ok response', async () => {
    const fetchImpl = async () => ({ ok: false, json: async () => ({}) });
    const map = await fetchYouTubeScheduledStarts(['a'], { apiKey: 'k', fetchImpl });
    expect(map.get('a')).toBeNull();
  });

  it('batches ids into groups of 50', async () => {
    const calls = [];
    const fetchImpl = async (url) => { calls.push(url); return { ok: true, json: async () => ({ items: [] }) }; };
    const ids = Array.from({ length: 120 }, (_, i) => `id${i}`);
    await fetchYouTubeScheduledStarts(ids, { apiKey: 'k', fetchImpl });
    expect(calls.length).toBe(3); // 50 + 50 + 20
  });
});

describe('fetchCommunityStartTimes', () => {
  it('maps occasion_data.start_time from a successful LiQL response', async () => {
    const fetchImpl = async () => ({
      ok: true,
      json: async () => ({ status: 'success', data: { items: [
        { id: '14472839', occasion_data: { start_time: '2026-10-09T14:30:00.000+02:00' } },
      ] } }),
    });
    const map = await fetchCommunityStartTimes(['14472839', '999'], { fetchImpl });
    expect(map.get('14472839')).toBe('2026-10-09T12:30:00.000Z'); // normalized to UTC
    expect(map.get('999')).toBeNull();
  });

  it('fails soft when status is not success', async () => {
    const fetchImpl = async () => ({ ok: true, json: async () => ({ status: 'error' }) });
    const map = await fetchCommunityStartTimes(['1'], { fetchImpl });
    expect(map.get('1')).toBeNull();
  });
});

describe('buildScheduleCheckReport (orchestrator)', () => {
  it('wires both fetchers and assembles a report', async () => {
    const sessions = [
      { ID: 's1', SESSIONCODE: 'DT1', SCHEDULEDSTART: '2026-10-09T12:30:00.000Z',
        YOUTUBEURL: 'https://youtu.be/aaaaaaaaaaa',
        COMMUNITYEVENTURL: 'https://community.sap.com/t5/x/ev-p/14472839' },
    ];
    const fetchImpl = async (url) => {
      if (url.includes('googleapis.com')) {
        return { ok: true, json: async () => ({ items: [{ id: 'aaaaaaaaaaa', liveStreamingDetails: { scheduledStartTime: '2026-10-09T12:30:00Z' } }] }) };
      }
      return { ok: true, json: async () => ({ status: 'success', data: { items: [{ id: '14472839', occasion_data: { start_time: '2026-10-09T14:30:00.000+02:00' } }] } }) };
    };
    const rep = await buildScheduleCheckReport(sessions, { apiKey: 'k', fetchImpl });
    expect(rep.sessions[0].youtube.status).toBe('ok');
    expect(rep.sessions[0].community.status).toBe('ok');
    expect(rep.summary.withDrift).toBe(0);
  });
});
