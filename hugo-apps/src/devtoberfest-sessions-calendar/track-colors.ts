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

// Maps planner TrackColor enum names to fixed swatches.
export const NAMED_PALETTE: Record<string, TrackColor> = {
  Blue:   { bg: '#eaf4ff', border: '#0a6ed1', text: '#08386b' },
  Green:  { bg: '#eafaf0', border: '#107e3e', text: '#0a5c2e' },
  Red:    { bg: '#fdeef2', border: '#d20a2e', text: '#8b0a20' },
  Orange: { bg: '#fef3e7', border: '#e76500', text: '#8a3d00' },
  Yellow: { bg: '#fdf6e3', border: '#b8860b', text: '#6b4e00' },
  Purple: { bg: '#f3edfb', border: '#7858a8', text: '#432c66' },
};

export function buildTrackColorMap(tracks: { name: string; color?: string }[]): Map<string, TrackColor> {
  // Deduplicate: first color wins per name
  const colorByName = new Map<string, string | undefined>();
  for (const t of tracks) {
    if (t.name && !colorByName.has(t.name)) colorByName.set(t.name, t.color);
  }
  // Hash-index only the uncolored tracks (no named-palette entry), alphabetically
  const uncolored = [...colorByName.entries()]
    .filter(([, c]) => !NAMED_PALETTE[c || ''])
    .map(([name]) => name)
    .sort((a, b) => a.localeCompare(b, 'en'));
  const hashIndex = new Map<string, number>();
  uncolored.forEach((name, i) => hashIndex.set(name, i));
  // Insert into map in alphabetical order so [..map.keys()] and legendFor are stable
  const map = new Map<string, TrackColor>();
  const allNames = [...colorByName.keys()].sort((a, b) => a.localeCompare(b, 'en'));
  for (const name of allNames) {
    const c = colorByName.get(name);
    const named = NAMED_PALETTE[c || ''];
    map.set(name, named || PALETTE[(hashIndex.get(name) || 0) % PALETTE.length]);
  }
  return map;
}

export function legendFor(map: Map<string, TrackColor>): { trackName: string; color: TrackColor }[] {
  return [...map.entries()].map(([trackName, color]) => ({ trackName, color }));
}
