// Pure hourly-rate extrapolation for the live display's "Tutorials Per Hour".
//
// Driven by the timestamps of EVERY completion (completionTick), not only
// track-mapped ones. Previously the rate was fed solely from tutorialCompleted
// (per-track) events, so an event whose completions didn't resolve to a
// CompletionPath produced tutorialCompleted=0 and the per-hour number was stuck
// at 0 for the whole event even though completions were happening. completionTick
// fires once per completion regardless of track, so feeding the rate from it
// makes "Tutorials Per Hour" reflect real activity.
//
// Matches the original speedApproximation math: extrapolate the observed count
// over the observed time span to a full hour.
export function completionsPerHour(timestampsMs: number[]): number {
  if (timestampsMs.length < 2) return 0;
  const span = timestampsMs[timestampsMs.length - 1] - timestampsMs[0];
  if (span <= 0) return 0;
  const perMs = timestampsMs.length / span;
  return Math.round(perMs * 60 * 60 * 1000);
}
