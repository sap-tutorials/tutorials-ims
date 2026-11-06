import cds from '@sap/cds';
import { computePathBuckets, buildTrackMap, resolveEventMissionId } from '../srv/lib/event-path-buckets.js';

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

function median(values) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : Math.floor((sorted[mid - 1] + sorted[mid]) / 2);
}

/**
 * The distinct tutorials under the event's tracks (via buildTrackMap), hydrated
 * with title + totalSteps (stepCount, falling back to a count of Steps rows).
 * @param {object} event resolved Events row
 * @param {object} db
 * @returns {Promise<Array<{legacyId:number,title:string,totalSteps:number}>>}
 */
export async function resolveEventTutorials(event, db) {
  const missionId = await resolveEventMissionId(event, db);
  if (!missionId) return [];
  const { pathNameByToken } = await buildTrackMap(missionId, db);
  const legacyIds = [...pathNameByToken.keys()]
    .filter((k) => k.startsWith('TUTORIAL:'))
    .map((k) => Number(k.slice('TUTORIAL:'.length)));
  if (legacyIds.length === 0) return [];

  const { Tutorials, Steps } = cds.entities(NS);
  const tuts = await db.run(
    SELECT.from(Tutorials).columns('ID', 'legacyId', 'title', 'stepCount').where({ legacyId: { in: legacyIds } }),
  );
  const out = [];
  for (const t of tuts) {
    let totalSteps = t.stepCount;
    if (totalSteps == null) {
      const steps = await db.run(SELECT.from(Steps).columns('ID').where({ tutorial_ID: t.ID }));
      totalSteps = steps.length;
    }
    out.push({ ID: t.ID, legacyId: t.legacyId, title: t.title, totalSteps });
  }
  return out;
}

/**
 * Per-tutorial abandonment: IN_PROGRESS TUTORIAL records whose modifiedAt is in
 * the event window; per (user,tutorial) stop-step = count of COMPLETED STEP
 * records at that user's current attemptNumber.
 * @param {object} event resolved Events row (needs startDate/endDate)
 * @param {Array<{legacyId:number,title:string,totalSteps:number}>} tutorials
 * @param {object} db
 * @returns {Promise<Array<{tutorialLegacyId:number,title:string,totalSteps:number,abandonedCount:number,medianStopStep:number,perStep:Array<{step:number,count:number,pct:number}>}>>}
 */
export async function computeAbandonment(event, tutorials, db) {
  const { TaskRecords, Steps } = cds.entities(NS);
  const rows = [];
  for (const t of tutorials) {
    const inProgress = await db.run(
      SELECT.from(TaskRecords)
        .columns('user_ID', 'attemptNumber')
        .where({ taskType: 'TUTORIAL', status: 'IN_PROGRESS', taskLegacyId: t.legacyId })
        .and(`modifiedAt >=`, event.startDate)
        .and(`modifiedAt <=`, event.endDate),
    );
    if (inProgress.length === 0) continue;

    const stepRows = await db.run(
      SELECT.from(Steps)
        .columns('legacyId', 'stepOrder', 'title')
        .where({ tutorial_ID: t.ID })
        .orderBy('stepOrder'),
    );
    const stepLegacyIds = stepRows.map((s) => s.legacyId).filter((x) => x != null);

    const stopSteps = [];
    for (const rec of inProgress) {
      let done = 0;
      if (stepLegacyIds.length > 0) {
        const completed = await db.run(
          SELECT.from(TaskRecords).columns('ID').where({
            user_ID: rec.user_ID, taskType: 'STEP', status: 'COMPLETED',
            taskLegacyId: { in: stepLegacyIds }, attemptNumber: rec.attemptNumber ?? 1,
          }),
        );
        done = completed.length;
      }
      stopSteps.push(done);
    }

    const countByStep = new Map();
    for (const s of stopSteps) countByStep.set(s, (countByStep.get(s) ?? 0) + 1);
    const total = stopSteps.length;
    const perStep = [...countByStep.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([step, count]) => ({ step, count, pct: Math.round((count / total) * 100) }));

    rows.push({
      tutorialLegacyId: t.legacyId,
      title: t.title,
      totalSteps: t.totalSteps,
      abandonedCount: total,
      medianStopStep: median(stopSteps),
      perStep,
      stepTitles: Object.fromEntries(stepRows.map((s) => [s.stepOrder, s.title])),
    });
  }
  return rows.sort((a, b) => b.abandonedCount - a.abandonedCount);
}

/**
 * Markdown for section 2 — abandonment + step-drop histogram.
 * @param {Array} rows output of computeAbandonment
 * @returns {string}
 */
export function renderAbandonmentSection(rows) {
  const totalAbandoned = rows.reduce((s, r) => s + r.abandonedCount, 0);
  const lines = ['## Abandoned tutorials', '', `Total abandoned: ${nf.format(totalAbandoned)}`, ''];
  if (rows.length === 0) {
    lines.push('_No in-progress tutorials in the event window._');
    return lines.join('\n');
  }
  for (const r of rows) {
    lines.push(
      `### ${r.title} — ${r.abandonedCount} abandoned, ${r.totalSteps} steps`,
      `Median stop: step ${r.medianStopStep} of ${r.totalSteps}`,
      '',
    );
    for (const p of r.perStep) {
      const title = r.stepTitles?.[p.step] ? ` "${r.stepTitles[p.step]}"` : '';
      lines.push(`- Step ${p.step}${title}: ${p.count} (${p.pct}%)`);
    }
    lines.push('');
  }
  return lines.join('\n').trimEnd();
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

  const tutorials = await resolveEventTutorials(event, db);
  const abandonment = await computeAbandonment(event, tutorials, db);
  parts.push(renderAbandonmentSection(abandonment));

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
