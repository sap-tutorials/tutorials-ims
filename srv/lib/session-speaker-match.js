// srv/lib/session-speaker-match.js
//
// Match a person (advocate / author) to the conference sessions they SPEAK at,
// across two event sources with different identity keys (issue #2354):
//
//   - Devtoberfest sessions (srv/lib/devtoberfest-feed.js `assembleFeed`) —
//     speakers carry a real EMAIL upstream, so we match on email first and fall
//     back to a normalized-name match. `assembleFeed` itself DROPS email from
//     its speaker DTO, so the caller must supply `speakerEmailById`
//     (speakerId → email) out of band from the raw Speaker rows.
//   - SAP TechEd sessions (GET /build/teched, srv/lib/teched-feed.js) — the
//     RainFocus source exposes NO speaker email (verified: parseSpeakers reads
//     no email alias; the real fixture has zero email keys), so TechEd can only
//     be matched on normalized name. Document the reliability caveat: name
//     collisions and "Tom" vs "Thomas" drift are possible.
//
// PURE module: no cds/db imports, trivially unit-testable. Every entry point is
// fail-open — an empty/undefined feed, missing speaker arrays, or a person with
// no email AND no name yields an empty array and never throws. Callers wrap the
// (impure) feed loads in their own try/catch for the cross-container facades.

/**
 * Normalize a display name for equality comparison: lowercase, strip diacritics
 * (NFKD + drop combining marks so "José" == "Jose"), drop punctuation, collapse
 * whitespace. Returns '' for empty/blank input.
 */
export function normalizeName(s) {
  if (!s || typeof s !== 'string') return '';
  return s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')   // combining marks
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')       // punctuation → space
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Normalize an email for equality comparison: lowercase + trim. Returns '' for
 * empty/blank input.
 */
function normalizeEmail(s) {
  if (!s || typeof s !== 'string') return '';
  return s.trim().toLowerCase();
}

// Full name for a person from {firstName,lastName} or a pre-joined {name}.
function personName(person) {
  if (!person) return '';
  if (person.name) return person.name;
  return `${person.firstName || ''} ${person.lastName || ''}`.trim();
}

/**
 * Map a Devtoberfest assembled-feed session → the shared session-card DTO.
 * Prefers the community-event URL, then the YouTube recording.
 */
function devtoberfestCard(session) {
  return toSessionCard(
    {
      title: session.title,
      sourceUrl: session.communityEventUrl || session.youtubeUrl || '',
      track: session.trackName || '',
      venue: 'Devtoberfest',
      date: session.scheduledStart || null,
    },
    'devtoberfest',
  );
}

/**
 * Map a TechEd feed session (GET /build/teched) → the shared session-card DTO.
 * `trackNameBySlug` resolves the session's track slug to a display name.
 * Prefers the catalog URL, then the YouTube recording.
 */
function techedCard(session, trackNameBySlug) {
  const trackSlug = session.track || '';
  return toSessionCard(
    {
      title: session.title,
      sourceUrl: session.url || session.youtubeUrl || '',
      track: (trackSlug && trackNameBySlug?.get?.(trackSlug)) || trackSlug || '',
      venue: session.venue || '',
      date: session.scheduledStart || null,
    },
    'teched',
  );
}

/**
 * The one card shape rendered by both the Hugo partial (authors) and the Vue
 * SessionCard (advocates). `event` is 'teched' | 'devtoberfest'.
 */
export function toSessionCard(src, event) {
  const s = src || {};
  return {
    event,
    title: s.title || '',
    sourceUrl: s.sourceUrl || '',
    track: s.track || '',
    venue: s.venue || '',
    date: s.date || null,
  };
}

/**
 * Devtoberfest: sessions where `person` is a speaker.
 * @param person {email?, name?, firstName?, lastName?}
 * @param feed the assembleFeed() result ({ sessions: [{..., speakers:[{id,name}]}] })
 * @param speakerEmailById Map<speakerId, email> supplied by the caller (feed drops email)
 * Email-first, normalized-name fallback. Fail-open → [].
 */
export function matchDevtoberfestSessions(person, feed, speakerEmailById = new Map()) {
  const sessions = feed?.sessions;
  if (!Array.isArray(sessions) || !sessions.length) return [];

  const wantEmail = normalizeEmail(person?.email);
  const wantName = normalizeName(personName(person));
  if (!wantEmail && !wantName) return [];

  const out = [];
  for (const session of sessions) {
    const speakers = Array.isArray(session?.speakers) ? session.speakers : [];
    const hit = speakers.some((sp) => {
      if (wantEmail) {
        const spEmail = normalizeEmail(speakerEmailById.get?.(sp?.id));
        if (spEmail && spEmail === wantEmail) return true;
      }
      return wantName && normalizeName(sp?.name) === wantName;
    });
    if (hit) out.push(devtoberfestCard(session));
  }
  return out;
}

/**
 * TechEd: sessions where `person` is a speaker. Normalized-name match ONLY
 * (source carries no speaker email). Fail-open → [].
 * @param feed GET /build/teched result ({ sessions:[{..., speakers:[slug]}], speakers:[{slug,name}], tracks:[{slug,name}] })
 */
export function matchTechEdSessions(person, feed) {
  const sessions = feed?.sessions;
  if (!Array.isArray(sessions) || !sessions.length) return [];

  const wantName = normalizeName(personName(person));
  if (!wantName) return [];

  const speakerList = Array.isArray(feed.speakers) ? feed.speakers : [];
  // Every slug whose speaker name matches the person.
  const matchingSlugs = new Set(
    speakerList
      .filter((sp) => normalizeName(sp?.name) === wantName)
      .map((sp) => sp?.slug)
      .filter(Boolean),
  );
  if (!matchingSlugs.size) return [];

  const trackNameBySlug = new Map(
    (Array.isArray(feed.tracks) ? feed.tracks : [])
      .filter((t) => t?.slug)
      .map((t) => [t.slug, t.name || '']),
  );

  const out = [];
  for (const session of sessions) {
    const slugs = Array.isArray(session?.speakers) ? session.speakers : [];
    if (slugs.some((slug) => matchingSlugs.has(slug))) {
      out.push(techedCard(session, trackNameBySlug));
    }
  }
  return out;
}

/**
 * Convenience: both event kinds for one person as { teched, devtoberfest }.
 */
export function matchAllSessions(person, { techedFeed, devtoberfestFeed, speakerEmailById } = {}) {
  return {
    teched: matchTechEdSessions(person, techedFeed),
    devtoberfest: matchDevtoberfestSessions(person, devtoberfestFeed, speakerEmailById),
  };
}
