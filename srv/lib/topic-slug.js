export function flattenTopicSlug(value) {
  return String(value).replace(/--/g, '-').toLowerCase();
}

export function parseTitlePath(titlePath) {
  const idx = String(titlePath).indexOf('>');
  const facet = idx === -1 ? '' : titlePath.slice(0, idx);
  const value = idx === -1 ? titlePath : titlePath.slice(idx + 1);
  return { facet, value, segments: value.split('--') };
}

// Deterministic: sort by titlePath, first occupant of a slug keeps it bare;
// later collisions are facet-qualified `<facet>-<slug>`.
export function buildTopicSlugMap(liveTags) {
  const bySlug = new Map();
  const byTag = new Map();
  const sorted = [...liveTags].sort((a, b) => a.titlePath.localeCompare(b.titlePath));
  for (const raw of sorted) {
    const { facet, value, segments } = parseTitlePath(raw.titlePath);
    const base = flattenTopicSlug(value);
    let slug = base;
    if (bySlug.has(slug)) slug = `${facet}-${base}`;
    // If even the qualified slug collides, suffix an index (defensive; asserted-rare).
    let n = 2;
    while (bySlug.has(slug)) slug = `${facet}-${base}-${n++}`;
    const tag = {
      titlePath: raw.titlePath, facet, value, segments, slug,
      label: raw.label || segments[segments.length - 1],
      tutorialCount: raw.tutorialCount ?? 0,
      conceptCount: raw.conceptCount ?? 0,
    };
    bySlug.set(slug, tag);
    byTag.set(raw.titlePath, slug);
  }
  return { bySlug, byTag };
}

export function normalizeLegacyTopicSlug(slug) {
  return String(slug).replace(/-\d+$/, '');
}
