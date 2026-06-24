/**
 * Joule tool handler — getDevtoberfestInfo.
 *
 * Reads DevtoberfestConfig (singleton) + currentEvent (Association),
 * computes event.status and date deltas, returns the section payload
 * shape from docs/superpowers/specs/2026-06-23-565-joule-devtoberfest-design.md §4.3.
 *
 * Forward-compat contract: as schema fields land for points/gameboard/
 * activities/videos, the corresponding section flips from
 * { available: false, comingSoon: true } to a populated object. The
 * tool's LLM-facing schema (in chat-orchestrator.js) does NOT change.
 *
 * Refs #565
 */
import cds from '@sap/cds';

const LOG = cds.log('devtoberfest-joule-tool');

const VALID_SECTIONS = new Set([
  'all', 'event', 'terms', 'links', 'points', 'gameboard', 'activities', 'videos'
]);
const PLACEHOLDER_KEYS = ['points', 'gameboard', 'activities', 'videos'];

// Module-level — intentionally never cleared. The number of distinct
// dangling currentEvent_IDs in a process lifetime is bounded and tiny.
const warnedMissingEventIds = new Set();

function daysCeil(targetMs, nowMs) {
  return Math.ceil((targetMs - nowMs) / 86_400_000);
}

function computeEvent(config) {
  // No DevtoberfestConfig row OR no currentEvent association OR no startDate.
  if (!config || !config.currentEvent || !config.currentEvent.startDate) {
    if (config?.currentEvent_ID && !config?.currentEvent) {
      // Association points at a deleted Event row — log once per dangling id.
      if (!warnedMissingEventIds.has(config.currentEvent_ID)) {
        warnedMissingEventIds.add(config.currentEvent_ID);
        LOG.warn('DevtoberfestConfig.currentEvent points at a missing Event row',
                 { currentEvent_ID: config.currentEvent_ID });
      }
    }
    return {
      name: null, startDate: null, endDate: null, timeZone: null,
      status: 'unconfigured', daysUntilStart: null, daysUntilEnd: null
    };
  }
  const ev = config.currentEvent;
  const nowMs = Date.now();
  const startMs = new Date(ev.startDate).getTime();
  const endMs   = ev.endDate ? new Date(ev.endDate).getTime() : null;

  let status;
  if (endMs !== null && nowMs > endMs)        status = 'ended';
  else if (nowMs >= startMs)                  status = 'active';
  else                                        status = 'upcoming';

  return {
    name: ev.name || null,
    startDate: ev.startDate,
    endDate: ev.endDate || null,
    timeZone: ev.timeZone || null,
    status,
    daysUntilStart: daysCeil(startMs, nowMs),
    daysUntilEnd: endMs !== null ? daysCeil(endMs, nowMs) : null
  };
}

function buildTerms(config) {
  const body = (config?.termsText || '').trim();
  if (!body) return { available: false };
  return { available: true, version: config.termsVersion ?? 1, body };
}

function buildLinks(config) {
  return {
    contentRulesUrl: config?.contentRulesUrl || null,
    activitiesUrl:   config?.activitiesUrl   || null,
    faqUrl:          config?.faqUrl          || null,
    gameboardUrl:    config?.gameboardUrl    || null
  };
}

function placeholder() {
  return { available: false, comingSoon: true };
}

export async function getDevtoberfestInfo(args, _user) {
  const rawSection = typeof args?.section === 'string' ? args.section : 'all';
  const section = VALID_SECTIONS.has(rawSection) ? rawSection : 'all';

  let config = null;
  try {
    const { DevtoberfestConfig } = cds.entities('com.sap.developers.ims');
    // expand currentEvent — keeps name/dates/timeZone on the row directly.
    // isActive=true filter: multi-row entity, exactly one row at a time
    // is "live" — spec 2026-06-24.
    config = await SELECT.one
      .from(DevtoberfestConfig)
      .where({ isActive: true })
      .columns(c => {
        c('ID'); c('currentEvent_ID');
        c('termsText'); c('termsVersion');
        c('contentRulesUrl'); c('faqUrl'); c('gameboardUrl'); c('activitiesUrl');
        c.currentEvent(e => { e('ID'); e('name'); e('startDate'); e('endDate'); e('timeZone'); });
      });
  } catch (err) {
    LOG.warn('DevtoberfestConfig read failed', err.message);
  }

  const out = { generatedAt: new Date().toISOString() };
  out.event = computeEvent(config);

  if (section === 'event') return out;

  if (section === 'all' || section === 'terms')  out.terms = buildTerms(config);
  if (section === 'all' || section === 'links')  out.links = buildLinks(config);

  if (section === 'all') {
    for (const k of PLACEHOLDER_KEYS) out[k] = placeholder();
  } else if (PLACEHOLDER_KEYS.includes(section)) {
    out[section] = placeholder();
  }

  return out;
}
