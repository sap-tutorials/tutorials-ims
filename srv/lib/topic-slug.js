// URL-safe topic slug: lowercase, every run of non-[a-z0-9] → single hyphen,
// trimmed. Real Tags.titlePath values carry spaces, colons and slashes
// (e.g. "software product : technology platform / ... / open connectors");
// the serve path (serveHandler VALID_SLUG=/^[a-z0-9][a-z0-9-]*$/) rejects any
// slug that is not [a-z0-9-], so every character class outside that MUST be
// folded to a hyphen here or the /topics/<slug> route 404s (#2099 defect).
export function slugifyTopic(value) {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// Back-compat name: same URL-safe folding. Previously only collapsed `--`→`-`,
// which left spaces/colons/slashes intact and produced un-servable slugs.
export function flattenTopicSlug(value) {
  return slugifyTopic(value);
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
    // Facet is slugified too — real facets carry spaces/colons, and an empty
    // facet must NOT produce a leading-hyphen slug (`-base` fails VALID_SLUG).
    const qf = slugifyTopic(facet);
    let slug = base;
    if (bySlug.has(slug)) slug = qf ? `${qf}-${base}` : base;
    // If even the qualified slug collides, suffix an index (defensive; asserted-rare).
    let n = 2;
    while (bySlug.has(slug)) slug = qf ? `${qf}-${base}-${n++}` : `${base}-${n++}`;
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
