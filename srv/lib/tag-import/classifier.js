export function classify(rows, existingTags) {
  const byName = new Map(
    existingTags.map(t => [t.name.toLowerCase(), t])
  );

  const out = [];
  let news = 0, conflicts = 0, invalids = 0;

  for (const r of rows) {
    if (r.invalid) {
      invalids++;
      out.push({
        status: 'invalid',
        name: r.name,
        titlePath: r.titlePath,
        existingId: null,
        existingTitlePath: null,
        reason: r.reason
      });
      continue;
    }

    const match = byName.get(r.name.toLowerCase());
    if (match) {
      conflicts++;
      out.push({
        status: 'conflict',
        name: r.name,
        titlePath: r.titlePath,
        existingId: match.ID,
        existingTitlePath: match.titlePath,
        reason: null
      });
    } else {
      news++;
      out.push({
        status: 'new',
        name: r.name,
        titlePath: r.titlePath,
        existingId: null,
        existingTitlePath: null,
        reason: null
      });
    }
  }

  return {
    summary: { total: out.length, new_: news, conflict: conflicts, invalid: invalids },
    rows: out
  };
}
