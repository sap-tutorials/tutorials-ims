import cds from '@sap/cds';
import { computeEventStatistics, computeBurnup, computeTrackStats, computeCompletionSpeed } from './lib/event-statistics.js';
import { formatTaskRecordsCSV, formatAwardMissionsCSV } from './lib/export-helpers.js';
import { buildAnonymizationOps } from './lib/anonymization.js';
import { getNextLegacyId } from './lib/legacy-id.js';

export default class AdminService extends cds.ApplicationService {

  async init() {
    const { Users, Tutorials, Missions, Groups, Events, TaskRecords,
            StepFailures, Tags, TutorialTags, UserMetaData,
            PrimaryAccounts, SecondaryAccounts, PrivacyProtectionActions,
            FeaturedTasks, CompletionPaths, CompletionPathItems } = cds.entities('com.sap.developers.ims');
    const db = await cds.connect.to('db');
    const audit = await cds.connect.to('audit-log');

    // Auto-assign legacyId on creation for entities that need it
    const legacyKeyedEntities = [
      'Users', 'Tutorials', 'Missions', 'Groups', 'Events', 'TaskRecords',
      'StepFailures', 'Tags', 'Accomplishments', 'AccomplishmentRecords',
      'PrizeRecords', 'TutorialMeta', 'TutorialContributors', 'TutorialRepositories',
      'FeaturedTasks', 'PrimaryAccounts', 'SecondaryAccounts', 'PrivacyProtectionActions',
      'ActiveLearnerRecords', 'DashboardMonitoredRecords', 'CompletionPaths', 'CompletionPathItems'
    ];
    for (const entity of legacyKeyedEntities) {
      this.before('CREATE', entity, async (req) => {
        if (!req.data.legacyId) {
          req.data.legacyId = await getNextLegacyId(entity, db);
        }
      });
    }

    // Reset notification escalation when reviewedDate is updated via Fiori UI
    this.before('UPDATE', 'TutorialMeta', (req) => {
      if (req.data.reviewedDate) {
        req.data.notificationNumber = 0;
        req.data.lastNotificationDate = null;
      }
    });

    // --- Event Statistics ---

    this.on('getEventStatistics', async (req) => {
      const { eventLegacyId } = req.data;
      const event = await SELECT.one.from(Events).where({ legacyId: eventLegacyId });
      if (!event) return req.reject(404, `Event not found: ${eventLegacyId}`);

      const records = await SELECT.from(TaskRecords).where({ event_ID: event.ID });
      return computeEventStatistics(records);
    });

    this.on('getEventBurnup', async (req) => {
      const { eventLegacyId } = req.data;
      const event = await SELECT.one.from(Events).where({ legacyId: eventLegacyId });
      if (!event) return req.reject(404, `Event not found: ${eventLegacyId}`);

      const records = await SELECT.from(TaskRecords).where({
        event_ID: event.ID,
        taskType: 'TUTORIAL',
        status: 'COMPLETED'
      });
      return computeBurnup(records, event.timeZone || '+00:00');
    });

    this.on('getEventTrackStats', async (req) => {
      const { eventLegacyId } = req.data;
      const event = await SELECT.one.from(Events).where({ legacyId: eventLegacyId });
      if (!event) return req.reject(404, `Event not found: ${eventLegacyId}`);

      const records = await SELECT.from(TaskRecords).where({
        event_ID: event.ID,
        taskType: 'MISSION',
        status: 'COMPLETED'
      });
      const missions = await SELECT.from(Missions).columns('legacyId', 'title');
      return computeTrackStats(records, missions);
    });

    this.on('getCompletionSpeed', async (req) => {
      const { eventLegacyId } = req.data;
      const event = await SELECT.one.from(Events).where({ legacyId: eventLegacyId });
      if (!event) return req.reject(404, `Event not found: ${eventLegacyId}`);

      const records = await SELECT.from(TaskRecords).where({
        event_ID: event.ID,
        taskType: 'TUTORIAL',
        status: 'COMPLETED'
      });
      const tutorials = await SELECT.from(Tutorials).columns('legacyId', 'title');
      return computeCompletionSpeed(records, tutorials);
    });

    // --- Export ---

    this.on('exportTaskRecords', async (req) => {
      const { eventLegacyId, format } = req.data;
      const event = await SELECT.one.from(Events).where({ legacyId: eventLegacyId });
      if (!event) return req.reject(404, `Event not found: ${eventLegacyId}`);

      const records = await SELECT.from(TaskRecords).where({
        event_ID: event.ID,
        status: 'COMPLETED'
      });

      if (format === 'json') return JSON.stringify(records, null, 2);
      return formatTaskRecordsCSV(records);
    });

    this.on('exportAwardMissions', async (req) => {
      const { eventLegacyId } = req.data;
      const event = await SELECT.one.from(Events).where({ legacyId: eventLegacyId });
      if (!event) return req.reject(404, `Event not found: ${eventLegacyId}`);

      const missionRecords = await SELECT.from(TaskRecords).where({
        event_ID: event.ID,
        taskType: 'MISSION',
        status: 'COMPLETED'
      });

      const userIds = [...new Set(missionRecords.map(r => r.user_ID))];
      const users = userIds.length > 0
        ? await SELECT.from(Users).where({ ID: { in: userIds } })
        : [];
      const userMap = new Map(users.map(u => [u.ID, u]));

      const missions = await SELECT.from(Missions).columns('legacyId', 'title');
      const missionMap = new Map(missions.map(m => [m.legacyId, m.title]));

      const awards = missionRecords.map(r => ({
        userDisplayName: userMap.get(r.user_ID)?.displayName || '',
        missionTitle: missionMap.get(r.taskLegacyId) || '',
        completionDate: r.completionDate
      }));

      return formatAwardMissionsCSV(awards);
    });

    // --- GDPR / Anonymization ---

    this.on('anonymizeUser', async (req) => {
      const { sapId } = req.data;
      const user = await SELECT.one.from(Users).where({ sapId });
      if (!user) return req.reject(404, `User not found with sapId: ${sapId}`);

      await this._executeAnonymization(user);

      await audit.log('SecurityEvent', {
        data: { action: 'AnonymizeUser', sapId, dsrRequestNumber: null }
      });
    });

    this.on('anonymizeByDsrRequest', async (req) => {
      const { sapId, dsrRequestNumber } = req.data;
      const user = await SELECT.one.from(Users).where({ sapId });
      if (!user) return req.reject(404, `User not found with sapId: ${sapId}`);

      await INSERT.into(PrivacyProtectionActions).entries({
        userUuid: user.uuid,
        actionType: 'ANONYMIZE',
        requestedAt: new Date().toISOString(),
        status: 'PROCESSING',
        legacyId: await getNextLegacyId('PrivacyProtectionActions', db)
      });

      await this._executeAnonymization(user);

      await UPDATE(PrivacyProtectionActions)
        .where({ userUuid: user.uuid, actionType: 'ANONYMIZE', status: 'PROCESSING' })
        .set({ status: 'COMPLETED', completedAt: new Date().toISOString() });

      await audit.log('SecurityEvent', {
        data: { action: 'AnonymizeUser', sapId, dsrRequestNumber }
      });
    });

    // --- Cleanup & Maintenance ---

    this.on('cleanupStepFailures', async (req) => {
      const days = req.data.olderThanDays || 90;
      const cutoff = new Date(Date.now() - days * 86400000).toISOString();
      const result = await DELETE.from(StepFailures).where({ failureDate: { '<': cutoff } });
      return result;
    });

    this.on('cleanupUnusedTags', async (req) => {
      const usedTagIds = await SELECT.from(TutorialTags).columns('tag_ID');
      const usedSet = new Set(usedTagIds.map(r => r.tag_ID));
      const allTags = await SELECT.from(Tags).columns('ID');
      const unused = allTags.filter(t => !usedSet.has(t.ID));
      if (unused.length === 0) return 0;
      const unusedIds = unused.map(t => t.ID);
      await DELETE.from(Tags).where({ ID: { in: unusedIds } });
      return unused.length;
    });

    this.after('READ', 'Tags', (rows) => {
      for (const row of Array.isArray(rows) ? rows : [rows]) {
        row.mdFormat = titlePathToMdFormat(row.titlePath);
      }
    });

    this.on('setFeaturedOrder', async (req) => {
      const { taskLegacyId, taskType, featuredOrder } = req.data;
      const existing = await SELECT.one.from(FeaturedTasks).where({ taskLegacyId, taskType });
      if (existing) {
        await UPDATE(FeaturedTasks, existing.ID).set({ featuredOrder });
      } else {
        await INSERT.into(FeaturedTasks).entries({
          taskLegacyId, taskType, featuredOrder,
          legacyId: await getNextLegacyId('FeaturedTasks', db)
        });
      }
    });

    // --- Account Merge Status ---

    this.on('getAccountMergeStatus', async (req) => {
      const { uuid } = req.data;
      const primary = await SELECT.one.from(PrimaryAccounts).where({ uuid });
      if (!primary) return { primaryUuid: null, status: null, mergedAt: null, secondaryCount: 0 };

      const secondaries = await SELECT.from(SecondaryAccounts).where({ primaryAccount_ID: primary.ID });
      const latestMerge = secondaries.reduce((latest, s) =>
        s.mergedAt && (!latest || s.mergedAt > latest) ? s.mergedAt : latest, null);

      return {
        primaryUuid: primary.uuid,
        status: primary.status,
        mergedAt: latestMerge,
        secondaryCount: secondaries.length
      };
    });

    this.on('findByAccountNumber', async (req) => {
      const { sapId } = req.data;
      const user = await SELECT.one.from(Users).where({ sapId });
      if (!user) return [];

      await INSERT.into(PrivacyProtectionActions).entries({
        userUuid: user.uuid,
        actionType: 'SEARCH',
        requestedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        status: 'COMPLETED',
        legacyId: await getNextLegacyId('PrivacyProtectionActions', db)
      });

      return SELECT.from(TaskRecords).where({ user_ID: user.ID });
    });

    // --- Integrations (wired) ---

    this.on('sendToNgds', async (req) => {
      const { taskRecordLegacyId } = req.data;
      const record = await SELECT.one.from(TaskRecords).where({ legacyId: taskRecordLegacyId });
      if (!record) return req.reject(404, `TaskRecord not found: ${taskRecordLegacyId}`);

      const user = await SELECT.one.from(Users).where({ ID: record.user_ID });
      const { sendToNgds: send } = await import('./lib/ngds-client.js');
      const result = await send({
        uuid: user?.uuid,
        taskLegacyId: record.taskLegacyId,
        taskType: record.taskType,
        taskTitle: record.titleSnapshot || '',
        completionDate: record.completionDate,
        eventLegacyId: null,
        sapId: user?.sapId
      });
      return result;
    });

    this.on('syncTutorialMetadata', async (req) => {
      const { syncTutorialMetadata: sync } = await import('./lib/tutorial-sync.js');
      const fs = await import('fs');
      const path = await import('path');

      const cachePath = path.join(process.cwd(), '.tutorial-cache', 'metadata.json');
      let metadataSource = [];
      try {
        const raw = fs.readFileSync(cachePath, 'utf-8');
        metadataSource = JSON.parse(raw);
      } catch {
        return { synced: 0, message: 'No metadata cache found' };
      }
      return sync(metadataSource);
    });

    // --- Tutorial Review & Notification Reset ---

    this.on('reviewTutorial', async (req) => {
      const { TutorialMeta } = cds.entities('com.sap.developers.ims');
      const { tutorialId } = req.data;
      const meta = await SELECT.one.from(TutorialMeta).where({ tutorial_ID: tutorialId });
      if (!meta) return req.reject(404, `TutorialMeta not found for tutorial: ${tutorialId}`);

      const now = new Date().toISOString();
      await UPDATE(TutorialMeta, meta.ID).set({
        reviewedDate: now,
        notificationNumber: 0,
        lastNotificationDate: null
      });
      return { reviewedDate: now, notificationNumber: 0 };
    });

    this.on('snoozeTutorial', async (req) => {
      const { TutorialMeta } = cds.entities('com.sap.developers.ims');
      const { tutorialId, days } = req.data;
      const meta = await SELECT.one.from(TutorialMeta).where({ tutorial_ID: tutorialId });
      if (!meta) return req.reject(404, `TutorialMeta not found for tutorial: ${tutorialId}`);

      const snoozeUntil = new Date(Date.now() + (days || 30) * 86400000).toISOString();
      await UPDATE(TutorialMeta, meta.ID).set({ lastNotificationDate: snoozeUntil });
      return { lastNotificationDate: snoozeUntil, notificationNumber: meta.notificationNumber };
    });

    this.on('sendContributorNotifications', async (req) => {
      const { computeStaleNotifications, determineRecipients, markNotificationSent, getAdminEmailList } = await import('./lib/contributor-notifications.js');
      const { sendNotificationEmail } = await import('./lib/mail-client.js');

      const adminEmails = await getAdminEmailList();
      const notifications = await computeStaleNotifications(180);
      const dashboardUrl = process.env.DASHBOARD_URL || 'https://tutorials-approuter.cfapps.us30.hana.ondemand.com/ui/tutorialDashboard';

      let sent = 0;
      for (const n of notifications) {
        const { to, cc } = determineRecipients(n, adminEmails);
        if (to.length === 0) continue;
        await sendNotificationEmail({
          to, cc, subject: n.title,
          level: n.notificationLevel,
          variables: { dashboardUrl }
        });
        await markNotificationSent(n.tutorialId);
        sent++;
      }
      return { notified: sent };
    });

    this.on('updateNotificationRecipients', async (req) => {
      const { ImsConfig } = cds.entities('com.sap.developers.ims');
      const { emails } = req.data;
      const existing = await SELECT.one.from(ImsConfig).where({ key: 'emailListForOutdated' });
      if (existing) {
        await UPDATE(ImsConfig, existing.ID).set({ value: emails });
      } else {
        await INSERT.into(ImsConfig).entries({ key: 'emailListForOutdated', value: emails });
      }
      return { updated: true };
    });

    this.on('toggleNotifications', async (req) => {
      const { ImsConfig } = cds.entities('com.sap.developers.ims');
      const { enabled } = req.data;
      const value = String(enabled);
      const existing = await SELECT.one.from(ImsConfig).where({ key: 'isNotificationSendingAllowed' });
      if (existing) {
        await UPDATE(ImsConfig, existing.ID).set({ value });
      } else {
        await INSERT.into(ImsConfig).entries({ key: 'isNotificationSendingAllowed', value });
      }
      return { enabled };
    });

    this.on('getNotificationConfig', async () => {
      const { ImsConfig } = cds.entities('com.sap.developers.ims');
      const enabledConfig = await SELECT.one.from(ImsConfig).where({ key: 'isNotificationSendingAllowed' });
      const recipientsConfig = await SELECT.one.from(ImsConfig).where({ key: 'emailListForOutdated' });
      return {
        enabled: enabledConfig?.value === 'true',
        recipients: recipientsConfig?.value || ''
      };
    });

    this.on('findMissingSlugs', async () => {
      const { findMissingSlugs } = await import('./lib/slug-mapping.js');
      return findMissingSlugs();
    });

    this.after('READ', 'PipelineLog', rows => {
      for (const row of Array.isArray(rows) ? rows : [rows]) {
        if (row.status === 'SUCCESS') row.statusCriticality = 3;
        else if (row.status === 'FAILED') row.statusCriticality = 1;
        else if (row.status === 'RUNNING') row.statusCriticality = 2;
      }
    });

    await super.init();

    // Allow standalone read access to ChangeView (plugin sets Readable:false by default)
    const changeView = this.model.definitions['AdminService.ChangeView'];
    if (changeView) changeView['@Capabilities.ReadRestrictions.Readable'] = true;
  }

  async _executeAnonymization(user) {
    const { Users, UserMetaData, TaskRecords } = cds.entities('com.sap.developers.ims');
    const ops = buildAnonymizationOps(user);

    await UPDATE(Users, user.ID).set(ops.userUpdate);

    if (ops.deleteMetadata) {
      await DELETE.from(UserMetaData).where({ user_ID: user.ID });
    }

    await UPDATE(TaskRecords)
      .where({ user_ID: user.ID })
      .set({ createdBy: ops.auditFieldsValue, modifiedBy: ops.auditFieldsValue });
  }
}

function titlePathToMdFormat(titlePath) {
  if (!titlePath) return '';
  const parts = titlePath.split(/[:/]/);
  if (parts.length === 1) return parts[0].trim().replace(/[^A-Za-z\d]/g, '-').toLowerCase();
  const first = parts[0].trim().replace(/[^A-Za-z\d]/g, '-').toLowerCase();
  const last = parts[parts.length - 1].trim().replace(/[^A-Za-z\d]/g, '-').toLowerCase();
  return `${first}>${last}`;
}
