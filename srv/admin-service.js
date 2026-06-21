import cds from '@sap/cds';
import { computeEventStatistics, computeBurnup, computeTrackStats, computeCompletionSpeed } from './lib/event-statistics.js';
import { formatTaskRecordsCSV, formatAwardMissionsCSV } from './lib/export-helpers.js';
import { getNextLegacyId } from './lib/legacy-id.js';
import { embedSlugs } from './lib/embedding-pipeline.js';
import { randomUUID } from 'node:crypto';
import { parsePayload, classify, apply, sharedCache, MAX_BYTES } from './lib/tag-import/index.js';
import { buildCfLogsUrl } from './lib/cf-logs-link.js';
import { resolveDisplaySettings } from './lib/runtime-config/display-settings.js';
import { reviewTutorial, snoozeTutorial } from './lib/tutorial-review.js';
import { slugify, ensureUniqueSlug } from './lib/slug-utils.js';
import { classifyAndPersist } from './lib/category-classifier.js';
import { makeAltGroupHandler } from './handlers/completion-path-items-altgroup.js';
import * as advocateHandlers from './handlers/advocate-handlers.js';
import { classifySeverity, daysUntil } from './jobs/secret-expiry-check.js';
import { readSecret, writeSecret, deleteSecret } from './lib/credstore.js';
import { randomBytes } from 'node:crypto';

export default class AdminService extends cds.ApplicationService {

  async init() {
    const { Users, Tutorials, Missions, Groups, Events, TaskRecords,
            StepFailures, Tags, TutorialTags, UserMetaData,
            PrimaryAccounts, SecondaryAccounts, PrivacyProtectionActions,
            FeaturedTasks, CompletionPaths, CompletionPathItems,
            ChatSettings, ContentManifest, ContentFiles,
            GroupSlugRedirects, MissionSlugRedirects } = cds.entities('com.sap.developers.ims');
    const db = await cds.connect.to('db');

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
    this.on('READ', 'AdvocateRegions', () => [
      { code: 'AMERICAS', label: 'Americas' },
      { code: 'EMEA',     label: 'EMEA' },
      { code: 'APJ',      label: 'APJ' },
    ]);
    this.on('READ', 'AnalyticsTaskTypes', () => [
      { code: 'TUTORIAL', label: 'Tutorial' },
      { code: 'GROUP',    label: 'Group'    },
      { code: 'MISSION',  label: 'Mission'  }
    ]);
    this.on('READ', 'AnalyticsLevels', () => [
      { code: 'beginner',     label: 'Beginner'     },
      { code: 'intermediate', label: 'Intermediate' },
      { code: 'advanced',     label: 'Advanced'     }
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
      'CompletionPaths', 'CompletionPathItems',
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

    // Issue #172 — refuse incoherent alt-group shapes.
    // Per PR 2 reviewer addendum item G: enforceMultiMember=false on CREATE
    // (authors create members one at a time in Fiori draft).
    this.before('CREATE', 'CompletionPathItems', makeAltGroupHandler('CompletionPathItems', 'path_ID', 'CREATE'));
    this.before('UPDATE', 'CompletionPathItems', makeAltGroupHandler('CompletionPathItems', 'path_ID', 'UPDATE'));
    this.before('CREATE', 'GroupPathItems',      makeAltGroupHandler('GroupPathItems',      'group_ID', 'CREATE'));
    this.before('UPDATE', 'GroupPathItems',      makeAltGroupHandler('GroupPathItems',      'group_ID', 'UPDATE'));

    // Advocates: auto-derive slug from firstName + lastName on CREATE.
    advocateHandlers.register(this);

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

    // [#436] Publish-time integrity guard: refuse a published=true transition
    // when any CompletionPathItems row is unresolvable. Drafts and unpublished
    // saves still allow partial state for incremental authoring; only the
    // false→true publish gate enforces correctness.
    this.before('SAVE', 'Missions', async (req) => {
      if (req.data.published !== true) return;
      const ID = req.data.ID;
      if (!ID) return;

      // Detect transition: only refuse on false→true, not when re-saving an
      // already-published mission whose payload echoes published=true.
      const [prior] = await SELECT.from(Missions).where({ ID }).columns('published');
      if (prior?.published === true) return;

      const paths = await SELECT.from(CompletionPaths)
        .where({ mission_ID: ID })
        .columns('ID', 'name');
      for (const path of paths) {
        const items = await SELECT.from(CompletionPathItems)
          .where({ path_ID: path.ID })
          .columns('ID', 'itemOrder', 'taskType', 'tutorial_ID', 'group_ID', 'checkpointTitle');
        for (const item of items) {
          const ord = item.itemOrder ?? '?';
          if (item.itemOrder == null) {
            return req.reject(400, `Cannot publish: path "${path.name}" has an item with no itemOrder`);
          }
          switch (item.taskType) {
            case 'TUTORIAL':
              if (!item.tutorial_ID) {
                return req.reject(400, `Cannot publish: path "${path.name}" item ${ord} has taskType=TUTORIAL but no tutorial linked`);
              }
              break;
            case 'GROUP':
              if (!item.group_ID) {
                return req.reject(400, `Cannot publish: path "${path.name}" item ${ord} has taskType=GROUP but no group linked`);
              }
              break;
            case 'CHECKPOINT':
              if (!item.checkpointTitle) {
                return req.reject(400, `Cannot publish: path "${path.name}" item ${ord} has taskType=CHECKPOINT but no checkpointTitle`);
              }
              break;
            default:
              return req.reject(400, `Cannot publish: path "${path.name}" item ${ord} has unknown taskType "${item.taskType}"`);
          }
        }
      }
    });

    this.before('SAVE', 'Groups', async (req) => {
      const tags = req.data.tags;
      if (!tags || tags.length === 0) {
        req.reject(400, 'At least one Tag is required');
      }
    });

    // Auto-derive slug from title for Missions and Groups so admin-created
    // records have stable URL fragments (/tutorials/group-<slug>,
    // /tutorials/mission-<slug>) without authors typing them.
    //
    // Fires on the full draft lifecycle:
    //   - NEW (draft create) and PATCH (draft autosave): keep slug visible
    //     and current as the title evolves in the draft.
    //   - SAVE (activation): final reconciliation against active table for
    //     uniqueness, since other drafts may have activated meanwhile. Also
    //     records the prior slug into the redirect history so old URLs
    //     302-survive renames (issue #91).
    //   - CREATE: programmatic non-draft POST (tests, scripts).
    //
    // Collisions resolved by appending -2, -3, ... within the entity's table.
    const deriveSlugForEntity = (entityName) => async (req) => {
      const isCreate = req.event === 'CREATE' || req.event === 'NEW';
      const ID = req.data.ID;
      const title = req.data.title;

      // Pull current persisted state so we can compare title→slug. For NEW the
      // row doesn't exist yet; for PATCH/SAVE it's the active or draft row.
      let prior = null;
      if (!isCreate && ID) {
        [prior] = await SELECT.from(req.target)
          .where({ ID })
          .columns('title', 'slug');
      }

      const effectiveTitle = title ?? prior?.title;
      if (!effectiveTitle) return; // tag/save validation handles missing title

      const base = slugify(effectiveTitle);

      // Skip when nothing relevant changed: title untouched and slug already set.
      if (!isCreate && prior?.slug && (title === undefined || title === prior.title)) {
        return;
      }

      const Entity = entityName === 'Missions' ? Missions : Groups;
      const rows = await SELECT.from(Entity)
        .columns('ID', 'slug')
        .where({ slug: { '!=': null } });
      const taken = new Set(
        rows.filter(r => r.ID !== ID).map(r => r.slug).filter(Boolean)
      );

      const newSlug = ensureUniqueSlug(base, taken, prior?.slug ?? null);
      req.data.slug = newSlug;

      // Record the prior slug into redirect history. Only on SAVE (active-row
      // activation) and CREATE (programmatic non-draft) — draft autosaves
      // (NEW / PATCH) shouldn't accumulate redirect rows for in-progress
      // titles the admin is still typing. See #91 follow-up.
      // Record the prior slug into redirect history. Only when the active
      // entity is being written (not drafts) — draft autosaves shouldn't
      // accumulate redirect rows for in-progress titles. Two paths reach the
      // active entity:
      //   - Initial draftActivate: req.event === 'CREATE' (no prior slug, so
      //     the prior?.slug guard below skips harmlessly).
      //   - Re-edit + draftActivate: req.event === 'UPDATE' on the active row,
      //     prior holds the active row's pre-update slug.
      // Programmatic non-draft writes also reach here as CREATE/UPDATE.
      // SAVE fires too on some handler chains, so accept it as well.
      // See #91 follow-up.
      const targetName = String(req.target?.name ?? '');
      const writingActive = !targetName.endsWith('.drafts')
        && (req.event === 'SAVE' || req.event === 'CREATE' || req.event === 'UPDATE');
      if (writingActive && prior?.slug && prior.slug !== newSlug) {
        const Redirect = entityName === 'Missions' ? MissionSlugRedirects : GroupSlugRedirects;
        const fk = entityName === 'Missions' ? 'mission_ID' : 'group_ID';

        // Slug-reuse: if newSlug was previously held by some other entity in
        // this table, drop that historic record so the redirect points at the
        // current owner (whoever owns the slug now wins). Also drop any prior
        // record for the just-vacated slug under THIS entity so we don't
        // accumulate dupes when a title bounces A → B → A.
        await DELETE.from(Redirect).where({ slug: { in: [newSlug, prior.slug] } });

        await INSERT.into(Redirect).entries({
          ID: randomUUID(),
          [fk]: ID,
          slug: prior.slug,
        });
      }
    };

    for (const entityName of ['Missions', 'Groups']) {
      const handler = deriveSlugForEntity(entityName);
      this.before('CREATE', entityName, handler);
      this.before('NEW',    `${entityName}.drafts`, handler);
      this.before('PATCH',  `${entityName}.drafts`, handler);
      this.before('SAVE',   entityName, handler);
    }

    // [#436] legacyId self-heal for entities authored via the admin UI's draft
    // lifecycle (NEW on .drafts → PATCH autosaves → SAVE on activation). The
    // existing legacyKeyedEntities loop at lines 71-85 covers `before('CREATE')`
    // for programmatic POSTs, but NEW/PATCH/SAVE on draft-edited entities never
    // hit CREATE — so missions/groups/paths created via Fiori (the #382 F1 path)
    // ended up with NULL legacyId.
    //
    // This handler:
    //   - Fires on NEW (draft create), PATCH (draft autosave), SAVE (activation)
    //   - Does NOT register for CREATE (already handled by the line 71 loop)
    //   - Self-heals UPDATE/PATCH/SAVE on existing rows whose legacyId is NULL
    //   - Skips when the row already has legacyId (idempotent across draft lifecycle)
    const initLegacyIdForEntity = (entityName) => async (req) => {
      if (req.data.legacyId != null) return;
      // Self-heal path: only do the prior-row lookup when the row exists. NEW
      // (draft create) carries a fresh UUID in req.data.ID but has no prior
      // row, so skip the SELECT to save a round-trip.
      if (req.data.ID && (req.event === 'PATCH' || req.event === 'SAVE' || req.event === 'UPDATE')) {
        const [prior] = await SELECT.from(req.target).where({ ID: req.data.ID }).columns('legacyId');
        if (prior?.legacyId != null) return;
      }
      req.data.legacyId = await getNextLegacyId(entityName, db);
    };

    for (const entityName of ['Missions', 'Groups', 'CompletionPaths']) {
      const handler = initLegacyIdForEntity(entityName);
      this.before('NEW',   `${entityName}.drafts`, handler);
      this.before('PATCH', `${entityName}.drafts`, handler);
      this.before('SAVE',  entityName,             handler);
      // CREATE is intentionally NOT registered here — the existing
      // legacyKeyedEntities loop at lines 71-85 already covers it.
    }

    // [#436] Auto-derive CompletionPaths.slug from name. Mirrors
    // deriveSlugForEntity but adapted for two CompletionPaths-specific facts:
    //   1. The source field is `name`, not `title`.
    //   2. Slug uniqueness is scoped to the parent mission, not the entity table —
    //      two missions can each legitimately have a "Path A".
    const deriveCompletionPathSlug = async (req) => {
      const isCreate = req.event === 'CREATE' || req.event === 'NEW';
      const ID = req.data.ID;
      const name = req.data.name;
      const missionId = req.data.mission_ID;

      let prior = null;
      if (!isCreate && ID) {
        [prior] = await SELECT.from(req.target).where({ ID }).columns('name', 'slug', 'mission_ID');
      }
      const effectiveName = name ?? prior?.name;
      const effectiveMission = missionId ?? prior?.mission_ID;
      if (!effectiveName || !effectiveMission) return;

      const base = slugify(effectiveName);
      if (!isCreate && prior?.slug && (name === undefined || name === prior.name)) return;

      // Scope-unique: only collide against siblings under the same mission.
      const siblings = await SELECT.from(CompletionPaths)
        .columns('ID', 'slug')
        .where({ mission_ID: effectiveMission, slug: { '!=': null } });
      const taken = new Set(
        siblings.filter(r => r.ID !== ID).map(r => r.slug).filter(Boolean)
      );

      req.data.slug = ensureUniqueSlug(base, taken, prior?.slug ?? null);
    };

    this.before('CREATE', 'CompletionPaths', deriveCompletionPathSlug);
    this.before('NEW',    'CompletionPaths.drafts', deriveCompletionPathSlug);
    this.before('PATCH',  'CompletionPaths.drafts', deriveCompletionPathSlug);
    this.before('SAVE',   'CompletionPaths', deriveCompletionPathSlug);

    // Reset notification escalation when reviewedDate is updated via Fiori UI
    this.before('UPDATE', 'TutorialMeta', (req) => {
      if (req.data.reviewedDate) {
        req.data.notificationNumber = 0;
        req.data.lastNotificationDate = null;
        req.data.firstNotificationDate = null;  // #450: clear all 3 fields atomically
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
    });

    this.on('anonymizeByDsrRequest', async (req) => {
      const { sapId, dsrRequestNumber } = req.data;
      const user = await SELECT.one.from(Users).where({ sapId });
      if (!user) return req.reject(404, `User not found with sapId: ${sapId}`);
      await this._executeAnonymization(user, { dsrRequestNumber });
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
      try {
        return await reviewTutorial(req.data.tutorialId);
      } catch (err) {
        if (err.code === 404) return req.reject(404, err.message);
        throw err;
      }
    });

    this.on('snoozeTutorial', async (req) => {
      try {
        return await snoozeTutorial(req.data.tutorialId, req.data.days);
      } catch (err) {
        if (err.code === 404) return req.reject(404, err.message);
        throw err;
      }
    });

    this.on('sendContributorNotifications', async (req) => {
      const { computeStaleNotifications, determineRecipients, markNotificationSent, getAdminEmailList } = await import('./lib/contributor-notifications.js');
      const { sendNotificationEmail } = await import('./lib/mail-client.js');

      const adminEmails = await getAdminEmailList();
      const notifications = await computeStaleNotifications(90);
      const dashboardUrl = (await resolveDisplaySettings()).dashboardUrl;

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

    // Guard: only SuperAdmin can change the published flag in either direction
    // (publish OR unpublish). The CREATE exemption permits the runtime's
    // draft-activation flow, where the activation payload echoes published=false
    // (the column default per #348) — this is a pass-through, not a change,
    // so we let regular Admins activate new drafts without elevating.
    // Any explicit published=true on CREATE is still a change (against the
    // false default) and requires SuperAdmin. Any PATCH that touches published
    // is a change against an existing row's value and always requires SuperAdmin.
    const _guardPublished = (req) => {
      if (!('published' in req.data)) return;
      if (req.event === 'CREATE' && req.data.published === false) return;
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

    // --- classifyCategories: bulk AI category assignment with job-lock ---
    this.on('classifyCategories', async (req) => {
      const { kind, ids, force } = req.data;
      const { acquireLock, releaseLock } = await import('./jobs/job-lock.js');
      const LOCK_NAME = 'categories-classify';
      const INSTANCE_ID = process.env.CF_INSTANCE_INDEX || 'local';
      const LOCK_DURATION_MS = 30 * 60 * 1000;
      const acquired = await acquireLock(LOCK_NAME, INSTANCE_ID, LOCK_DURATION_MS);
      if (!acquired) {
        return { processed: 0, succeeded: 0, failed: 0, skipped: 1 };
      }
      try {
        const targets = await this._collectClassifyTargets(kind, ids);
        let succeeded = 0, failed = 0, skipped = 0;
        const CONCURRENCY = 4;
        for (let i = 0; i < targets.length; i += CONCURRENCY) {
          const batch = targets.slice(i, i + CONCURRENCY);
          const results = await Promise.allSettled(
            batch.map(t => classifyAndPersist(t.kind, t.id, { force }))
          );
          for (const r of results) {
            if (r.status === 'rejected') failed++;
            else if (r.value.kept === 1) succeeded++;
            else skipped++;
          }
        }
        return { processed: targets.length, succeeded, failed, skipped };
      } finally {
        await releaseLock(LOCK_NAME, INSTANCE_ID);
      }
    });

    this.on('embedAllSeeds', async () => {
      const { _resetCache, getSeedEmbeddings } = await import('./lib/category-seed-embeddings.js');
      _resetCache(); // force re-embed of all seeds on next call
      const map = await getSeedEmbeddings();
      return { processed: map.size };
    });

    // Phase 2-B (#464): Severity-classified expiry warnings for the
    // admin-shell notifications popover. Read-only — no DB writes.
    // Imports daysUntil + classifySeverity from the cron module to share
    // the threshold + UTC-truncation contract.
    this.on('secretWarnings', async (req) => {
      const { Secrets } = cds.entities('com.sap.developers.ims');
      const rows = await SELECT.from(Secrets)
        .columns('key', 'description', 'expiresAt', 'rotationOwner', 'rotationDocsUrl')
        .where({ expiresAt: { '!=': null } });

      const now = new Date();
      const warnings = [];
      for (const row of rows) {
        const daysRemaining = daysUntil(row.expiresAt, now);
        const severity = classifySeverity(daysRemaining);
        if (!severity) continue;
        warnings.push({
          key: row.key,
          description: row.description ?? '',
          daysRemaining,
          severity,
          rotationOwner: row.rotationOwner ?? '',
          rotationDocsUrl: row.rotationDocsUrl ?? '',
        });
      }

      warnings.sort((a, b) => a.daysRemaining - b.daysRemaining);
      return warnings;
    });

    // ──────────────────────────────────────────────────────────────────────
    // Phase 2-C (#465): Secret value operations via BTP Credential Store.
    // Helpers + 4 handlers (3 actions + 1 function on Secrets).
    // ──────────────────────────────────────────────────────────────────────

    // ~30 second reveal window. Server-supplied; tile auto-hides on this expiry.
    const REVEAL_WINDOW_MS = 30_000;

    // Self-generate-able kinds — admin clicks Rotate, server mints + writes.
    const SELF_GEN_KINDS = new Set(['salt', 'content-api-key']);

    // Load the Secrets row by bound-action ID. All 4 handlers need this.
    // IMPORTANT 7: defensive guard against missing req.params shape (e.g. if
    // an action ever ends up wrongly bound to collection rather than instance,
    // req.params is []).
    const loadSecretRow = async (req) => {
      const { Secrets } = cds.entities('com.sap.developers.ims');
      const id = req.params?.[0]?.ID;
      if (!id) return req.reject(400, 'Secret ID required (bound to instance, not collection)');
      const row = await SELECT.one.from(Secrets).where({ ID: id });
      if (!row) req.reject(404, 'Secret not found');
      return row;
    };

    // Stamp lastRotatedAt on the row.
    const stampRotated = async (id) => {
      const { Secrets } = cds.entities('com.sap.developers.ims');
      const ts = new Date();
      await UPDATE(Secrets).set({ lastRotatedAt: ts }).where({ ID: id });
      return ts;
    };

    // BLOCKING 1: audit-log helper. Verified against existing usage at
    // srv/admin-service.js:1073 (canonical pattern: cds.connect.to('audit-log')
    // + audit.log('SecurityEvent', { data: { action, ...} })) and the
    // graceful-degradation pattern at srv/knowledge-graph-service.js:395-410
    // (warn on bind failure, warn on each write failure — visible monitoring,
    // not silent swallow).
    //
    // 'SecurityEvent' is the ONLY event name registered in the
    // @cap-js/audit-logging plugin's CDS service definition (alongside
    // SensitiveDataRead / PersonalDataModified / ConfigurationModified for
    // other entity-semantics). Custom event names like 'SecretValueRead'
    // are NOT registered and would silently drop or throw depending on
    // plugin version. The action discriminator therefore goes into
    // data.action — every call site stays ergonomic via this helper.
    //
    // cds.audit?.log?.(...) does NOT exist — optional-chaining would mean
    // audit events silently never fire. Use this helper everywhere instead.
    //
    // Hoisted bind: a missing audit binding (mis-MTA-config / dropped
    // binding after redeploy — feedback_cf_set_env_drops_on_redeploy) warns
    // ONCE at boot, not silently per call. Per-event throws are caught and
    // warned, NOT propagated — a successful credstore mutation must not
    // become a 500 to the admin just because audit logging hiccuped.
    const LOG = cds.log('admin-service');
    let _auditLog = null;
    try {
      _auditLog = await cds.connect.to('audit-log');
    } catch (err) {
      LOG.warn(`admin-service: audit-log binding unavailable (${err.message ?? err}); Secrets value ops will not be audited`);
    }
    const auditEvent = async (action, data) => {
      if (!_auditLog) return;
      try {
        await _auditLog.log('SecurityEvent', { data: { action, ...data } });
      } catch (err) {
        LOG.warn(`admin-service: audit log write failed for ${action} (${err.message ?? err})`);
      }
    };

    // IMPORTANT 8: response-header helper using public API. req._.res is CAP
    // internal and not guaranteed stable across minor versions. Prefer req.req.res
    // (the Express req has .res back-ref), fall back to req._.res, and silently
    // no-op if neither resolves. Action's return value carries the actual data
    // either way; the header is defense-in-depth.
    const setNoStoreHeaders = (req) => {
      const res = req.req?.res ?? req._?.res;
      if (res?.setHeader) {
        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
        res.setHeader('Pragma', 'no-cache');
      }
    };

    // ────────────────────────────────────────────────────────────────────
    this.on('setSecretValue', 'Secrets', async (req) => {
      const row = await loadSecretRow(req);
      const { value } = req.data;
      if (!value || typeof value !== 'string') {
        return req.reject(400, 'value (non-empty string) is required');
      }
      await writeSecret(row.key, value);
      // IMPORTANT 2 (quality-review): emit audit event immediately after the
      // external credstore mutation succeeds. The subsequent stampRotated() is
      // a HANA UPDATE that may fail / abort — if it does, the credstore has
      // the new value but the CRUD interceptor never fires (UPDATE didn't
      // commit). Without this explicit event, a successful write would
      // produce ZERO audit trail. Order: external mutation → audit → metadata.
      await auditEvent('SecretValueWritten', {
        user: req.user?.id,
        secretKey: row.key,
      });
      const lastRotatedAt = await stampRotated(row.ID);
      // CRUD interceptor on Secrets fires for the UPDATE on lastRotatedAt
      // → captured by @PersonalData.EntitySemantics: 'Other'; no explicit
      // audit event needed here.
      return { written: true, lastRotatedAt };
    });

    // ────────────────────────────────────────────────────────────────────
    this.on('rotateSecretValue', 'Secrets', async (req) => {
      const row = await loadSecretRow(req);
      const kindNormalized = String(row.kind ?? '').trim().toLowerCase();
      if (!SELF_GEN_KINDS.has(kindNormalized)) {
        // Vendor-side: emit audit event (no value mutation occurred but the
        // user attempted a rotation, worth logging).
        await auditEvent('SecretValueRotateAttempted', {
          user: req.user?.id,
          secretKey: row.key,
          rotated: false,
        });
        return {
          rotated: false,
          reason: 'vendor-side',
          newValue: '',
          written: false,
          lastRotatedAt: null,
          revealExpiresAt: null,
          rotationDocsUrl: row.rotationDocsUrl ?? '',
        };
      }
      // 32 bytes hex = 64-char string. Strong enough for salt + api-key.
      const newValue = randomBytes(32).toString('hex');
      await writeSecret(row.key, newValue);
      // IMPORTANT 2 (quality-review): see setSecretValue for the same race.
      // Emit the write event BEFORE stampRotated in case HANA UPDATE fails.
      // The 'SecretValueRotated' event below is still emitted (richer payload)
      // but this one guarantees the external mutation appears in the audit
      // trail even if everything after this line throws.
      await auditEvent('SecretValueWritten', {
        user: req.user?.id,
        secretKey: row.key,
      });
      const lastRotatedAt = await stampRotated(row.ID);
      const revealExpiresAt = new Date(Date.now() + REVEAL_WINDOW_MS);
      // Custom action emitting plaintext — explicit audit event needed.
      await auditEvent('SecretValueRotated', {
        user: req.user?.id,
        secretKey: row.key,
        rotated: true,
      });
      return {
        rotated: true,
        reason: 'self-generated',
        newValue,
        written: true,
        lastRotatedAt,
        revealExpiresAt,
        rotationDocsUrl: '',
      };
    });

    // ────────────────────────────────────────────────────────────────────
    this.on('clearSecretValue', 'Secrets', async (req) => {
      const row = await loadSecretRow(req);
      await deleteSecret(row.key);
      // No HANA mutation; explicit audit event needed.
      await auditEvent('SecretValueCleared', {
        user: req.user?.id,
        secretKey: row.key,
      });
      return { cleared: true };
    });

    // ────────────────────────────────────────────────────────────────────
    this.on('revealSecretValue', 'Secrets', async (req) => {
      const row = await loadSecretRow(req);
      const value = await readSecret(row.key);
      if (value == null) return req.reject(404, 'No value stored for this secret');

      // Defense-in-depth: don't let proxies cache the response, even though
      // /admin/* is XSUAA-gated. `private` for shared-cache defense.
      // Best-effort: action's return value carries the data regardless.
      setNoStoreHeaders(req);

      // Function (read-only OData) — explicit audit event needed.
      // The value is NOT logged; only the access event.
      await auditEvent('SecretValueRead', {
        user: req.user?.id,
        secretKey: row.key,
      });

      return {
        value,
        expiresAt: new Date(Date.now() + REVEAL_WINDOW_MS),
      };
    });

    await super.init();

    // Allow standalone read access to ChangeView (plugin sets Readable:false by default)
    const changeView = this.model.definitions['AdminService.ChangeView'];
    if (changeView) changeView['@Capabilities.ReadRestrictions.Readable'] = true;
  }

  async _collectClassifyTargets(kind, ids) {
    const out = [];
    const kinds = kind === 'all' ? ['mission', 'group', 'tutorial'] : [kind];
    for (const k of kinds) {
      const entityName = { mission: 'Missions', group: 'Groups', tutorial: 'Tutorials' }[k];
      const where = (Array.isArray(ids) && ids.length > 0) ? { ID: { in: ids } } : {};
      const rows = await SELECT.from(entityName).columns('ID').where(where);
      for (const r of rows) out.push({ kind: k, id: r.ID });
    }
    return out;
  }

  async _executeAnonymization(user, opts = {}) {
    const db = await cds.connect.to('db');
    const { PrivacyProtectionActions } = cds.entities('com.sap.developers.ims');
    const { dsrRequestNumber } = opts;

    // 1. DSR-only: open the action row (idempotent — guard if it already exists).
    if (dsrRequestNumber) {
      const existing = await SELECT.one.from(PrivacyProtectionActions).where({
        userUuid: user.uuid, actionType: 'ANONYMIZE'
      });
      if (!existing) {
        await INSERT.into(PrivacyProtectionActions).entries({
          userUuid: user.uuid,
          actionType: 'ANONYMIZE',
          requestedAt: new Date().toISOString(),
          status: 'PROCESSING',
          legacyId: await getNextLegacyId('PrivacyProtectionActions', db)
        });
      }
    }

    // 2. Cascade — handles ALL @PersonalData entities by annotation.
    // Dynamic import keeps this dependency lazy: the cascade module
    // only loads when an anonymization is actually triggered, and the
    // pattern matches the project's other ad-hoc-handler imports
    // (chat-orchestrator.js, content-store.js, etc.).
    const { executeAnonymizationCascade } = await import('./lib/anonymization-cascade.js');
    await executeAnonymizationCascade(user, db);

    // 3. DSR-only: close the action row.
    if (dsrRequestNumber) {
      await UPDATE(PrivacyProtectionActions)
        .where({ userUuid: user.uuid, actionType: 'ANONYMIZE', status: 'PROCESSING' })
        .set({ status: 'COMPLETED', completedAt: new Date().toISOString() });
    }

    // 4. Audit log (always — both action handlers want this).
    const audit = await cds.connect.to('audit-log');
    await audit.log('SecurityEvent', {
      data: { action: 'AnonymizeUser', sapId: user.sapId, dsrRequestNumber: dsrRequestNumber ?? null }
    });
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
