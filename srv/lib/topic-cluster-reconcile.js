// Pure reconciliation logic for the /topics/ stable-slug pipeline.
// No I/O — the nightly job resolves member sets and passes them in.

export function slugify(label) {
  return String(label || '')
    .toLowerCase()
    .replace(/&/g, ' ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

export function jaccard(a, b) {
  const setA = new Set(a);
  const setB = new Set(b);
  if (setA.size === 0 && setB.size === 0) return 0;
  let inter = 0;
  for (const x of setA) if (setB.has(x)) inter += 1;
  const union = setA.size + setB.size - inter;
  return union === 0 ? 0 : inter / union;
}

export function reconcile({ existing = [], communities = [], threshold = 0.5 }) {
  const usedExisting = new Set();
  const assignedSlugs = new Set();

  // Seed the mint-dedup set with ALL existing slugs (ACTIVE + RETIRED) so that
  // minted slugs never collide with a retired slug being written in the same
  // INSERT batch (I1 fix). C1 makes this collision common: drift retires
  // 'hana-cloud' and re-mints 'hana-cloud' from the same label in one run.
  for (const ex of existing) {
    if (ex.slug) assignedSlugs.add(ex.slug);
  }

  const upserts = [];

  const mintSlug = (label) => {
    const base = slugify(label) || 'topic';
    let candidate = base;
    let n = 2;
    while (assignedSlugs.has(candidate)) candidate = `${base}-${n++}`;
    assignedSlugs.add(candidate);
    return candidate;
  };

  for (const c of communities) {
    let best = null;
    let bestScore = 0;
    for (const ex of existing) {
      if (usedExisting.has(ex.slug)) continue;
      const score = jaccard(c.memberSlugs || [], ex.memberSlugs || []);
      if (score > bestScore) { bestScore = score; best = ex; }
    }
    if (best && bestScore >= threshold) {
      usedExisting.add(best.slug);
      assignedSlugs.add(best.slug);
      const history = [best.previousFingerprints, best.fingerprint].filter(Boolean).join('\n').slice(0, 2000);
      upserts.push({
        slug: best.slug,
        label: c.label,
        fingerprint: c.fingerprint,
        previousFingerprints: history,
        status: 'ACTIVE',
        memberCount: c.memberCount,
        tutorialCount: c.tutorialCount,
      });
    } else {
      upserts.push({
        slug: mintSlug(c.label),
        label: c.label,
        fingerprint: c.fingerprint,
        previousFingerprints: '',
        status: 'ACTIVE',
        memberCount: c.memberCount,
        tutorialCount: c.tutorialCount,
      });
    }
  }

  const retired = existing
    .filter((ex) => ex.status === 'ACTIVE' && !usedExisting.has(ex.slug))
    .map((ex) => ex.slug);

  // Safety dedup: if a minted upsert slug somehow collides with a retired slug
  // (belt-and-suspenders after the assignedSlugs seed above), drop the retired
  // entry — ACTIVE wins. This keeps the INSERT batch free of duplicate PKs.
  const upsertSlugs = new Set(upserts.map((u) => u.slug));
  const deduped = retired.filter((s) => !upsertSlugs.has(s));

  return { upserts, retired: deduped };
}
