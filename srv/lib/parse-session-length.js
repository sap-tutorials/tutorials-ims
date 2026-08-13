// Pure helper: turn a planner Session's free-text SESSIONLENGTH (String(5000))
// into a duration in minutes. The planner facade has no explicit end datetime,
// so iCal DTEND / DURATION must be derived from this field. Best-effort parse of
// common human forms ("30 min", "1 hour", "1.5 hrs", "1h30m", bare "45"); falls
// back to `defaultMinutes` (60) when empty or unparseable. No cds/db access — so
// it is trivially unit-testable, matching the devtoberfest-feed.js helper split.

const DEFAULT_MINUTES = 60;

function parseSessionLengthMinutes(raw, defaultMinutes = DEFAULT_MINUTES) {
  const text = String(raw ?? '').trim().toLowerCase();
  if (!text) return defaultMinutes;

  let minutes = 0;
  let matched = false;

  // Hours: "1 hour", "2 hours", "1.5 hr", "1h", "1h30m" (decimal allowed).
  // Lookahead (not \b) so the compact "1h30m" form matches — there is no word
  // boundary between "h" and the following digit — while "hourly" still won't.
  const hourMatch = text.match(/(\d+(?:\.\d+)?)\s*(?:hours?|hrs?|h)(?![a-z])/);
  if (hourMatch) {
    minutes += parseFloat(hourMatch[1]) * 60;
    matched = true;
  }

  // Minutes: "30 min", "45 minutes", "15m", "20 mins".
  const minMatch = text.match(/(\d+(?:\.\d+)?)\s*(?:minutes?|mins?|m)(?![a-z])/);
  if (minMatch) {
    minutes += parseFloat(minMatch[1]);
    matched = true;
  }

  // No unit anywhere → treat a bare leading number as minutes ("45" → 45).
  if (!matched) {
    const bare = text.match(/(\d+(?:\.\d+)?)/);
    if (bare) {
      minutes = parseFloat(bare[1]);
      matched = true;
    }
  }

  const rounded = Math.round(minutes);
  if (!matched || !Number.isFinite(rounded) || rounded <= 0) return defaultMinutes;
  return rounded;
}

export { parseSessionLengthMinutes, DEFAULT_MINUTES };
