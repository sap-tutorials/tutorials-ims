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

function assembleFeed({ sessions = [], activities = [], tracks = [], editions = [], activeEditionId = null }) {
  const trackById = new Map(tracks.map((t) => [t.ID, t]));
  const mapTrack = (id) => trackById.get(id) || {};
  return {
    activeEditionId,
    editions: editions
      .map((e) => ({ id: e.ID, name: e.NAME, year: e.YEAR, isCurrent: !!e.ISCURRENT, startsAt: e.STARTSAT, endsAt: e.ENDSAT, timeZone: e.TIMEZONE }))
      .sort((a, b) => String(b.year || '').localeCompare(String(a.year || ''))),
    sessions: sessions
      .map((s) => ({
        id: s.ID, kind: 'session', title: s.TITLE, abstract: s.ABSTRACT,
        trackId: s.TRACK_ID, trackName: mapTrack(s.TRACK_ID).NAME || '', trackDay: mapTrack(s.TRACK_ID).DAYOFWEEK || '',
        week: s.WEEK, scheduledStart: s.SCHEDULEDSTART, scheduledTimeZone: s.SCHEDULEDTIMEZONE, recordingStart: s.RECORDINGSTART,
        youtubeUrl: s.YOUTUBEURL || '', communityEventUrl: s.COMMUNITYEVENTURL || '',
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

// Retain only completion rows whose completionDate falls within the edition's
// [start, end] window (inclusive). Points are earned by *participating during*
// Devtoberfest, so an all-time completion must not count. Fail-closed: if the
// window is not fully defined, or a row has no parseable completionDate, it is
// dropped rather than counted. `start`/`end` are ISO strings (Edition
// STARTSAT/ENDSAT); rows carry `completionDate` (see getMyCompletedTutorials).
function filterCompletionsWithinWindow(rows, start, end) {
  const startMs = start ? Date.parse(start) : NaN;
  const endMs = end ? Date.parse(end) : NaN;
  if (Number.isNaN(startMs) || Number.isNaN(endMs)) return [];
  return (rows || []).filter((r) => {
    const t = r?.completionDate ? Date.parse(r.completionDate) : NaN;
    return !Number.isNaN(t) && t >= startMs && t <= endMs;
  });
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

export { assembleFeed, completedActivityPoints, normalizeSlugSet, filterCompletionsWithinWindow };
