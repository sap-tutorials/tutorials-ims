import cds from '@sap/cds';

const NS = 'com.sap.developers.ims';
const nf = new Intl.NumberFormat('en-US');

/**
 * Accept a bare eventId/legacyId or an app-space URL (…?eventId=NNN…).
 * @param {string} input
 * @returns {string} the eventId
 */
export function parseEventId(input) {
  const raw = String(input ?? '').trim();
  if (!raw) throw new Error('No eventId or app-space URL provided');
  // Only treat it as a URL if it parses AS one; otherwise it's a bare id.
  let url;
  try {
    url = new URL(raw);
  } catch {
    return raw; // bare id
  }
  const id = url.searchParams.get('eventId');
  if (!id) throw new Error(`No eventId in URL: ${raw}`);
  return id;
}

/**
 * Markdown for section 1 — "Tutorial completions by track".
 * @param {{buckets:Array<{bucketName:string,count:number,percentage:number}>,totalCompletions:number}} bucketsResult
 * @param {object} event resolved Events row (for the heading)
 * @returns {string}
 */
export function renderTrackSection(bucketsResult, event) {
  const { buckets, totalCompletions } = bucketsResult;
  const lines = ['## Tutorial completions by track', ''];
  if (!totalCompletions || buckets.length === 0) {
    lines.push('_No completions in the event window._');
    return lines.join('\n');
  }
  lines.push(`Total completions: ${nf.format(totalCompletions)}`, '');
  lines.push('| Track | Completions | Share |', '| --- | --- | --- |');
  for (const b of buckets) {
    lines.push(`| ${b.bucketName} | ${nf.format(b.count)} | ${b.percentage}% |`);
  }
  return lines.join('\n');
}

/**
 * SELECT.one Events by legacyId. Returns the full row or null.
 * @param {string} eventLegacyId
 * @param {object} db cds db service
 */
export async function resolveEvent(eventLegacyId, db) {
  const { Events } = cds.entities(NS);
  const event = await db.run(SELECT.one.from(Events).where({ legacyId: eventLegacyId }));
  return event ?? null;
}

/**
 * Load the CDS model and connect to the bound db.
 * @returns {Promise<{db: object}>}
 */
export async function bootstrap() {
  cds.model = await cds.load(['srv', 'db', 'app']);
  const db = await cds.connect.to('db');
  return { db };
}
