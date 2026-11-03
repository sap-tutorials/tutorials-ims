/**
 * Pure time-aggregation helper for the App Space track overview.
 *
 * Extracted to a sibling module (same pattern as app-space-gating.ts /
 * checkpoint-barcode.ts) so AppSpace.vue and tests can share it without mounting
 * the full component.
 *
 * #3007 "Average time to complete": a track's headline time must NOT sum every
 * tutorial when the track branches. A branch is an OPTIONAL choice — the learner
 * walks one path, not all of them — so summing every alternative overstates the
 * time (the TechEd "Joule Agent Lab" fork reported the combined time of both
 * branches). Instead:
 *
 *   - linear       (mandatory run of items)        → SUM every tutorial
 *   - parallel-any (pick ANY ONE of N tutorials)   → AVERAGE the N tutorial times
 *   - fork         (pick ONE of N lanes/groups)    → AVERAGE the N per-lane totals
 *
 * Track total = sum of linear times + the per-branch averages. "Average" here is
 * exactly the issue's definition: sum of the optional paths' times divided by the
 * number of optional paths. Only TUTORIAL items carry time (synthetic prize
 * CHECKPOINTs are timeToComplete 0), so non-tutorials wash out of the math.
 */

export interface TimeItem {
  type: 'TUTORIAL' | 'CHECKPOINT' | 'PRIZE'
  timeToComplete: number
}

export interface TimeForkLane {
  label: string
  items: TimeItem[]
}

export type TimeSegment =
  | { order: number; kind: 'linear'; items: TimeItem[] }
  | { order: number; kind: 'parallel-any'; items: TimeItem[] }
  | { order: number; kind: 'fork'; lanes: TimeForkLane[] }

export interface TimeTrack {
  items?: TimeItem[]
  segments?: TimeSegment[]
}

/** Sum the time of only the TUTORIAL items in a list. */
function sumTutorialTime(items: TimeItem[]): number {
  return items.reduce((sum, i) => (i.type === 'TUTORIAL' ? sum + (i.timeToComplete || 0) : sum), 0)
}

/** Mean of a list of numbers; 0 for an empty list (no divide-by-zero). */
function mean(values: number[]): number {
  if (values.length === 0) return 0
  return values.reduce((a, b) => a + b, 0) / values.length
}

/** Time contributed by one segment, per the #3007 branching rules. */
function segmentTime(seg: TimeSegment): number {
  if (seg.kind === 'fork') {
    // Each lane is one optional path; its cost is the sum of its tutorials.
    return mean(seg.lanes.map(lane => sumTutorialTime(lane.items)))
  }
  if (seg.kind === 'parallel-any') {
    // Each tutorial is one optional path; the learner completes exactly one.
    const times = seg.items.filter(i => i.type === 'TUTORIAL').map(i => i.timeToComplete || 0)
    return mean(times)
  }
  // linear: mandatory — every tutorial counts.
  return sumTutorialTime(seg.items)
}

/**
 * Total "average time to complete" for a track, in the same unit as
 * `item.timeToComplete` (minutes). Prefers the segment structure (#2887) when
 * present so branching paths are averaged; falls back to summing the legacy flat
 * `items[]` for older payloads that predate segments.
 */
export function trackTotalTime(track: TimeTrack): number {
  if (Array.isArray(track.segments) && track.segments.length > 0) {
    return track.segments.reduce((sum, seg) => sum + segmentTime(seg), 0)
  }
  return sumTutorialTime(track.items ?? [])
}
