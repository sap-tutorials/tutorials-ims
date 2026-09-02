// Pure, DOM-free helpers for the session broadcasting-format tag + filter
// (Live vs Prerecorded — issue #2110). Shared by the sessions grid, calendar,
// and schedule-table views plus the DetailPanel so the visual tag and the
// "Format" filter behave identically everywhere.
//
// The feed normalizes the free-text planner field to exactly 'Live',
// 'PreRecorded', or null (see srv/lib/devtoberfest-feed.js
// normalizeBroadcastingPreference). Sessions with no preference (null) show no
// tag and are excluded from both the Live and Prerecorded filters.

export type BroadcastPref = 'Live' | 'PreRecorded' | null | undefined;

export interface BroadcastTag {
  /** Canonical value ('Live' | 'PreRecorded'). */
  readonly value: 'Live' | 'PreRecorded';
  /** Human-readable pill label. */
  readonly label: string;
  /** CSS modifier suffix, e.g. 'live' → .sg-badge--live. */
  readonly modifier: string;
  /** Small leading glyph for the pill. */
  readonly icon: string;
}

/**
 * Map a normalized broadcasting preference to its display tag, or null when
 * unset/unrecognized (→ no tag rendered).
 */
export function broadcastingTag(pref: BroadcastPref): BroadcastTag | null {
  if (pref === 'Live') return { value: 'Live', label: 'Live', modifier: 'live', icon: '🔴' };
  if (pref === 'PreRecorded') return { value: 'PreRecorded', label: 'Prerecorded', modifier: 'prerecorded', icon: '▶' };
  return null;
}

/** Filter dropdown options, in display order. Empty value = no filter. */
export const FORMAT_FILTER_OPTIONS: ReadonlyArray<{ value: string; label: string }> = Object.freeze([
  { value: '', label: 'All formats' },
  { value: 'Live', label: 'Live' },
  { value: 'PreRecorded', label: 'Prerecorded' },
]);

/**
 * Does a session's preference satisfy the current Format filter? An empty
 * filter matches everything; a set filter requires an exact match, so null
 * (unset) sessions are excluded from both Live and Prerecorded.
 */
export function matchesFormat(pref: BroadcastPref, filter: string | null | undefined): boolean {
  if (!filter) return true;
  return pref === filter;
}
