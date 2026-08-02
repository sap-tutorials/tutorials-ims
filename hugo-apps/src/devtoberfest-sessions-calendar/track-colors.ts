export type TrackColor = { bg: string; border: string; text: string };

// Horizon-derived palette (bg tint, strong border, dark text). Extend freely.
const PALETTE: TrackColor[] = [
  { bg: '#eaf4ff', border: '#0a6ed1', text: '#08386b' }, // blue
  { bg: '#eafaf0', border: '#107e3e', text: '#0a5c2e' }, // green
  { bg: '#fdeef2', border: '#d20a2e', text: '#8b0a20' }, // red
  { bg: '#fef3e7', border: '#e76500', text: '#8a3d00' }, // orange
  { bg: '#f3edfb', border: '#7858a8', text: '#432c66' }, // purple
  { bg: '#e9f7f8', border: '#0a8189', text: '#064a4f' }, // teal
  { bg: '#fdf6e3', border: '#b8860b', text: '#6b4e00' }, // gold
  { bg: '#f0f2f4', border: '#5b738b', text: '#33404d' }, // slate
];

export function buildTrackColorMap(trackNames: string[]): Map<string, TrackColor> {
  const distinct = [...new Set(trackNames.filter(Boolean))].sort((a, b) => a.localeCompare(b));
  const map = new Map<string, TrackColor>();
  distinct.forEach((name, i) => map.set(name, PALETTE[i % PALETTE.length]));
  return map;
}

export function legendFor(map: Map<string, TrackColor>): { trackName: string; color: TrackColor }[] {
  return [...map.entries()].map(([trackName, color]) => ({ trackName, color }));
}
