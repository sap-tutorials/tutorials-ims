'use strict';
const cds = require('@sap/cds');

// Deterministic category → shelf and focus → verb defaults (admin-overridable later).
const CATEGORY_TO_SHELF = {
  'Portal': 'REFERENCE', 'Documentation': 'REFERENCE', 'Docs': 'REFERENCE',
  'GitHub Repository': 'TOOLS', 'Package Registry': 'TOOLS', 'Tool': 'TOOLS',
  'YouTube': 'KEEP_CURRENT', 'Podcast': 'KEEP_CURRENT', 'Blog': 'KEEP_CURRENT', 'News': 'KEEP_CURRENT',
  'Learning': 'START_HERE', 'Community': 'REFERENCE',
};
const FOCUS_TO_VERB = [
  [['integration'], 'INTEGRATE'], [['ops', 'admin', 'operations'], 'OPERATE'],
  [['ai', 'genai'], 'AI'], [['rap', 'data-model', 'cds'], 'MODEL'],
  [['abap', 'cap', 'sdk', 'build'], 'BUILD'], [['onboarding', 'tutorial', 'learn'], 'LEARN'],
];

function pickVerb(focusAreas = []) {
  const lower = focusAreas.map((f) => String(f).toLowerCase());
  for (const [keys, verb] of FOCUS_TO_VERB) if (keys.some((k) => lower.includes(k))) return verb;
  return 'BUILD';
}

function mapChannelToShelf(channel) {
  let shelf = CATEGORY_TO_SHELF[channel.category] || 'REFERENCE';
  // community / third-party may never land in START_HERE
  if (shelf === 'START_HERE' && channel.isSapOwned !== true) shelf = 'REFERENCE';
  return { verb: pickVerb(channel.focusAreas), shelf };
}

async function promoteFeatured(db) {
  const linked = cds.linked(cds.model ?? (await cds.load('*')));
  const { Channels, HomepageShelves } = linked.entities('com.sap.developers.ims');
  const featured = await db.run(SELECT.from(Channels).where({ isFeatured: true, isPublished: true }));
  let upserted = 0, skipped = 0;
  for (const ch of featured) {
    const { verb, shelf } = mapChannelToShelf(ch);
    const existing = await db.run(SELECT.one.from(HomepageShelves).where({ verb, url: ch.url }));
    if (existing) { skipped++; continue; }
    await db.run(INSERT.into(HomepageShelves).entries({
      ID: cds.utils.uuid(), verb, shelf, url: ch.url, title: ch.name,
      description: ch.editorialNote || ch.purpose, whyItMatters: ch.editorialNote || null,
      isExternal: true, isActive: true, badge: ch.isSapOwned ? null : 'THIRD_PARTY',
      authoringStatus: 'AI_SEEDED', sortOrder: 500,
    }));
    upserted++;
  }
  return { upserted, skipped };
}

module.exports = { mapChannelToShelf, promoteFeatured, CATEGORY_TO_SHELF, FOCUS_TO_VERB };
