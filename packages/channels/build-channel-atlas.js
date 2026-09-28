// Mirrors the parseArr pattern from srv/server.js:432 for HANA NCLOB array columns
// (focusAreas is `array of String(60)`, stored as a JSON string on HANA;
//  SQLite in-memory tests return real JS arrays already).
const parseArr = (v) =>
  Array.isArray(v) ? v : (typeof v === 'string' && v ? JSON.parse(v) : [])

/**
 * Transform raw Channels DB rows + ChannelTopicMap groupings into the
 * public /build/channel-atlas AtlasChannelDTO array.
 *
 * Pure function — no DB access; all DB work is in the srv/server.js handler.
 *
 * @param {object[]} rows              SELECT results from Channels (isPublished=true)
 * @param {Map<string, string[]>} topicsByChannel  channel_ID → topicTag[] (REVIEWED rows only)
 * @returns {object[]}                 AtlasChannelDTO[]
 */
function buildAtlasChannels(rows, topicsByChannel) {
  return rows.map((r) => ({
    id: r.ID,
    name: r.name,
    url: r.url,
    purpose: r.purpose ?? null,
    ownerType: r.ownerType ?? null,
    subscribers: r.subscribers ?? null,
    githubStars: r.githubStars ?? null,
    focusAreas: parseArr(r.focusAreas),
    topicTags: topicsByChannel.get(r.ID) ?? [],
  }))
}

export { buildAtlasChannels }
