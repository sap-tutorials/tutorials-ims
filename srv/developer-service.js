import cds from '@sap/cds';
import { calculateTutorialProgress } from './lib/status-calculator.js';
import { getNextLegacyId } from './lib/legacy-id.js';

export default class DeveloperService extends cds.ApplicationService {

  async init() {
    const db = await cds.connect.to('db');
    const { Tutorials: dbTutorials, Steps: dbSteps, TaskRecords: dbTaskRecords,
            Users: dbUsers, Events: dbEvents } = cds.entities('com.sap.developers.ims');

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
