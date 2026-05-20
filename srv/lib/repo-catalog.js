import cds from '@sap/cds';

// GET /build/repo-catalog — unauthenticated
// Returns { [slug]: DiscoveredTutorial } matching .tutorial-cache/_discovery.json shape
export async function repoCatalogReadHandler(req, res) {
  const { RepoCatalog } = cds.entities('com.sap.developers.ims');
  try {
    const rows = await SELECT.from(RepoCatalog).columns('slug', 'payload');
    const map = {};
    for (const row of rows) {
      if (!row.payload) continue;
      try {
        map[row.slug] = JSON.parse(row.payload);
      } catch (err) {
        cds.log('repo-catalog').warn(`payload parse failed for slug=${row.slug}`, err.message);
      }
    }
    res.json(map);
  } catch (err) {
    cds.log('repo-catalog').error('read failed', err.message);
    res.status(500).json({ error: 'Repo catalog read failed' });
  }
}

// POST /build/repo-catalog — bearer-token-protected via CONTENT_API_KEY
// Body: { entries: { [slug]: DiscoveredTutorial } }
// Replaces the table contents transactionally so it always matches the latest discovery.
export async function repoCatalogWriteHandler(req, res) {
  const { entries } = req.body || {};
  if (!entries || typeof entries !== 'object') {
    return res.status(400).json({ error: 'Missing or invalid "entries" object' });
  }

  const slugs = Object.keys(entries);
  if (slugs.length === 0) {
    return res.status(400).json({ error: 'Empty "entries" — refusing to wipe catalog' });
  }
  if (slugs.length > 5000) {
    return res.status(413).json({ error: `Too many entries: ${slugs.length} (max 5000)` });
  }

  const { RepoCatalog } = cds.entities('com.sap.developers.ims');
  const now = new Date().toISOString();

  const rows = slugs.map(slug => {
    const e = entries[slug] || {};
    const topics = Array.isArray(e.topics) ? JSON.stringify(e.topics) : null;
    return {
      slug,
      owner: typeof e.owner === 'string' ? e.owner : null,
      repo: typeof e.repo === 'string' ? e.repo : null,
      branch: typeof e.branch === 'string' ? e.branch : null,
      visibility: typeof e.visibility === 'string' ? e.visibility : null,
      defaultLang: typeof e.defaultLang === 'string' ? e.defaultLang : null,
      topics,
      lastSyncedAt: now,
      payload: JSON.stringify(e),
    };
  });

  try {
    await cds.tx(async (tx) => {
      await tx.run(DELETE.from(RepoCatalog));
      await tx.run(INSERT.into(RepoCatalog).entries(rows));
    });
    res.json({ count: rows.length });
  } catch (err) {
    cds.log('repo-catalog').error('write failed', err.message);
    res.status(500).json({ error: 'Repo catalog write failed' });
  }
}
