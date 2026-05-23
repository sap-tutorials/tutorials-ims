import cds from '@sap/cds';
import { computeEventStatistics, computeBurnup, computeTrackStats, computeCompletionSpeed } from './lib/event-statistics.js';
import { formatTaskRecordsCSV, formatAwardMissionsCSV } from './lib/export-helpers.js';
import { buildAnonymizationOps } from './lib/anonymization.js';
import { getNextLegacyId } from './lib/legacy-id.js';
import { embedSlugs } from './lib/embedding-pipeline.js';
import { randomUUID } from 'node:crypto';
import { parsePayload, classify, apply, sharedCache, MAX_BYTES } from './lib/tag-import/index.js';
import { buildCfLogsUrl } from './lib/cf-logs-link.js';

export default class AdminService extends cds.ApplicationService {

  async init() {
    const { Users, Tutorials, Missions, Groups, Events, TaskRecords,
            StepFailures, Tags, TutorialTags, UserMetaData,
            PrimaryAccounts, SecondaryAccounts, PrivacyProtectionActions,
            FeaturedTasks, CompletionPaths, CompletionPathItems,
            ChatSettings, ContentManifest, ContentFiles } = cds.entities('com.sap.developers.ims');
    const db = await cds.connect.to('db');
    const audit = await cds.connect.to('audit-log');

    // Serve enum code lists (no DB table — @cds.persistence.skip)
    this.on('READ', 'ExperienceLevels', () => [
      { code: 'beginner' }, { code: 'intermediate' }, { code: 'advanced' }
    ]);
    this.on('READ', 'TaskStatuses', () => [
      { code: 'ACTIVE' }, { code: 'INACTIVE' }
    ]);
    this.on('READ', 'MissionTypes', () => [
      { code: 'SEQUENTIAL' }, { code: 'SET' }
    ]);
    this.on('READ', 'TaskTypes', () => [
      { code: 'TUTORIAL' }, { code: 'GROUP' }, { code: 'CHECKPOINT' }
    ]);

    // Ensure singleton row exists for ChatSettings (defensive — seed CSV
    // populates this on cds deploy; this covers fresh in-memory test DBs).
    const CHAT_SETTINGS_SINGLETON_ID = '00000000-0000-0000-0000-00000000c8a7';
    this.before('READ', 'ChatSettings', async () => {
      const exists = await SELECT.one.from('com.sap.developers.ims.ChatSettings')
        .where({ ID: CHAT_SETTINGS_SINGLETON_ID });
      if (!exists) {
        await INSERT.into('com.sap.developers.ims.ChatSettings').entries({
          ID: CHAT_SETTINGS_SINGLETON_ID,
          enabled: false,
          maxRequestsPerUser: 100
        });
      }
    });

    // Auto-assign legacyId on creation for entities that need it
    const legacyKeyedEntities = [
      'Users', 'Tutorials', 'Missions', 'Groups', 'Events', 'TaskRecords',
      'StepFailures', 'Tags', 'Accomplishments', 'AccomplishmentRecords',
      'PrizeRecords', 'TutorialMeta', 'TutorialContributors', 'TutorialRepositories',
      'FeaturedTasks', 'PrimaryAccounts', 'SecondaryAccounts', 'PrivacyProtectionActions',
      'ActiveLearnerRecords', 'DashboardMonitoredRecords', 'CompletionPaths', 'CompletionPathItems',
      'GroupPathItems'
    ];
    for (const entity of legacyKeyedEntities) {
      this.before('CREATE', entity, async (req) => {
        if (!req.data.legacyId) {
          req.data.legacyId = await getNextLegacyId(entity, db);
        }
      });
    }

    // Gap-number itemOrder for new GroupPathItems rows so inline-created items
    // get a sensible order without the user typing one. NEW fires on draft
    // inline create (visible immediately); CREATE covers programmatic posts.
    const setGroupItemOrder = async (req) => {
      if (req.data.itemOrder != null) return;
      const groupId = req.data.group_ID
        || (Array.isArray(req.params) && req.params[0] && req.params[0].ID);
      if (!groupId) return;
      const row = await SELECT.one.from(req.target)
        .columns('max(itemOrder) as maxOrder')
        .where({ group_ID: groupId });
      req.data.itemOrder = ((row?.maxOrder ?? 0) + 10);
    };
    this.before('NEW', 'GroupPathItems.drafts', setGroupItemOrder);
    this.before('CREATE', 'GroupPathItems', setGroupItemOrder);

    // Validate Start Date < End Date on Events
    this.before(['CREATE', 'PATCH'], 'Events', (req) => {
      const { startDate, endDate } = req.data;
      if (startDate && endDate && new Date(startDate) >= new Date(endDate)) {
        req.reject(400, 'Start Date must be earlier than End Date');
      }
    });

    // Require at least one tag on Missions and Groups
    this.before('SAVE', 'Missions', async (req) => {
      const tags = req.data.tags;
      if (!tags || tags.length === 0) {
        req.reject(400, 'At least one Tag is required');
      }
    });
    this.before('SAVE', 'Groups', async (req) => {
      const tags = req.data.tags;
      if (!tags || tags.length === 0) {
        req.reject(400, 'At least one Tag is required');
      }
    });

    // Reset notification escalation when reviewedDate is updated via Fiori UI
    this.before('UPDATE', 'TutorialMeta', (req) => {
      if (req.data.reviewedDate) {
        req.data.notificationNumber = 0;
        req.data.lastNotificationDate = null;
      }
    });

    // --- Tutorials soft-delete + redirect validation ---
    // Delete on Tutorials must NOT remove the row — flip status to INACTIVE so the
    // public side returns 404 / redirects, while preserving history and the legacyId
    // so that bookmarked URLs stay redirectable.
    this.on('DELETE', 'Tutorials', async (req) => {
      const { ID } = req.data;
      if (!ID) return req.reject(400, 'Tutorial ID is required');
      const [existing] = await SELECT.from(Tutorials).where({ ID }).columns('ID', 'status');
      if (!existing) return req.reject(404, `Tutorial not found: ${ID}`);
      if (existing.status === 'INACTIVE') return; // already soft-deleted
      await UPDATE(Tutorials).set({ status: 'INACTIVE' }).where({ ID });
    });

    // Validate redirectTo on save:
    //   - only an INACTIVE tutorial may have a redirectTo target
    //   - cannot point to itself
    //   - target must exist and be ACTIVE
    this.before(['CREATE', 'UPDATE'], 'Tutorials', async (req) => {
      const { ID, status, redirectTo_ID } = req.data;
      const target = redirectTo_ID ?? req.data.redirectTo?.ID;
      if (target === undefined) return; // no change to redirectTo

      // Determine effective status (consider current DB value if not in payload)
      let effectiveStatus = status;
      if (effectiveStatus === undefined && ID) {
        const [row] = await SELECT.from(Tutorials).where({ ID }).columns('status');
        effectiveStatus = row?.status;
      }

      if (target === null) return; // clearing the redirect is always allowed

      if (effectiveStatus !== 'INACTIVE') {
        return req.reject(400, 'Redirect target can only be set on a deleted (INACTIVE) tutorial');
      }
      if (ID && target === ID) {
        return req.reject(400, 'Tutorial cannot redirect to itself');
      }
      const [tgt] = await SELECT.from(Tutorials).where({ ID: target }).columns('ID', 'status');
      if (!tgt) return req.reject(400, 'Redirect target tutorial not found');
      if (tgt.status === 'INACTIVE') {
        return req.reject(400, 'Redirect target must be an active tutorial');
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

    this.on('exportMissionCompletions', async (req) => {
      const { startDate, endDate, missionLegacyId } = req.data;
      if (!startDate || !endDate) return req.reject(400, 'startDate and endDate are required');

      let query = SELECT.from(TaskRecords)
        .where({ taskType: 'MISSION', status: 'COMPLETED' })
        .and(`completionDate >=`, startDate)
        .and(`completionDate <=`, endDate);
      if (missionLegacyId) query = query.and({ taskLegacyId: missionLegacyId });

      const records = await query;

      const userIds = [...new Set(records.map(r => r.user_ID))];
      const users = userIds.length > 0
        ? await SELECT.from(Users).where({ ID: { in: userIds } })
        : [];
      const userMap = new Map(users.map(u => [u.ID, u]));

      const missions = await SELECT.from(Missions).columns('legacyId', 'title');
      const missionMap = new Map(missions.map(m => [m.legacyId, m.title]));

      const header = 'Mission Title,Mission ID,Login,Username,Email,Completion Date,SAP ID';
      const rows = records.map(r => {
        const user = userMap.get(r.user_ID);
        const completionDate = r.completionDate
          ? new Date(r.completionDate).toISOString().replace('T', ' ').slice(0, 19)
          : '';
        return [
          csvEscape(missionMap.get(r.taskLegacyId) || ''),
          r.taskLegacyId || '',
          csvEscape(user?.email || ''),
          csvEscape(user?.displayName || ''),
          csvEscape(user?.email || ''),
          completionDate,
          csvEscape(user?.sapId || '')
        ].join(',');
      });
      return [header, ...rows].join('\n');
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

    this.on('previewTagImport', async (req) => {
      const log = cds.log('tag-import');
      const started = Date.now();
      const { payload, format } = req.data;

      if (!payload) return req.error(400, 'payload is required');
      if (typeof payload !== 'string') return req.error(400, 'payload must be a string');
      if (Buffer.byteLength(payload, 'utf8') > MAX_BYTES) {
        return req.error(413, `Payload exceeds ${MAX_BYTES} bytes`);
      }
      if (!['csv', 'json'].includes(format)) {
        return req.error(400, `format must be 'csv' or 'json'`);
      }

      let parsed;
      try {
        parsed = parsePayload(payload, format);
      } catch (e) {
        return req.error(400, e.message);
      }

      const existingTags = await SELECT.from(Tags).columns('ID', 'name', 'titlePath');
      const { summary, rows } = classify(parsed.rows, existingTags);

      const token = randomUUID();
      sharedCache.set(token, { rows, classifiedAt: Date.now() });

      log.info({
        event: 'tag-import.preview',
        user: req.user?.id,
        total: summary.total,
        summary,
        durationMs: Date.now() - started
      });

      return {
        token,
        summary,
        rows,
        parseWarnings: parsed.parseErrors
      };
    });

    this.on('commitTagImport', async (req) => {
      const log = cds.log('tag-import');
      const started = Date.now();
      const { token, strategy } = req.data;

      if (!token) return req.error(400, 'token is required');
      if (!['upsert', 'skip-duplicates', 'abort-on-duplicate'].includes(strategy)) {
        return req.error(400, `strategy must be one of upsert, skip-duplicates, abort-on-duplicate`);
      }

      const cached = sharedCache.get(token);
      if (!cached) return req.error(410, 'Preview expired or unknown token; please re-upload');

      // Re-classify inside the request to catch races (another admin inserting
      // between preview and commit). The cached parsed rows stay as-is; only the
      // classification against existing tags is refreshed.
      const existingTags = await SELECT.from(Tags).columns('ID', 'name', 'titlePath');
      const inputRows = cached.rows.map(r => r.status === 'invalid'
        ? { invalid: true, name: r.name, titlePath: r.titlePath, reason: r.reason }
        : { name: r.name, titlePath: r.titlePath });
      const { rows: freshRows } = classify(inputRows, existingTags);

      let result;
      try {
        result = await apply(freshRows, strategy, db);
      } catch (e) {
        if (/conflict/i.test(e.message) && strategy === 'abort-on-duplicate') {
          return req.error(409, e.message);
        }
        throw e;
      }

      log.info({
        event: 'tag-import.commit',
        user: req.user?.id,
        strategy,
        ...result,
        durationMs: Date.now() - started
      });

      return result;
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

    // --- RAG / Embeddings ---

    this.on('seedEmbeddings', async (req) => {
      const settings = await SELECT.one.from(ChatSettings);
      if (!settings?.ragEnabled) return req.error(400, 'ragEnabled must be true');

      const manifest = await SELECT.one.from(ContentManifest)
        .where({ status: 'ACTIVE' })
        .orderBy({ version: 'desc' });
      if (!manifest) return req.error(409, 'no active content manifest');

      const files = await SELECT.from(ContentFiles).columns('slug').where({ version: manifest.version });
      const slugs = files.map(f => f.slug);

      setImmediate(() => embedSlugs(slugs, settings).catch(err => {
        cds.log('rag-seed').warn('seed failed', err.message);
      }));

      return { queued: true, activeSlugs: slugs.length };
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
      const { backfillMissingTutorialMeta } = await import('./lib/tutorial-meta-init.js');
      const { created } = await backfillMissingTutorialMeta();
      return { synced: created, message: `Backfilled ${created} TutorialMeta rows. Use rebuild-content.yml to refresh review dates.` };
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
      const dashboardUrl = process.env.DASHBOARD_URL || 'https://tutorials-approuter.cfapps.eu10-005.hana.ondemand.com/ui/tutorialDashboard';

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

    this.on('getBoardStatistics', async () => {
      const { TutorialMeta } = cds.entities('com.sap.developers.ims');

      const [userCount] = await SELECT.from(Users).columns('count(*) as cnt');
      const [tutorialCount] = await SELECT.from(Tutorials).columns('count(*) as cnt');
      const [groupCount] = await SELECT.from(Groups).columns('count(*) as cnt');
      const [missionCount] = await SELECT.from(Missions).columns('count(*) as cnt');

      const avgByType = await SELECT.from(TaskRecords)
        .columns('taskType', 'avg(progress) as avgProgress')
        .where({ status: 'COMPLETED' })
        .groupBy('taskType');
      const avgMap = new Map(avgByType.map(r => [r.taskType, Math.round(r.avgProgress || 0)]));

      const now = new Date();
      const sixMonthsAgo = new Date(now.getFullYear(), now.getMonth() - 6, now.getDate()).toISOString();
      const [upToDateCount] = await SELECT.from(TutorialMeta)
        .columns('count(*) as cnt')
        .where('reviewedDate >=', sixMonthsAgo);
      const totalMeta = tutorialCount.cnt;
      const upToDate = upToDateCount.cnt;

      return {
        totalUsers: userCount.cnt,
        totalTutorials: tutorialCount.cnt,
        totalGroups: groupCount.cnt,
        totalMissions: missionCount.cnt,
        avgTutorialCompletion: avgMap.get('TUTORIAL') || 0,
        avgGroupCompletion: avgMap.get('GROUP') || 0,
        avgMissionCompletion: avgMap.get('MISSION') || 0,
        tutorialsUpToDate: upToDate,
        tutorialsNeedReview: totalMeta - upToDate
      };
    });

    this.after('READ', 'PipelineLog', rows => {
      for (const row of Array.isArray(rows) ? rows : [rows]) {
        if (row.status === 'SUCCESS') row.statusCriticality = 3;
        else if (row.status === 'FAILED') row.statusCriticality = 1;
        else if (row.status === 'RUNNING') row.statusCriticality = 2;
        row.cfLogsUrl = buildCfLogsUrl(row);
      }
    });

    this.after('READ', 'JobExecutionLog', rows => {
      for (const row of Array.isArray(rows) ? rows : [rows]) {
        if (row.status === 'SUCCESS') row.statusCriticality = 3;
        else if (row.status === 'FAILED') row.statusCriticality = 1;
        else if (row.status === 'RUNNING') row.statusCriticality = 2;
        row.cfLogsUrl = buildCfLogsUrl(row);
      }
    });

    this.after('READ', 'PipelineLogItems', rows => {
      for (const row of Array.isArray(rows) ? rows : [rows]) {
        if (row.severity === 'ERROR') row.severityCriticality = 1;
        else if (row.severity === 'WARN') row.severityCriticality = 2;
        else row.severityCriticality = 0;
      }
    });

    this.after('READ', 'JobLogItems', rows => {
      for (const row of Array.isArray(rows) ? rows : [rows]) {
        if (row.status === 'ERROR') row.statusCriticality = 1;
        else if (row.status === 'WARN') row.statusCriticality = 2;
        else if (row.status === 'SUCCESS') row.statusCriticality = 3;
        else row.statusCriticality = 0;
      }
    });

    // Guard: only SuperAdmin can change the published field
    const _guardPublished = (req) => {
      if (!('published' in req.data)) return;
      if (req.event === 'CREATE' && req.data.published !== false) return;
      if (!req.user.is('SuperAdmin')) {
        req.reject(403, 'Only SuperAdmin can change the published state');
      }
    };
    this.before(['CREATE', 'PATCH'], ['Missions', 'Groups'], _guardPublished);
    this.before('PATCH', ['Missions.drafts', 'Groups.drafts'], _guardPublished);

    // Compute dynamic field control for published field
    this.after('READ', ['Missions', 'Groups'], (data, req) => {
      const isSuperAdmin = req.user.is('SuperAdmin');
      const controlValue = isSuperAdmin ? 7 : 1;
      for (const row of Array.isArray(data) ? data : [data]) {
        if (row) row.publishedFieldControl = controlValue;
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

function csvEscape(value) {
  const str = String(value);
  if (str.includes(',') || str.includes('"') || str.includes('\n')) {
    return '"' + str.replace(/"/g, '""') + '"';
  }
  return str;
}
