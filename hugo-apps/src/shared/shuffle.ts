// hugo-apps/src/shared/shuffle.ts
//
// Fisher-Yates (Durstenfeld) shuffle. Pure: returns a NEW array and never
// mutates the input. Used to randomize the display order of quiz answer
// options at island mount time (#2558) so positional answer-sharing
// ("it's the 3rd option") stops being useful.
//
// `rng` is injectable purely for deterministic tests; production callers omit
// it and get Math.random. It must return a float in [0, 1).
export function shuffleArray<T>(arr: readonly T[], rng: () => number = Math.random): T[] {
  const out = [...arr];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}
