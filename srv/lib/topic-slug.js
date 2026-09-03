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

// Real Tags.titlePath uses " : " to separate the FACET from the value and
// " / " to separate hierarchy LEVELS, e.g.
//   "Software Product : Enterprise Management / SAP S 4HANA"
// Product-name slashes are pre-spaced in the source ("SAP S/4HANA" → "SAP S
// 4HANA"), so the spaced " : " / " / " separators are unambiguous. The legacy
// ">" facet / "--" level separators never appear in live data — parsing on
// them collapsed every titlePath into one facetless segment, which is what
// flattened the /topics/ tree.
export function parseTitlePath(titlePath) {
  const str = String(titlePath);
  const idx = str.indexOf(' : ');
  const facet = idx === -1 ? '' : str.slice(0, idx).trim();
  const value = (idx === -1 ? str : str.slice(idx + 3)).trim();
  const segments = value.split(' / ').map(s => s.trim()).filter(Boolean);
  return { facet, value, segments: segments.length ? segments : [value] };
}

// Deterministic slug map. The slug is derived from the FULL titlePath (not the
// post-facet value) so that already-published `topic-<slug>` BLOB keys and
// their `/topics/<slug>/` URLs stay byte-stable even though facet/segments now
// parse into a hierarchy for the tree. Rare full-path slug collisions (two
// titlePaths that slugify identically) get an index suffix.
export function buildTopicSlugMap(liveTags) {
  const bySlug = new Map();
  const byTag = new Map();
  const sorted = [...liveTags].sort((a, b) => a.titlePath.localeCompare(b.titlePath));
  for (const raw of sorted) {
    const { facet, value, segments } = parseTitlePath(raw.titlePath);
    const base = flattenTopicSlug(raw.titlePath);
    let slug = base;
    let n = 2;
    while (bySlug.has(slug)) slug = `${base}-${n++}`;
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
