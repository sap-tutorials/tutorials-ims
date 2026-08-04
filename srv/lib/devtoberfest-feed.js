// Pure helpers for the public Devtoberfest schedule feed. No cds/db access here
// so they are trivially unit-testable; the route module does the DB reads.

function normalizeSlugSet(rows) {
  const set = new Set();
  for (const r of rows || []) {
    const slug = r.slug ?? r.TASKSLUG ?? r.taskSlug;
    if (slug) set.add(String(slug).toLowerCase());
  }
  return set;
}

function assembleFeed({ sessions = [], activities = [], tracks = [], editions = [], activeEditionId = null, speakers = [], sessionSpeakers = [] }) {
  const trackById = new Map(tracks.map((t) => [t.ID, t]));
  const mapTrack = (id) => trackById.get(id) || {};
  const speakerById = new Map(speakers.map((sp) => [sp.ID, sp]));
  const speakersBySession = new Map();
  for (const link of sessionSpeakers) {
    const arr = speakersBySession.get(link.SESSION_ID) || [];
    arr.push(link);
    speakersBySession.set(link.SESSION_ID, arr);
  }
  const speakerFor = (sessionId) => (speakersBySession.get(sessionId) || [])
    .slice()
    .sort((a, b) => (a.SPEAKERORDER || 0) - (b.SPEAKERORDER || 0))
    .map((link) => {
      const sp = speakerById.get(link.SPEAKER_ID) || {};
      const name = `${sp.FIRSTNAME || ''} ${sp.LASTNAME || ''}`.trim();
      return { id: link.SPEAKER_ID, name, role: sp.ROLE || '', company: sp.COMPANY || '', photoUrl: `/api/devtoberfest/speaker/${link.SPEAKER_ID}/photo` };
    });
  return {
    activeEditionId,
    editions: editions
      .map((e) => ({ id: e.ID, name: e.NAME, year: e.YEAR, isCurrent: !!e.ISCURRENT, startsAt: e.STARTSAT, endsAt: e.ENDSAT, timeZone: e.TIMEZONE }))
      .sort((a, b) => String(b.year || '').localeCompare(String(a.year || ''))),
    sessions: sessions
      .map((s) => ({
        id: s.ID, kind: 'session', title: s.TITLE, abstract: s.ABSTRACT,
        trackId: s.TRACK_ID, trackName: mapTrack(s.TRACK_ID).NAME || '', trackDay: mapTrack(s.TRACK_ID).DAYOFWEEK || '',
        trackColor: mapTrack(s.TRACK_ID).COLOR || '', trackEmoji: mapTrack(s.TRACK_ID).EMOJI || '',
        week: s.WEEK, scheduledStart: s.SCHEDULEDSTART, scheduledTimeZone: s.SCHEDULEDTIMEZONE, recordingStart: s.RECORDINGSTART,
        youtubeUrl: s.YOUTUBEURL || '', communityEventUrl: s.COMMUNITYEVENTURL || '',
        linkedinUrl: s.LINKEDINURL || '',
        speakers: speakerFor(s.ID),
        activityId: s.ACTIVITY_ID || null, status: s.STATUS,
      }))
      .sort(sortByWeekThenDate),
    activities: activities
      .map((a) => ({
        id: a.ID, kind: 'activity', title: a.TITLE, week: a.WEEK, points: a.POINTS || 0,
        trackId: a.TRACK_ID, trackName: mapTrack(a.TRACK_ID).NAME || '',
        taskType: a.TASKTYPE, taskSlug: a.TASKSLUG, taskTitle: a.TASKTITLE, taskId: a.TASK_ID, status: a.STATUS,
      }))
      .sort(sortByWeekThenTitle),
  };
}

function completedActivityPoints(activities = [], completedSlugSet = new Set()) {
  let earnedPoints = 0;
  let maxPoints = 0;
  const completedActivityIds = [];
  for (const a of activities) {
    const pts = a.POINTS || a.points || 0;
    maxPoints += pts;
    const slug = (a.TASKSLUG || a.taskSlug || '').toLowerCase();
    if (slug && completedSlugSet.has(slug)) {
      earnedPoints += pts;
      completedActivityIds.push(a.ID || a.id);
    }
  }
  return { earnedPoints, maxPoints, completedActivityIds };
}

function sortByWeekThenDate(a, b) {
  const w = String(a.week || '').localeCompare(String(b.week || ''), undefined, { numeric: true });
  return w !== 0 ? w : String(a.scheduledStart || '').localeCompare(String(b.scheduledStart || ''));
}
function sortByWeekThenTitle(a, b) {
  const w = String(a.week || '').localeCompare(String(b.week || ''), undefined, { numeric: true });
  return w !== 0 ? w : String(a.title || '').localeCompare(String(b.title || ''));
}

export { assembleFeed, completedActivityPoints, normalizeSlugSet };
