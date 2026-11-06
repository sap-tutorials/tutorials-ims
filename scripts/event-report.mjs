import cds from '@sap/cds';
import { computePathBuckets } from '../srv/lib/event-path-buckets.js';

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

function renderHeader(event) {
  const win = event.startDate && event.endDate
    ? `${event.startDate} → ${event.endDate}`
    : '(no window)';
  return [
    `# Event report: ${event.name ?? '(unnamed)'}`,
    '',
    `- Event legacyId: ${event.legacyId}`,
    `- Window: ${win}`,
    `- Mission: ${event.mission_ID ?? '(resolved via backlink)'}`,
    '',
  ].join('\n');
}

/**
 * Orchestrate the report for one event. Returns the full markdown.
 * Throws if the event is not found. Reports a missing window inline
 * (does not throw) so the operator sees why there are no numbers.
 * @param {string} eventId  Events.legacyId
 * @param {object} db  cds db service
 * @returns {Promise<string>}
 */
export async function buildReport(eventId, db) {
  const event = await resolveEvent(eventId, db);
  if (!event) throw new Error(`Event not found: ${eventId}`);

  const parts = [renderHeader(event)];

  if (!event.startDate || !event.endDate) {
    parts.push('_This event has no date window (startDate/endDate); completion windowing cannot be applied._');
    return parts.join('\n');
  }

  const bucketsResult = await computePathBuckets(event, db);
  parts.push(renderTrackSection(bucketsResult, event));

  return parts.join('\n');
}

async function main() {
  const argv = process.argv.slice(2);
  const wantJson = argv.includes('--json');
  const input = argv.find((a) => !a.startsWith('--'));
  const eventId = parseEventId(input);
  const { db } = await bootstrap();
  const md = await buildReport(eventId, db);
  console.log(md);
  if (wantJson) {
    const event = await resolveEvent(eventId, db);
    const buckets = event?.startDate && event?.endDate ? await computePathBuckets(event, db) : null;
    console.log(JSON.stringify({ event, buckets }, null, 2));
  }
}

// Run only when invoked directly, not when imported by tests.
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('event-report.mjs')) {
  main().catch((e) => {
    console.error('ERR:', e.message);
    process.exit(1);
  });
}
