import cds from '@sap/cds';
import { calculateTutorialProgress } from './lib/status-calculator.js';
import { getNextLegacyId } from './lib/legacy-id.js';

export default class DeveloperService extends cds.ApplicationService {

  async init() {
    const db = await cds.connect.to('db');
    const { Tutorials: dbTutorials, Steps: dbSteps, TaskRecords: dbTaskRecords,
            Users: dbUsers, Events: dbEvents, Missions: dbMissions,
            CompletionPaths: dbPaths, CompletionPathItems: dbPathItems,
            Checkpoints: dbCheckpoints } = cds.entities('com.sap.developers.ims');

    // Auto-assign legacyId on TaskRecord creation
    this.before('CREATE', 'TaskRecords', async (req) => {
      if (!req.data.legacyId) {
        req.data.legacyId = await getNextLegacyId('TaskRecords', db);
      }
    });

    // --- Frontend slug-based endpoints ---

    this.on('getProgress', async (req) => {
      const { slug } = req.data;
      const user = req.user;

      const tutorial = await SELECT.one.from(dbTutorials).where({ slug });
      if (!tutorial) return req.reject(404, `Tutorial not found: ${slug}`);

      const steps = await SELECT.from(dbSteps).where({ tutorial_ID: tutorial.ID });

      // Find user's task records for this tutorial's steps
      const dbUser = await SELECT.one.from(dbUsers).where({ uuid: user.id });
      if (!dbUser) return { completedSteps: [], points: 0, badges: [] };

      const stepRecords = await SELECT.from(dbTaskRecords).where({
        user_ID: dbUser.ID,
        taskType: 'STEP',
        status: 'COMPLETED'
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
      const { slug, stepNumber } = req.data;
      const user = req.user;

      const tutorial = await SELECT.one.from(dbTutorials).where({ slug });
      if (!tutorial) return req.reject(404, `Tutorial not found: ${slug}`);

      const step = await SELECT.one.from(dbSteps).where({
        tutorial_ID: tutorial.ID, stepOrder: stepNumber
      });
      if (!step) return req.reject(404, `Step ${stepNumber} not found for ${slug}`);

      // Get or create user
      let dbUser = await SELECT.one.from(dbUsers).where({ uuid: user.id });
      if (!dbUser) {
        const newUser = {
          uuid: user.id,
          legacyId: await getNextLegacyId('Users', db),
          email: user.attr?.email || '',
          firstName: user.attr?.given_name || '',
          lastName: user.attr?.family_name || ''
        };
        await INSERT.into(dbUsers).entries(newUser);
        dbUser = await SELECT.one.from(dbUsers).where({ uuid: user.id });
      }

      // Check if step already completed
      const existing = await SELECT.one.from(dbTaskRecords).where({
        user_ID: dbUser.ID,
        taskLegacyId: step.legacyId,
        taskType: 'STEP'
      });

      if (!existing) {
        const now = new Date().toISOString();
        await INSERT.into(dbTaskRecords).entries({
          user_ID: dbUser.ID,
          taskLegacyId: step.legacyId,
          taskType: 'STEP',
          status: 'COMPLETED',
          progress: 100,
          completionDate: now,
          titleSnapshot: step.title,
          legacyId: await getNextLegacyId('TaskRecords', db)
        });

        // Recalculate tutorial progress
        await this._updateTutorialProgress(dbUser, tutorial, db);
      }

      // Return updated progress
      return this._getProgressForTutorial(dbUser, tutorial, db);
    });

    // --- Legacy IMS-compatible endpoints ---

    this.on('createTaskRecord', async (req) => {
      const { taskLegacyId, taskType, eventLegacyId } = req.data;
      const user = req.user;

      let dbUser = await SELECT.one.from(dbUsers).where({ uuid: user.id });
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
      const dbUser = await SELECT.one.from(dbUsers).where({ uuid: user.id });
      if (dbUser) {
        userRecords = await SELECT.from(dbTaskRecords).where({
          user_ID: dbUser.ID,
          taskLegacyId: { in: taskLegacyIds }
        });
      }
      const recordMap = new Map();
      for (const r of userRecords) recordMap.set(`${r.taskType}:${r.taskLegacyId}`, r);

      const event = await SELECT.one.from(dbEvents).orderBy('startDate desc');

      const result = {
        eventId: event?.legacyId ?? 0,
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

        // Broadcast to kiosks (unauthenticated, no user info)
        const eventStream = await cds.connect.to('EventStreamService');
        await eventStream.emit('tutorialCompleted', payload, { contexts: [String(event.legacyId)] });

        // Broadcast to authenticated clients (with user name)
        const display = await cds.connect.to('DisplayService');
        await display.emit('tutorialCompleted',
          { ...payload, userName: user?.displayName || 'Someone' },
          { contexts: [String(event.legacyId)] }
        );
      } catch (e) {
        cds.log('ws').warn('Failed to emit tutorialCompleted:', e.message);
      }
    });

    this.on('getSlugMapping', async () => {
      const { buildSlugMapping } = await import('./lib/slug-mapping.js');
      return buildSlugMapping();
    });

    await super.init();
  }

  async _updateTutorialProgress(dbUser, tutorial, db) {
    const { Steps: dbSteps, TaskRecords: dbTaskRecords } =
      cds.entities('com.sap.developers.ims');

    const steps = await SELECT.from(dbSteps).where({ tutorial_ID: tutorial.ID });
    const stepLegacyIds = steps.map(s => s.legacyId);

    const completedStepRecords = await SELECT.from(dbTaskRecords).where({
      user_ID: dbUser.ID,
      taskType: 'STEP',
      status: 'COMPLETED',
      taskLegacyId: { in: stepLegacyIds }
    });

    const { progress, status } = calculateTutorialProgress(
      completedStepRecords, steps.length
    );

    // Upsert tutorial-level task record
    const existing = await SELECT.one.from(dbTaskRecords).where({
      user_ID: dbUser.ID,
      taskLegacyId: tutorial.legacyId,
      taskType: 'TUTORIAL'
    });

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
        legacyId: await getNextLegacyId('TaskRecords', db)
      });
    }
  }

  async _getProgressForTutorial(dbUser, tutorial, db) {
    const { Steps: dbSteps, TaskRecords: dbTaskRecords } =
      cds.entities('com.sap.developers.ims');

    const steps = await SELECT.from(dbSteps).where({ tutorial_ID: tutorial.ID });
    const stepLegacyIds = steps.map(s => s.legacyId);

    const completedStepRecords = await SELECT.from(dbTaskRecords).where({
      user_ID: dbUser.ID,
      taskType: 'STEP',
      status: 'COMPLETED',
      taskLegacyId: { in: stepLegacyIds }
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
