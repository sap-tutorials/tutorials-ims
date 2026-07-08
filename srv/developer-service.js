import cds from '@sap/cds';
import { calculateTutorialProgress } from './lib/status-calculator.js';
import { getNextLegacyId } from './lib/legacy-id.js';
import { hashIp } from './lib/feedback-salt.js';
import { getMyCompletedTutorials } from './lib/user-progress.js';
import { PROFILE_VOCAB } from './lib/branch/profile-fields.js';
import { resolveUserSapId } from './lib/resolve-db-user.js';
import { resolveUser as khorosResolveUser } from './lib/khoros-client.js';
import * as khorosCache from './lib/khoros-cache.js';
import { checkRateLimit } from './lib/per-user-rate-limit.js';
import * as metrics from './lib/metrics.js';

// Per-user rate limit for resetTutorialProgress — same window as the
// IP-based feedback limiter below (5/hr) but keyed by sapId via a shared
// sliding-window helper (matches the in-memory Map shape used by
// /api/codecheck and /api/validate-answer; lifted into a shared module
// for reuse). Bucket key prefixed `reset:` so the quota is independent.
const RESET_LIMIT_PER_HOUR = 5;
const RESET_WINDOW_MS = 60 * 60 * 1000;

const RATE_LIMIT = new Map();
const RATE_WINDOW_MS = 60 * 60 * 1000;
const RATE_MAX = 5;
const RATE_SWEEP_INTERVAL_MS = 5 * 60 * 1000;

setInterval(() => {
  const cutoff = Date.now() - RATE_WINDOW_MS;
  for (const [k, v] of RATE_LIMIT) if (v.windowStart < cutoff) RATE_LIMIT.delete(k);
}, RATE_SWEEP_INTERVAL_MS).unref();

function rateLimitExceeded(hashedIp) {
  const now = Date.now();
  const cur = RATE_LIMIT.get(hashedIp);
  if (!cur || now - cur.windowStart > RATE_WINDOW_MS) {
    RATE_LIMIT.set(hashedIp, { count: 1, windowStart: now });
    return false;
  }
  cur.count += 1;
  return cur.count > RATE_MAX;
}

function isInt0to10(v) { return v == null || (Number.isInteger(v) && v >= 0 && v <= 10); }

// #893: feedback.comment is stored and later rendered in the admin Feedback
// Fiori app. Any HTML tag in the stored value is a stored-XSS pivot if a
// renderer ever treats the column as HTML (Fiori Elements can be coaxed
// into it via custom column formatters). Feedback is plain text by product
// intent, so we strip HTML *entirely* server-side — no allowlist, no
// reliance on the admin UI's default escaping.
//
// The stripping is pragmatic, not a full HTML parser:
//   1. Remove tag pairs plus contents for the always-dangerous elements
//      (<script>, <style>, <iframe>, <object>, <embed>, <svg>, <math>) —
//      defends even if the browser tries to render before our regex sees it.
//   2. Strip every remaining tag (<...>) so no HTML at all reaches storage.
//   3. Encode residual angle brackets that never formed a tag (e.g. "a < b")
//      so an attacker can't round-trip a partial tag past the strip pass.
//   4. Cap at 2000 chars.
const DANGEROUS_TAGS_RE = /<(script|style|iframe|object|embed|svg|math)\b[^>]*>[\s\S]*?<\/\1\s*>/gi;
const ANY_TAG_RE = /<\/?[a-zA-Z][^>]*>/g;

function sanitizeComment(s) {
  if (!s) return null;
  let out = String(s);
  out = out.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
  out = out.replace(DANGEROUS_TAGS_RE, '');
  out = out.replace(ANY_TAG_RE, '');
  out = out.replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return out.slice(0, 2000);
}

export default class DeveloperService extends cds.ApplicationService {

  async init() {
    const db = await cds.connect.to('db');
    const { Tutorials: dbTutorials, Steps: dbSteps, TaskRecords: dbTaskRecords,
            Users: dbUsers, Events: dbEvents, Missions: dbMissions,
            CompletionPaths: dbPaths, CompletionPathItems: dbPathItems,
            Checkpoints: dbCheckpoints, UserLearningPreferences } = cds.entities('com.sap.developers.ims');

    // Auto-assign legacyId on TaskRecord creation
    this.before('CREATE', 'TaskRecords', async (req) => {
      if (!req.data.legacyId) {
        req.data.legacyId = await getNextLegacyId('TaskRecords', db);
      }
    });

    // --- Frontend slug-based endpoints ---

    this.on('getProgress', async (req) => {
      const slug = String(req.data.slug || '').toLowerCase();
      const user = req.user;

      // slug-canonical: pre-canonicalized
      const tutorial = await SELECT.one.from(dbTutorials).where({ slug });
      if (!tutorial) return req.reject(404, `Tutorial not found: ${slug}`);

      const steps = await SELECT.from(dbSteps).where({ tutorial_ID: tutorial.ID });

      // Find user's task records for this tutorial's steps. Issue #343:
      // lookup by sapId (the JWT user_uuid claim), not uuid (= email).
      const sapId = resolveUserSapId(user);
      const dbUser = sapId ? await SELECT.one.from(dbUsers).where({ sapId }) : null;
      if (!dbUser) return { completedSteps: [], points: 0, badges: [] };

      // Scope step records to the user's current (non-SUPERSEDED) attempt so a
      // fresh attempt starts empty even though prior-attempt SUPERSEDED step
      // rows still exist in the DB. See issue #600 Task 6.
      const currentAttempt = await this._getCurrentTutorialAttempt(dbUser, tutorial);
      const stepRecords = await SELECT.from(dbTaskRecords).where({
        user_ID: dbUser.ID,
        taskType: 'STEP',
        status: 'COMPLETED',
        attemptNumber: currentAttempt,
      });

      // Filter to only steps belonging to this tutorial
      const stepLegacyIds = steps.map(s => s.legacyId);
      const completedSteps = stepRecords
        .filter(r => stepLegacyIds.includes(r.taskLegacyId))
        .map(r => {
          const step = steps.find(s => s.legacyId === r.taskLegacyId);
          return step?.stepOrder;
        })
        .filter(Boolean)
        .sort((a, b) => a - b);

      // Points = 10 per completed step (simplified scoring)
      const points = completedSteps.length * 10;

      return { completedSteps, points, badges: [] };
    });

    this.on('completeStep', async (req) => {
      const slug = String(req.data.slug || '').toLowerCase();
      const { stepNumber } = req.data;
      const user = req.user;

      // slug-canonical: pre-canonicalized
      const tutorial = await SELECT.one.from(dbTutorials).where({ slug });
      if (!tutorial) return req.reject(404, `Tutorial not found: ${slug}`);

      let step = await SELECT.one.from(dbSteps).where({
        tutorial_ID: tutorial.ID, stepOrder: stepNumber
      });

      if (!step) {
        const stepId = cds.utils.uuid();
        const legacyId = await getNextLegacyId('Steps', db);
        await INSERT.into(dbSteps).entries({
          ID: stepId,
          tutorial_ID: tutorial.ID,
          stepOrder: stepNumber,
          title: `Step ${stepNumber}`,
          status: 'ACTIVE',
          legacyId
        });
        step = await SELECT.one.from(dbSteps, stepId);
      }

      if (!step.legacyId) {
        const legacyId = await getNextLegacyId('Steps', db);
        await UPDATE(dbSteps, step.ID).set({ legacyId });
        step.legacyId = legacyId;
      }

      // Get or create user. Issue #343: lookup + auto-provision keyed on
      // sapId (the JWT user_uuid claim) so migrated IMS users (Users.sapId
      // populated by migrator) are found by their existing row.
      const sapId = resolveUserSapId(user);
      if (!sapId) return req.reject(401, 'Unauthenticated');
      let dbUser = await SELECT.one.from(dbUsers).where({ sapId });
      if (!dbUser) {
        const newUser = {
          uuid: user.id,
          sapId,
          legacyId: await getNextLegacyId('Users', db),
          email: user.attr?.email || '',
          firstName: user.attr?.given_name || '',
          lastName: user.attr?.family_name || ''
        };
        await INSERT.into(dbUsers).entries(newUser);
        dbUser = await SELECT.one.from(dbUsers).where({ sapId });
      }

      // Check if step already completed (ignore SUPERSEDED rows from prior attempts)
      const existing = await SELECT.one.from(dbTaskRecords).where({
        user_ID: dbUser.ID,
        taskLegacyId: step.legacyId,
        taskType: 'STEP',
        status: { '!=': 'SUPERSEDED' },
      });

      if (!existing) {
        // Look up the user's current tutorial-level attempt number; default 1
        // when no live TUTORIAL row exists yet (first-time user, first step ever).
        // SELECT.one returns null (not {attemptNumber: 1}) when no row matches —
        // must default with `?? 1` to handle that case.
        const tutorialRow = await SELECT.one
          .from(dbTaskRecords)
          .columns('attemptNumber')
          .where({
            user_ID: dbUser.ID,
            taskLegacyId: tutorial.legacyId,
            taskType: 'TUTORIAL',
            status: { '!=': 'SUPERSEDED' },
          });
        const attemptNumber = tutorialRow?.attemptNumber ?? 1;

        const now = new Date().toISOString();
        await INSERT.into(dbTaskRecords).entries({
          user_ID: dbUser.ID,
          taskLegacyId: step.legacyId,
          taskType: 'STEP',
          status: 'COMPLETED',
          progress: 100,
          completionDate: now,
          titleSnapshot: step.title,
          legacyId: await getNextLegacyId('TaskRecords', db),
          attemptNumber,
        });

        // Recalculate tutorial progress
        await this._updateTutorialProgress(dbUser, tutorial, db);
      }

      // Return updated progress
      return this._getProgressForTutorial(dbUser, tutorial, db);
    });

    this.on('resetTutorialProgress', async (req) => {
      const { slug } = req.data;
      const user = req.user || cds.context?.user;
      if (!user) return req.reject(401, 'Unauthenticated');

      const sapId = resolveUserSapId(user);
      if (!sapId) return req.reject(401, 'Unauthenticated');

      // Rate-limit BEFORE any DB work — protects against griefing and
      // accidental client loops (e.g. an over-eager retry from the UI).
      // 5 resets per hour is generous for legitimate re-completion flows.
      if (!checkRateLimit(`reset:${sapId}`, RESET_LIMIT_PER_HOUR, RESET_WINDOW_MS)) {
        return req.reject(429, 'You have reset too many tutorials recently — please wait a few minutes.');
      }

      // 1. Resolve slug → tutorial
      const tutorial = await SELECT.one.from(dbTutorials).where({ slug });
      if (!tutorial) return req.reject(404, `Tutorial not found: ${slug}`);

      // 2. Resolve user (sapId → dbUser)
      const dbUser = await SELECT.one.from(dbUsers).where({ sapId });
      if (!dbUser) {
        return { newAttemptNumber: 1, previousAttemptCompletedAt: null, supersededRecordCount: 0 };
      }

      // 3. Find live (non-SUPERSEDED) rows for this tutorial's steps + tutorial-level
      const steps = await SELECT.from(dbSteps).where({ tutorial_ID: tutorial.ID });
      const taskLegacyIds = [...steps.map(s => s.legacyId), tutorial.legacyId];

      const liveRows = await SELECT.from(dbTaskRecords).where({
        user_ID: dbUser.ID,
        taskLegacyId: { in: taskLegacyIds },
        status: { '!=': 'SUPERSEDED' },
      });

      if (liveRows.length === 0) {
        return { newAttemptNumber: 1, previousAttemptCompletedAt: null, supersededRecordCount: 0 };
      }

      // 4. Determine next attempt number
      const maxAttempt = Math.max(...liveRows.map(r => r.attemptNumber ?? 1));

      // Capture the prior tutorial-level completion date BEFORE we update.
      const priorTutorialRow = liveRows.find(
        r => r.taskType === 'TUTORIAL' && r.status === 'COMPLETED'
      );
      const previousAttemptCompletedAt = priorTutorialRow?.completionDate ?? null;

      // 5. Pre-allocate legacyId for the new row (fail-fast on sequence issues)
      const newLegacyId = await getNextLegacyId('TaskRecords', db);

      // 6. Supersede current rows in one UPDATE
      await UPDATE(dbTaskRecords)
        .set({ status: 'SUPERSEDED' })
        .where({ ID: { in: liveRows.map(r => r.ID) } });

      // 7. Insert fresh TUTORIAL-level row at attempt+1
      await INSERT.into(dbTaskRecords).entries({
        user_ID: dbUser.ID,
        taskLegacyId: tutorial.legacyId,
        taskType: 'TUTORIAL',
        status: 'IN_PROGRESS',
        progress: 0,
        attemptNumber: maxAttempt + 1,
        titleSnapshot: tutorial.title,
        legacyId: newLegacyId,
      });

      // 8. Emit audit event for traceability
      await cds.emit('TutorialProgressReset', {
        user: dbUser.ID,
        tutorialSlug: slug,
        attemptNumber: maxAttempt + 1,
        supersededRecordCount: liveRows.length,
        previousAttemptCompletedAt,
      });

      return {
        newAttemptNumber: maxAttempt + 1,
        previousAttemptCompletedAt,
        supersededRecordCount: liveRows.length,
      };
    });

    // --- Legacy IMS-compatible endpoints ---

    this.on('createTaskRecord', async (req) => {
      const { taskLegacyId, taskType, eventLegacyId } = req.data;
      const user = req.user;

      const sapId = resolveUserSapId(user);
      let dbUser = sapId ? await SELECT.one.from(dbUsers).where({ sapId }) : null;
      if (!dbUser) return req.reject(404, 'User not found');

      let event_ID = null;
      if (eventLegacyId) {
        const event = await SELECT.one.from(dbEvents).where({ legacyId: eventLegacyId });
        if (event) event_ID = event.ID;
      }

      const existing = await SELECT.one.from(dbTaskRecords).where({
        user_ID: dbUser.ID,
        taskLegacyId,
        taskType
      });

      if (existing) {
        if (existing.status !== 'COMPLETED') {
          await UPDATE(dbTaskRecords, existing.ID).set({
            status: 'COMPLETED',
            progress: 100,
            completionDate: new Date().toISOString()
          });
        }
        return SELECT.one.from(dbTaskRecords, existing.ID);
      }

      const record = {
        user_ID: dbUser.ID,
        taskLegacyId,
        taskType,
        status: 'COMPLETED',
        progress: 100,
        completionDate: new Date().toISOString(),
        event_ID,
        legacyId: await getNextLegacyId('TaskRecords', db)
      };

      await INSERT.into(dbTaskRecords).entries(record);
      return SELECT.one.from(dbTaskRecords).where({ legacyId: record.legacyId });
    });

    this.on('findTaskProgressByUserAndTasksIds', async (req) => {
      const { userLegacyId, taskLegacyIds } = req.data;

      const dbUser = await SELECT.one.from(dbUsers).where({ legacyId: userLegacyId });
      if (!dbUser) return [];

      return SELECT.from(dbTaskRecords).where({
        user_ID: dbUser.ID,
        taskLegacyId: { in: taskLegacyIds }
      });
    });

    this.on('countCompletedMissionsTotal', async (req) => {
      const { userLegacyId } = req.data;

      const dbUser = await SELECT.one.from(dbUsers).where({ legacyId: userLegacyId });
      if (!dbUser) return 0;

      const records = await SELECT.from(dbTaskRecords).where({
        user_ID: dbUser.ID,
        taskType: 'MISSION',
        status: 'COMPLETED'
      });

      return records.length;
    });

    this.on('countCompletedMissionsPercent', async (req) => {
      const { userLegacyId } = req.data;

      const dbUser = await SELECT.one.from(dbUsers).where({ legacyId: userLegacyId });
      if (!dbUser) return 0;

      const completedMissions = await SELECT.from(dbTaskRecords).where({
        user_ID: dbUser.ID,
        taskType: 'MISSION',
        status: 'COMPLETED'
      });

      // Count total missions available
      const { Missions: dbMissions } = cds.entities('com.sap.developers.ims');
      const totalMissions = await SELECT.from(dbMissions).columns('ID');
      if (totalMissions.length === 0) return 0;

      return Math.round((completedMissions.length / totalMissions.length) * 100) / 100;
    });

    // --- App Space progress (replaces AEM progress/series) ---

    this.on('getMyCompletions', async (req) => {
      return getMyCompletedTutorials(req.user);
    });

    this.on('getEventProgress', async (req) => {
      const { missionLegacyId } = req.data;
      const user = req.user;

      const mission = await SELECT.one.from(dbMissions).where({ legacyId: missionLegacyId });
      if (!mission) return req.reject(404, `Mission not found: ${missionLegacyId}`);

      const paths = await SELECT.from(dbPaths)
        .where({ mission_ID: mission.ID })
        .orderBy('legacyId');

      const pathIds = paths.map(p => p.ID);
      const allItems = pathIds.length > 0
        ? await SELECT.from(dbPathItems).where({ path_ID: { in: pathIds } }).orderBy('itemOrder')
        : [];

      const taskLegacyIds = allItems.map(i => i.taskLegacyId);

      const tutorials = taskLegacyIds.length > 0
        ? await SELECT.from(dbTutorials).where({ legacyId: { in: taskLegacyIds } })
        : [];
      const checkpoints = taskLegacyIds.length > 0
        ? await SELECT.from(dbCheckpoints).where({ legacyId: { in: taskLegacyIds } })
        : [];

      const taskMap = new Map();
      for (const t of tutorials) taskMap.set(`TUTORIAL:${t.legacyId}`, t);
      for (const c of checkpoints) taskMap.set(`CHECKPOINT:${c.legacyId}`, c);

      const missingSlugIds = allItems
        .filter(i => i.taskType === 'TUTORIAL' && taskMap.has(`TUTORIAL:${i.taskLegacyId}`))
        .filter(i => !taskMap.get(`TUTORIAL:${i.taskLegacyId}`).slug)
        .map(i => i.taskLegacyId);

      if (missingSlugIds.length > 0) {
        const freshTutorials = await SELECT.from(dbTutorials)
          .where({ legacyId: { in: missingSlugIds }, slug: { '!=': null } });
        for (const t of freshTutorials) {
          taskMap.set(`TUTORIAL:${t.legacyId}`, t);
        }
      }

      let userRecords = [];
      const sapId = resolveUserSapId(user);
      const dbUser = sapId ? await SELECT.one.from(dbUsers).where({ sapId }) : null;
      if (dbUser) {
        userRecords = await SELECT.from(dbTaskRecords).where({
          user_ID: dbUser.ID,
          taskLegacyId: { in: taskLegacyIds }
        });
      }
      const recordMap = new Map();
      for (const r of userRecords) recordMap.set(`${r.taskType}:${r.taskLegacyId}`, r);

      const event = await SELECT.one.from(dbEvents)
        .where({ mission_ID: mission.ID })
        .orderBy('startDate desc');

      const result = {
        eventId: event?.legacyId ?? 0,
        eventType: event?.eventType ?? 'OTHER',
        type: 'COMPLEX',
        paths: paths.map(p => {
          const items = allItems
            .filter(i => i.path_ID === p.ID)
            .map(i => {
              const task = taskMap.get(`${i.taskType}:${i.taskLegacyId}`);
              const record = recordMap.get(`${i.taskType}:${i.taskLegacyId}`);
              return {
                imsId: i.taskLegacyId,
                title: task?.title || record?.titleSnapshot || '',
                type: i.taskType,
                status: record?.status || '',
                progress: record?.progress || 0,
                experience: task?.experienceTag || '',
                timeToComplete: task?.averageTimeToComplete || 0,
                url: task?.slug ? `/tutorials/${task.slug}.html` : '',
                description: task?.description || '',
                recordId: record?.legacyId || 0
              };
            });
          return {
            id: p.legacyId,
            title: p.name,
            description: mission.description || '',
            items
          };
        })
      };

      return result;
    });

    // --- App Space progress by event ID (defaults to latest event) ---

    this.on('getAppSpaceProgress', async (req) => {
      const { eventLegacyId } = req.data;
      const user = req.user;

      let event;
      if (eventLegacyId) {
        event = await SELECT.one.from(dbEvents).where({ legacyId: eventLegacyId });
        if (!event) return req.reject(404, `Event not found: ${eventLegacyId}`);
      } else {
        event = await SELECT.one.from(dbEvents).orderBy('startDate desc');
        if (!event) return req.reject(404, 'No events found');
      }

      if (!event.mission_ID) {
        return req.reject(400, `Event ${event.legacyId} has no mission configured`);
      }

      const mission = await SELECT.one.from(dbMissions).where({ ID: event.mission_ID });
      if (!mission) return req.reject(404, `Mission not found for event ${event.legacyId}`);

      const paths = await SELECT.from(dbPaths)
        .where({ mission_ID: mission.ID })
        .orderBy('legacyId');

      const pathIds = paths.map(p => p.ID);
      const allItems = pathIds.length > 0
        ? await SELECT.from(dbPathItems).where({ path_ID: { in: pathIds } }).orderBy('itemOrder')
        : [];

      const taskLegacyIds = allItems.map(i => i.taskLegacyId);

      const tutorials = taskLegacyIds.length > 0
        ? await SELECT.from(dbTutorials).where({ legacyId: { in: taskLegacyIds } })
        : [];
      const checkpoints = taskLegacyIds.length > 0
        ? await SELECT.from(dbCheckpoints).where({ legacyId: { in: taskLegacyIds } })
        : [];

      const taskMap = new Map();
      for (const t of tutorials) taskMap.set(`TUTORIAL:${t.legacyId}`, t);
      for (const c of checkpoints) taskMap.set(`CHECKPOINT:${c.legacyId}`, c);

      let userRecords = [];
      const sapId = resolveUserSapId(user);
      const dbUser = sapId ? await SELECT.one.from(dbUsers).where({ sapId }) : null;
      if (dbUser) {
        userRecords = await SELECT.from(dbTaskRecords).where({
          user_ID: dbUser.ID,
          taskLegacyId: { in: taskLegacyIds }
        });
      }
      const recordMap = new Map();
      for (const r of userRecords) recordMap.set(`${r.taskType}:${r.taskLegacyId}`, r);

      return {
        eventId: event.legacyId,
        eventName: event.name || '',
        eventType: event.eventType ?? 'OTHER',
        type: 'COMPLEX',
        paths: paths.map(p => {
          const items = allItems
            .filter(i => i.path_ID === p.ID)
            .map(i => {
              const task = taskMap.get(`${i.taskType}:${i.taskLegacyId}`);
              const record = recordMap.get(`${i.taskType}:${i.taskLegacyId}`);
              return {
                imsId: i.taskLegacyId,
                title: task?.title || record?.titleSnapshot || '',
                type: i.taskType,
                status: record?.status || '',
                progress: record?.progress || 0,
                experience: task?.experienceTag || '',
                timeToComplete: task?.averageTimeToComplete || 0,
                url: task?.slug ? `/tutorials/${task.slug}.html` : '',
                description: task?.description || '',
                recordId: record?.legacyId || 0
              };
            });
          return {
            id: p.legacyId,
            title: p.name,
            description: mission.description || '',
            items
          };
        })
      };
    });

    // --- Accomplishment Evaluation ---
    this.after('createTaskRecord', async (result, req) => {
      if (!result || result.status !== 'COMPLETED') return;

      const { Accomplishments, AccomplishmentRecords } = cds.entities('com.sap.developers.ims');
      const { evaluateRules } = await import('./lib/accomplishment-evaluator.js');

      const allAccomplishments = await SELECT.from(Accomplishments);
      if (allAccomplishments.length === 0) return;

      const existingRecords = await SELECT.from(AccomplishmentRecords)
        .where({ user_ID: result.user_ID });
      const alreadyAwarded = new Set(existingRecords.map(r => r.accomplishment_ID));

      const unevaluated = allAccomplishments.filter(a => !alreadyAwarded.has(a.ID));
      if (unevaluated.length === 0) return;

      const awarded = await evaluateRules(unevaluated, result.user_ID, db);

      for (const accId of awarded) {
        await INSERT.into(AccomplishmentRecords).entries({
          user_ID: result.user_ID,
          accomplishment_ID: accId,
          awardedAt: new Date().toISOString(),
          legacyId: await getNextLegacyId('AccomplishmentRecords', db)
        });
      }
    });

    // --- Real-time WebSocket broadcast ---
    this.after('createTaskRecord', async (result, req) => {
      if (!result || result.status !== 'COMPLETED') return;
      if (result.taskType !== 'TUTORIAL' || !result.event_ID) return;

      try {
        const event = await SELECT.one.from(dbEvents).where({ ID: result.event_ID });
        if (!event) return;

        const tutorial = await SELECT.one.from(dbTutorials).where({ legacyId: result.taskLegacyId });
        const user = await SELECT.one.from(dbUsers).where({ ID: result.user_ID });

        const payload = {
          bucketName: tutorial?.primaryTag || 'unknown',
          completeDate: new Date().toISOString().slice(0, 10),
          tutorialTitle: tutorial?.title || 'Unknown Tutorial',
        };

        // Broadcast to kiosks (unauthenticated, no user info).
        // Broadcast to authenticated clients (with user name).
        //
        // CAP 10: `service_level_restrictions` is enforced; `@requires` on the
        // consumed service now applies to local calls too. DisplayService is
        // `@requires: 'DisplayApp'` — a completing developer does NOT have
        // that scope, so we run the emits under `cds.User.privileged`. These
        // are trusted internal notifications (WS fan-out to display kiosks),
        // not user-authorized actions.
        const privileged = cds.User.privileged;
        const eventStream = await cds.connect.to('EventStreamService');
        await eventStream.tx({ user: privileged }, tx =>
          tx.emit('tutorialCompleted', payload, { contexts: [String(event.legacyId)] })
        );
        const display = await cds.connect.to('DisplayService');
        await display.tx({ user: privileged }, tx =>
          tx.emit('tutorialCompleted',
            { ...payload, userName: user?.displayName || 'Someone' },
            { contexts: [String(event.legacyId)] }
          )
        );
      } catch (e) {
        cds.log('ws').warn('Failed to emit tutorialCompleted:', e.message);
      }
    });

    this.on('getSlugMapping', async () => {
      const { buildSlugMapping } = await import('./lib/slug-mapping.js');
      return buildSlugMapping();
    });

    this.on('submitTutorialFeedback', async (req) => {
      const d = req.data;
      // #897: log a structured line per submission attempt so ops can
      // pattern-detect abuse (repeated 429s from one hashedIp = attempted
      // flood; unknown-slug bursts = enumeration probe; honeypot hits =
      // bot traffic). Purposefully keeps only the IP hash (not raw IP)
      // and slug — safe to leave in CF logs.
      const FLOG = cds.log('feedback');

      // 1. Honeypot — silent success
      if (d.honeypot && d.honeypot.trim() !== '') {
        FLOG.warn(`submit rejected: honeypot slug=${(d.tutorialSlug || '').toString().slice(0, 80)}`);
        return { submissionId: cds.utils.uuid() };
      }

      // 2. Validate ratings
      for (const k of ['ratingUseCase','ratingRelevance','ratingDuration','ratingStructure','ratingInteresting','ratingVisuals','npsScore']) {
        if (!isInt0to10(d[k])) return req.error(400, `${k} must be an integer 0-10 or null`);
      }
      if (!d.tutorialSlug || typeof d.tutorialSlug !== 'string') return req.error(400, 'tutorialSlug required');
      const tutorialSlug = d.tutorialSlug.toLowerCase();

      // 3. Rate limit (before any DB I/O so unknown-slug floods don't hammer the DB)
      if (!d._clientIp) FLOG.warn('submitTutorialFeedback: _clientIp missing — rate limiting will share one bucket. Express bridge must inject it.');
      const ip = d._clientIp || 'unknown';
      const hashedIp = await hashIp(ip);
      if (rateLimitExceeded(hashedIp)) {
        FLOG.warn(`submit rejected: rate-limit ipHash=${hashedIp.slice(0, 12)} slug=${tutorialSlug}`);
        return req.error(429, 'Too many submissions');
      }

      // 4. Slug existence
      const { ContentFiles, TutorialFeedback } = cds.entities('com.sap.developers.ims');
      // slug-canonical: pre-canonicalized
      const exists = await SELECT.one.from(ContentFiles).columns('slug').where({ slug: tutorialSlug });
      if (!exists) {
        FLOG.warn(`submit rejected: unknown-slug ipHash=${hashedIp.slice(0, 12)} slug=${tutorialSlug}`);
        return req.error(400, 'Unknown tutorial');
      }

      // 5. Persist
      const id = cds.utils.uuid();
      await INSERT.into(TutorialFeedback).entries({
        ID: id,
        tutorialSlug:      tutorialSlug,
        wasAuthenticated:  !!d.wasAuthenticated,
        submitterIpHash:   hashedIp,
        ratingUseCase:     d.ratingUseCase     ?? null,
        ratingRelevance:   d.ratingRelevance   ?? null,
        ratingDuration:    d.ratingDuration    ?? null,
        ratingStructure:   d.ratingStructure   ?? null,
        ratingInteresting: d.ratingInteresting ?? null,
        ratingVisuals:     d.ratingVisuals     ?? null,
        npsScore:          d.npsScore          ?? null,
        comment:           sanitizeComment(d.comment)
      });

      return { submissionId: id };
    });

    // PR 6 — Self-service row filter: scope every authenticated READ on
    // LearningPreferences to the caller's own row only. The XSUAA gate
    // (`@requires: 'authenticated-user'` on the projection) already guarantees
    // an authenticated user — no defensive 401 needed here.
    // CB2 fix: use the CQN builder (req.query.where(...)) — it AND-conjoins
    // safely with any pre-existing where clause. Hand-built CQN-token splices
    // get AND-precedence wrong on existing where clauses and are a security
    // boundary; do NOT revert.
    this.before('READ', 'LearningPreferences', async (req) => {
      const sapId = resolveUserSapId(req.user);
      const dbUser = sapId ? await SELECT.one.from(dbUsers).columns('ID').where({ sapId }) : null;
      if (!dbUser?.ID) {
        // No DB user record yet — short-circuit with empty result set
        // (cleaner CQN-builder convention than splicing a `1 = 0` predicate).
        req.results = [];
        return;
      }
      req.query.where({ user_ID: dbUser.ID });
    });

    // PR 6 — Self-service write surface. PUT-style: all three fields are
    // written every time; values omitted by the caller default to null and
    // explicitly clear the slot. SELECT-then-INSERT-or-UPDATE matches the
    // codebase-wide idiom (zero direct UPSERT statements anywhere under srv/).
    // Spec: §4.2, §7.2
    this.on('setLearningPreferences', async (req) => {
      const { deployment = null, role = null, cloud = null } = req.data;

      // Validate each field: null OR a value from the vocab. JS validation
      // layer is the actual runtime gate — CAP's @assert.range fires only at
      // the OData protocol layer, not on programmatic CQL writes from action
      // handlers, so the explicit loop here IS the security boundary.
      for (const [field, value] of Object.entries({ deployment, role, cloud })) {
        if (value === null) continue;
        if (!PROFILE_VOCAB[field].includes(value)) {
          return req.error(400, `${field}: must be one of [${PROFILE_VOCAB[field].join(', ')}]`);
        }
      }

      // Auto-provision the Users row for first-time savers (mirrors completeStep
      // pattern at developer-service.js:122-135). A learner who lands on /me/
      // before completing any tutorial otherwise hits a hard 404 here.
      // Issue #343: lookup + auto-provision keyed on sapId (the JWT user_uuid
      // claim) so migrated IMS users are matched to their existing row.
      const sapId = resolveUserSapId(req.user);
      if (!sapId) return req.reject(401, 'Unauthenticated');
      let dbUser = await SELECT.one.from(dbUsers).where({ sapId });
      if (!dbUser) {
        const newUser = {
          uuid: req.user.id,
          sapId,
          legacyId: await getNextLegacyId('Users', db),
          email: req.user.attr?.email || '',
          firstName: req.user.attr?.given_name || '',
          lastName: req.user.attr?.family_name || '',
        };
        await INSERT.into(dbUsers).entries(newUser);
        dbUser = await SELECT.one.from(dbUsers).where({ sapId });
      }

      // PUT-style write — SELECT-then-INSERT-or-UPDATE (codebase-wide idiom).
      const existing = await SELECT.one.from(UserLearningPreferences)
        .where({ user_ID: dbUser.ID });
      if (existing) {
        await UPDATE(UserLearningPreferences)
          .where({ user_ID: dbUser.ID })
          .set({ deployment, role, cloud });
      } else {
        await INSERT.into(UserLearningPreferences).entries({
          user_ID: dbUser.ID, deployment, role, cloud,
        });
      }
      return SELECT.one.from(UserLearningPreferences).where({ user_ID: dbUser.ID });
    });

    // #1030 — Homepage Row 3 events band region preference.
    this.on('setPreferredEventRegion', async (req) => {
      const value = req.data?.region === null || req.data?.region === '' ? null : String(req.data?.region ?? '').toUpperCase();

      // Validate: null OR a value from the vocab. JS validation is the runtime
      // gate (memory: @assert.range fires only at the OData protocol layer, not
      // on programmatic CQL writes from action handlers).
      if (value !== null && !PROFILE_VOCAB.preferredEventRegion.includes(value)) {
        return req.error(400, `region: must be one of [${PROFILE_VOCAB.preferredEventRegion.join(', ')}] or null`);
      }

      // Auto-provision Users row (mirrors setLearningPreferences).
      const sapId = resolveUserSapId(req.user);
      if (!sapId) return req.reject(401, 'Unauthenticated');
      let dbUser = await SELECT.one.from(dbUsers).where({ sapId });
      if (!dbUser) {
        const newUser = {
          uuid: req.user.id,
          sapId,
          legacyId: await getNextLegacyId('Users', db),
          email: req.user.attr?.email || '',
          firstName: req.user.attr?.given_name || '',
          lastName: req.user.attr?.family_name || '',
        };
        await INSERT.into(dbUsers).entries(newUser);
        dbUser = await SELECT.one.from(dbUsers).where({ sapId });
      }

      // SELECT-then-INSERT-or-UPDATE (codebase-wide idiom, zero direct UPSERTs).
      const existing = await SELECT.one.from(UserLearningPreferences)
        .where({ user_ID: dbUser.ID });
      if (existing) {
        await UPDATE(UserLearningPreferences)
          .where({ user_ID: dbUser.ID })
          .set({ preferredEventRegion: value });
      } else {
        await INSERT.into(UserLearningPreferences).entries({
          user_ID: dbUser.ID,
          preferredEventRegion: value,
        });
      }
      metrics.counter(`homepage.events.pref_set[region=${value ?? 'null'}]`);
      return true;
    });

    // ── Khoros community link handlers (issue #566) ──────────────────────────

    const PROFILE_URL = (id) => `https://community.sap.com/t5/user/viewprofilepage/user-id/${id}`;

    this.on('setKhorosLink', async (req) => {
      const sapId = resolveUserSapId(req.user);
      if (!sapId) return req.reject(401, 'Unauthenticated');
      const input = String(req.data?.input ?? '').trim();
      if (!input || input.length > 64) return { status: 'invalid-input' };
      let profile;
      try {
        profile = await khorosResolveUser(input);
      } catch (err) {
        cds.log('khoros').warn('setKhorosLink upstream error', { sapId, input, err: err.message });
        return { status: 'upstream-unavailable' };
      }
      if (!profile) return { status: 'not-found' };
      try {
        const dbUser = await SELECT.one.from(dbUsers).where({ sapId });
        if (!dbUser) return req.reject(404, 'User row missing');
        await UPDATE(dbUsers)
          .set({
            khorosId: profile.id,
            khorosLogin: profile.login,
            khorosAvatarUrl: profile.avatarUrl,
            khorosLinkedAt: new Date()
          })
          .where({ ID: dbUser.ID });
      } catch (err) {
        // @assert.unique.khorosId violation surfaces as a CAP error with
        // 'UNIQUE_CONSTRAINT_VIOLATION' code OR a message containing "unique"
        // — match defensively because the exact code differs between
        // SQLite (unit) and HANA (hybrid).
        if (/unique/i.test(err.message) || err.code === 'UNIQUE_CONSTRAINT_VIOLATION') {
          return { status: 'already-claimed' };
        }
        cds.log('khoros').error('setKhorosLink persist failed', { sapId, err: err.message });
        return { status: 'persist-failed' };
      }
      // Seed cache with exactly the shape getKhorosProfile reads back.
      khorosCache.set(profile.id, {
        name: profile.name, rank: profile.rank, avatarUrl: profile.avatarUrl
      });
      cds.log('khoros').info('khoros linked', { sapId, khorosId: profile.id, khorosLogin: profile.login });
      return { status: 'ok', khorosId: profile.id, khorosLogin: profile.login, name: profile.name };
    });

    this.on('clearKhorosLink', async (req) => {
      const sapId = resolveUserSapId(req.user);
      if (!sapId) return req.reject(401, 'Unauthenticated');
      const dbUser = await SELECT.one.from(dbUsers).where({ sapId });
      if (!dbUser) return { status: 'ok' };  // already unlinked
      const prevKhorosId = dbUser.khorosId;
      await UPDATE(dbUsers)
        .set({ khorosId: null, khorosLogin: null, khorosAvatarUrl: null, khorosLinkedAt: null })
        .where({ ID: dbUser.ID });
      if (prevKhorosId) khorosCache.evict(prevKhorosId);
      cds.log('khoros').info('khoros unlinked', { sapId, khorosId: prevKhorosId });
      return { status: 'ok' };
    });

    this.on('getKhorosProfile', async (req) => {
      const sapId = resolveUserSapId(req.user);
      if (!sapId) return req.reject(401, 'Unauthenticated');
      const dbUser = await SELECT.one
        .from(dbUsers)
        .columns('ID', 'khorosId', 'khorosLogin', 'khorosAvatarUrl')
        .where({ sapId });
      if (!dbUser?.khorosId) return { linked: false };
      const persisted = {
        linked: true,
        khorosId: dbUser.khorosId,
        khorosLogin: dbUser.khorosLogin,
        avatarUrl: dbUser.khorosAvatarUrl || '',
        profileUrl: PROFILE_URL(dbUser.khorosId),
      };
      const cached = khorosCache.get(dbUser.khorosId);
      if (cached) {
        return { ...persisted, name: cached.name, rank: cached.rank, avatarUrl: cached.avatarUrl || persisted.avatarUrl };
      }
      // Cache miss → refresh.
      let upstream = null;
      try {
        upstream = await khorosResolveUser(dbUser.khorosId);
      } catch (err) {
        cds.log('khoros').warn('getKhorosProfile upstream error', { sapId, khorosId: dbUser.khorosId, err: err.message });
      }
      if (!upstream) {
        // Last-known-good: render the chip with persisted data, blank rank.
        cds.log('khoros').warn('getKhorosProfile upstream null', { sapId, khorosId: dbUser.khorosId });
        return { ...persisted, name: dbUser.khorosLogin || '', rank: '' };
      }
      // Refresh cache + write back avatar if it drifted.
      khorosCache.set(upstream.id, { name: upstream.name, rank: upstream.rank, avatarUrl: upstream.avatarUrl });
      if (upstream.avatarUrl && upstream.avatarUrl !== dbUser.khorosAvatarUrl) {
        await UPDATE(dbUsers).set({ khorosAvatarUrl: upstream.avatarUrl }).where({ ID: dbUser.ID });
      }
      return { ...persisted, name: upstream.name, rank: upstream.rank, avatarUrl: upstream.avatarUrl || persisted.avatarUrl };
    });

    await super.init();
  }

  /**
   * Look up the user's current (non-SUPERSEDED) attempt number for a tutorial.
   * Returns 1 when no live TUTORIAL row exists yet — matches the schema default
   * and lets first-time users / new resets count their fresh attempt as 1.
   *
   * Used by Task 6 (#600) — getProgress, _getProgressForTutorial — to scope
   * step counts to the current attempt and ignore SUPERSEDED rows from prior
   * attempts.
   */
  async _getCurrentTutorialAttempt(dbUser, tutorial) {
    const { TaskRecords: dbTaskRecords } = cds.entities('com.sap.developers.ims');
    const row = await SELECT.one
      .from(dbTaskRecords)
      .columns('attemptNumber')
      .where({
        user_ID: dbUser.ID,
        taskLegacyId: tutorial.legacyId,
        taskType: 'TUTORIAL',
        status: { '!=': 'SUPERSEDED' },
      });
    return row?.attemptNumber ?? 1;
  }

  async _updateTutorialProgress(dbUser, tutorial, db) {
    const { Steps: dbSteps, TaskRecords: dbTaskRecords } =
      cds.entities('com.sap.developers.ims');

    const steps = await SELECT.from(dbSteps).where({ tutorial_ID: tutorial.ID });
    const stepLegacyIds = steps.map(s => s.legacyId);

    // Look up the user's CURRENT (non-SUPERSEDED) TUTORIAL task record first
    // so we can scope step counts + new row inserts to its attemptNumber.
    // Without the SUPERSEDED filter we'd risk reviving a historical row and
    // miscounting step completions across attempts. See issue #600 Task 5.
    const existing = await SELECT.one.from(dbTaskRecords).where({
      user_ID: dbUser.ID,
      taskLegacyId: tutorial.legacyId,
      taskType: 'TUTORIAL',
      status: { '!=': 'SUPERSEDED' },
    });
    const currentAttempt = existing?.attemptNumber ?? 1;

    const completedStepRecords = await SELECT.from(dbTaskRecords).where({
      user_ID: dbUser.ID,
      taskType: 'STEP',
      status: 'COMPLETED',
      taskLegacyId: { in: stepLegacyIds },
      attemptNumber: currentAttempt,
    });

    // Prefer the authoritative stepCount from the parsed tutorial frontmatter
    // (set by publish-content). The DB Step row count is unreliable as a
    // denominator because completeStep lazily inserts Step rows, so the count
    // grows with each user click and a partially-completed tutorial can flip
    // to 100% before publish-content has populated the rest of the steps.
    // Fallback to DB count only when stepCount is null (e.g. tests, or
    // tutorials published before this column existed). See issue #89.
    const totalSteps = (typeof tutorial.stepCount === 'number' && tutorial.stepCount > 0)
      ? tutorial.stepCount
      : steps.length;

    const { progress, status } = calculateTutorialProgress(
      completedStepRecords, totalSteps
    );

    if (existing) {
      await UPDATE(dbTaskRecords, existing.ID).set({
        progress, status,
        completionDate: status === 'COMPLETED' ? new Date().toISOString() : existing.completionDate
      });
    } else {
      await INSERT.into(dbTaskRecords).entries({
        user_ID: dbUser.ID,
        taskLegacyId: tutorial.legacyId,
        taskType: 'TUTORIAL',
        status, progress,
        titleSnapshot: tutorial.title,
        legacyId: await getNextLegacyId('TaskRecords', db),
        attemptNumber: currentAttempt,
      });
    }
  }

  async _getProgressForTutorial(dbUser, tutorial, db) {
    const { Steps: dbSteps, TaskRecords: dbTaskRecords } =
      cds.entities('com.sap.developers.ims');

    const steps = await SELECT.from(dbSteps).where({ tutorial_ID: tutorial.ID });
    const stepLegacyIds = steps.map(s => s.legacyId);

    // Scope to the user's current (non-SUPERSEDED) attempt; ignores prior-
    // attempt SUPERSEDED step rows. See issue #600 Task 6.
    const currentAttempt = await this._getCurrentTutorialAttempt(dbUser, tutorial);
    const completedStepRecords = await SELECT.from(dbTaskRecords).where({
      user_ID: dbUser.ID,
      taskType: 'STEP',
      status: 'COMPLETED',
      taskLegacyId: { in: stepLegacyIds },
      attemptNumber: currentAttempt,
    });

    const completedSteps = completedStepRecords
      .map(r => {
        const step = steps.find(s => s.legacyId === r.taskLegacyId);
        return step?.stepOrder;
      })
      .filter(Boolean)
      .sort((a, b) => a - b);

    const points = completedSteps.length * 10;
    return { completedSteps, points };
  }
}
