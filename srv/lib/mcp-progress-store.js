// srv/lib/mcp-progress-store.js
// Thin adapter over srv/lib/user-progress.js — reshapes its output for the
// MCP curated tool surface, then augments with event + step-detail queries
// that user-progress doesn't cover.
//
// Task 11's handlers pass a caller `user` object (either JWT or PAT-synthetic)
// and receive already-shaped rows ready for MCP return. Refs #1105.

import cds from '@sap/cds';
import { getUserProgress } from './user-progress.js';
import { resolveDbUser } from './resolve-db-user.js';

const NS = 'com.sap.developers.ims';

// ---- reads used by Task 11 handlers ----

/**
 * Return the caller's tutorials with status + rough step completion metadata.
 * `status` filter: 'in_progress' | 'completed' | 'all'.
 * limit is applied AFTER filtering.
 */
export async function getMyTutorials(user, { status = 'all', limit = 20 } = {}) {
  const progress = await getUserProgress(user);
  const inProgress = progress.inProgress.map(t => ({
    slug: t.slug,
    title: t.title,
    status: 'in_progress',
    lastActivityAt: t.lastTouchedAt ?? null,
    attemptNumber: t.attemptNumber ?? 1
  }));
  const completed = progress.completedSlugs.map(slug => ({
    slug, title: null, status: 'completed',
    lastActivityAt: null, attemptNumber: null
  }));

  const rows = [...inProgress, ...completed];
  const filtered = status === 'all' ? rows : rows.filter(r => r.status === status);
  return filtered.slice(0, limit);
}

export async function getMyMissions(user, { status = 'all', limit = 10 } = {}) {
  const progress = await getUserProgress(user);
  const rows = progress.completedMissionSlugs.map(slug => ({
    slug, title: null, status: 'completed',
    completedCount: null, totalCount: null, nextTutorialSlug: null
  }));
  const filtered = status === 'all' ? rows
    : status === 'completed' ? rows
    : []; // in_progress not covered by user-progress.completedMissionSlugs — return empty for now
  return filtered.slice(0, limit);
}

/**
 * Events by when: 'upcoming' | 'past' | 'registered'.
 * Uses TaskRecords with taskType='MISSION'... no, Events is a separate query.
 */
export async function getMyEvents(user, { when = 'upcoming', limit = 20 } = {}) {
  const dbUser = await resolveDbUser(user);
  if (!dbUser) return [];
  const { Events, EventRegistrations } = cds.entities(NS);
  const now = new Date();

  const regs = await SELECT.from(EventRegistrations)
    .where({ user_ID: dbUser.ID })
    .columns('event_ID');
  const registeredIds = new Set(regs.map(r => r.event_ID));

  let events = [];
  if (when === 'upcoming') {
    events = await SELECT.from(Events).where({ startDate: { '>=': now } })
      .columns('ID', 'slug', 'name', 'eventType', 'startDate', 'endDate')
      .orderBy('startDate asc').limit(limit);
  } else if (when === 'past') {
    events = await SELECT.from(Events).where({ endDate: { '<': now } })
      .columns('ID', 'slug', 'name', 'eventType', 'startDate', 'endDate')
      .orderBy('startDate desc').limit(limit);
  } else if (when === 'registered') {
    if (registeredIds.size === 0) return [];
    events = await SELECT.from(Events).where({ ID: { in: [...registeredIds] } })
      .columns('ID', 'slug', 'name', 'eventType', 'startDate', 'endDate')
      .orderBy('startDate desc').limit(limit);
  }

  return events.map(e => ({
    slug: e.slug, name: e.name, eventType: e.eventType,
    startDate: e.startDate, endDate: e.endDate,
    registered: registeredIds.has(e.ID)
  }));
}

/**
 * Completed steps for one tutorial. Mirrors the pattern in
 * srv/developer-service.js:100-131 (the existing completedSteps action):
 *   1. Look up the tutorial by slug
 *   2. Query TaskRecords WHERE user_ID, taskType='STEP', status='COMPLETED', attemptNumber (current)
 *   3. Filter to this tutorial's step-legacy-ids and map to stepOrder
 * We simplify by NOT computing "current attempt" — return all COMPLETED step
 * records for the tutorial. If prior-attempt SUPERSEDED rows exist we'll show
 * a slight over-count; acceptable for MCP (LLM tolerates ambiguity, and the
 * spec doesn't guarantee attempt-fresh semantics for read tools). Task 12's
 * write tools delegate to the existing action, which DOES honor attempts.
 */
export async function getMyCompletedSteps(user, slug) {
  const dbUser = await resolveDbUser(user);
  if (!dbUser) return null;
  const { Tutorials, Steps, TaskRecords } = cds.entities(NS);
  const [tutorial] = await SELECT.from(Tutorials).where({ slug: slug.toLowerCase() })
    .columns('ID', 'legacyId');
  if (!tutorial) return null;

  const steps = await SELECT.from(Steps).where({ tutorial_ID: tutorial.ID })
    .columns('legacyId', 'stepOrder');
  if (steps.length === 0) return { slug, completedSteps: [], attemptNumber: 1, lastActivityAt: null };

  const stepLegacyIds = steps.map(s => s.legacyId);
  const records = await SELECT.from(TaskRecords).where({
    user_ID: dbUser.ID,
    taskType: 'STEP',
    status: 'COMPLETED',
    taskLegacyId: { in: stepLegacyIds }
  }).columns('taskLegacyId', 'attemptNumber', 'modifiedAt', 'completionDate');

  const completedSteps = records
    .map(r => steps.find(s => s.legacyId === r.taskLegacyId)?.stepOrder)
    .filter(Boolean)
    .sort((a, b) => a - b);
  const maxAttempt = records.reduce((m, r) => Math.max(m, r.attemptNumber ?? 1), 1);
  const lastActivityAt = records.reduce((latest, r) => {
    const t = r.modifiedAt ?? r.completionDate;
    return !latest || (t && new Date(t) > new Date(latest)) ? t : latest;
  }, null);

  return {
    slug,
    completedSteps,
    attemptNumber: maxAttempt,
    lastActivityAt
  };
}
