# IMS CAP Rewrite — Plan 2: AdminService + DisplayService

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Add AdminService (full CRUD + event statistics, CSV export, GDPR anonymization, cleanup actions) and DisplayService (read-only event dashboard with leaderboard) to the CAP project.

**Architecture:** AdminService exposes all entities as projections with Admin scope, plus custom actions/functions for statistics, export, and GDPR. DisplayService exposes read-only event data with DisplayApp scope. Shared event-statistics library provides computation logic to both services. Integration-dependent actions (NGDS, tutorial sync, notifications) are defined in CDS but stubbed—implemented in Plan 3.

**Tech Stack:** @sap/cds 9.x, vitest, cds.test()

**Spec:** `docs/superpowers/specs/2026-04-28-ims-cap-rewrite-design.md`

**Depends on:** Plan 1 (Foundation + DeveloperService) — complete on main

**Produces:** `cds watch` serves AdminService at `/admin` and DisplayService at `/display`. Integration tests pass for CRUD, statistics, export, anonymization, and display endpoints.

## Spec Refinements

This plan intentionally diverges from the design spec on certain parameter names and return shapes, informed by the Java source code analysis:

- **`eventLegacyId` (not `eventId`)**: All external references use legacy integer IDs. The spec's `eventId` was ambiguous between UUID and legacy ID. We consistently use `legacyId` pattern established in DeveloperService.
- **`sapId` (not `uuid`) for anonymization**: The Java app's GDPR endpoints use `accountNumber`/`sapId` for user lookup, not XSUAA UUID. This matches production behavior.
- **`getEventStatistics` returns `{ tutorials, groups, missions, uniqueUsers }`**: The Java source confirms task counts by type + unique user count. The spec's placeholder shape (`totalCompletions, uniqueLearners, completionRate, activeTutorials`) was a high-level approximation.
- **`findByAccountNumber(sapId)` parameter**: Java uses `accountNumber` which maps to `sapId` in our schema.

---

## File Structure

```
srv/
├── admin-service.cds              # AdminService CDS definition (projections + actions)
├── admin-service.js               # AdminService custom handlers
├── display-service.cds            # DisplayService CDS definition (read-only)
├── display-service.js             # DisplayService custom handlers
└── lib/
    ├── event-statistics.js        # Shared: event stats computation (burnup, tracks, speed)
    ├── export-helpers.js          # CSV/JSON export formatting
    ├── anonymization.js           # GDPR: user anonymization logic
    └── legacy-id.js               # (existing) Sequence helper
test/
├── admin-service.test.js          # Integration tests for AdminService
├── display-service.test.js        # Integration tests for DisplayService
└── lib/
    ├── event-statistics.test.js   # Unit tests for statistics computation
    ├── export-helpers.test.js     # Unit tests for export formatting
    └── anonymization.test.js      # Unit tests for anonymization logic
```

---

## Task 1: AdminService CDS Definition

**Files:**
- Create: `srv/admin-service.cds`

- [x] **Step 1: Create the AdminService CDS file**

```cds
using { com.sap.developers.ims as ims } from '../db/schema';
using from '../db/views';

@path: '/admin'
@requires: 'Admin'
service AdminService {

  // Full CRUD entity projections
  entity Users as projection on ims.Users;
  entity Tutorials as projection on ims.Tutorials;
  entity Missions as projection on ims.Missions;
  entity Groups as projection on ims.Groups;
  entity Steps as projection on ims.Steps;
  entity Events as projection on ims.Events;
  entity Prizes as projection on ims.Prizes;
  entity PrizeRecords as projection on ims.PrizeRecords;
  entity Tags as projection on ims.Tags;
  entity Accomplishments as projection on ims.Accomplishments;
  entity AccomplishmentRecords as projection on ims.AccomplishmentRecords;
  entity TaskRecords as projection on ims.TaskRecords;
  entity TutorialMeta as projection on ims.TutorialMeta;
  entity TutorialContributors as projection on ims.TutorialContributors;
  entity TutorialRepositories as projection on ims.TutorialRepositories;
  entity ImsConfig as projection on ims.ImsConfig;
  entity StepFailures as projection on ims.StepFailures;
  entity NGDSFailedMessages as projection on ims.NGDSFailedMessages;
  entity DeveloperEnvironmentTabs as projection on ims.DeveloperEnvironmentTabs;
  entity FeaturedTasks as projection on ims.FeaturedTasks;
  entity PrimaryAccounts as projection on ims.PrimaryAccounts;
  entity SecondaryAccounts as projection on ims.SecondaryAccounts;
  entity PrivacyProtectionActions as projection on ims.PrivacyProtectionActions;
  entity ActiveLearnerRecords as projection on ims.ActiveLearnerRecords;
  entity CompletionPaths as projection on ims.CompletionPaths;
  entity CompletionPathItems as projection on ims.CompletionPathItems;
  entity DashboardMonitoredRecords as projection on ims.DashboardMonitoredRecords;
  @readonly entity Tasks as projection on ims.Tasks;

  // --- Admin actions ---

  // GDPR / Privacy
  action anonymizeUser(sapId : String);
  action anonymizeByDsrRequest(sapId : String, dsrRequestNumber : String);

  // Maintenance
  action cleanupStepFailures(olderThanDays : Integer);
  action cleanupUnusedTags();
  action setFeaturedOrder(taskLegacyId : Integer, taskType : String, featuredOrder : Integer);

  // Integration-dependent (stubs in Plan 2, implemented in Plan 3)
  action sendToNgds(taskRecordLegacyId : Integer);
  action syncTutorialMetadata();
  action sendContributorNotifications();

  // --- Statistics & export functions ---

  function getEventStatistics(eventLegacyId : Integer) returns {
    tutorials  : Integer;
    groups     : Integer;
    missions   : Integer;
    uniqueUsers : Integer;
  };

  function getEventBurnup(eventLegacyId : Integer) returns many {
    day         : Date;
    count       : Integer;
    cumulative  : Integer;
  };

  function getEventTrackStats(eventLegacyId : Integer) returns many {
    missionLegacyId : Integer;
    title           : String;
    uniqueUsers     : Integer;
    completions     : Integer;
  };

  function getCompletionSpeed(eventLegacyId : Integer) returns many {
    taskLegacyId    : Integer;
    title           : String;
    avgMinutes      : Decimal;
    completions     : Integer;
  };

  function exportTaskRecords(eventLegacyId : Integer, format : String) returns LargeString;
  function exportAwardMissions(eventLegacyId : Integer) returns LargeString;

  function getAccountMergeStatus(uuid : String) returns {
    primaryUuid     : String;
    status          : String;
    mergedAt        : Timestamp;
    secondaryCount  : Integer;
  };

  function findByAccountNumber(sapId : String) returns many TaskRecords;
}
```

- [x] **Step 2: Verify CDS compiles**

Run: `npx cds compile srv/admin-service.cds --to json > /dev/null`
Expected: No errors. Exit code 0.

- [x] **Step 3: Verify service is served**

Run: `npx cds serve --project . --in-memory 2>&1 | head -20`
Expected: Output includes `[cds] - serving AdminService { at: '/admin' }`

- [x] **Step 4: Commit**

```bash
git add srv/admin-service.cds
git commit -m "feat: add AdminService CDS definition with entity projections and action signatures"
```

---

## Task 2: Event Statistics Library + Unit Tests

**Files:**
- Create: `srv/lib/event-statistics.js`
- Create: `test/lib/event-statistics.test.js`

This library provides pure computation functions that take arrays of records and produce statistics. Used by both AdminService and DisplayService handlers.

- [x] **Step 1: Write failing tests for getEventStatistics**

```js
// test/lib/event-statistics.test.js
import { describe, it, expect } from 'vitest';
import { computeEventStatistics, computeBurnup, computeTrackStats, computeCompletionSpeed, computeLeaderboard } from '../../srv/lib/event-statistics.js';

describe('event-statistics', () => {

  describe('computeEventStatistics', () => {
    it('counts completed tasks by type and unique users', () => {
      const records = [
        { taskType: 'TUTORIAL', status: 'COMPLETED', user_ID: 'u1' },
        { taskType: 'TUTORIAL', status: 'COMPLETED', user_ID: 'u2' },
        { taskType: 'MISSION', status: 'COMPLETED', user_ID: 'u1' },
        { taskType: 'GROUP', status: 'COMPLETED', user_ID: 'u1' },
        { taskType: 'TUTORIAL', status: 'IN_PROGRESS', user_ID: 'u3' },
      ];
      const result = computeEventStatistics(records);
      expect(result).toEqual({
        tutorials: 2,
        groups: 1,
        missions: 1,
        uniqueUsers: 2
      });
    });

    it('returns zeros for empty records', () => {
      expect(computeEventStatistics([])).toEqual({
        tutorials: 0, groups: 0, missions: 0, uniqueUsers: 0
      });
    });
  });

  describe('computeBurnup', () => {
    it('computes daily counts and cumulative totals', () => {
      const records = [
        { completionDate: '2026-03-01T10:00:00Z' },
        { completionDate: '2026-03-01T14:00:00Z' },
        { completionDate: '2026-03-02T09:00:00Z' },
        { completionDate: '2026-03-03T11:00:00Z' },
        { completionDate: '2026-03-03T15:00:00Z' },
        { completionDate: '2026-03-03T16:00:00Z' },
      ];
      const result = computeBurnup(records, '+00:00');
      expect(result).toEqual([
        { day: '2026-03-01', count: 2, cumulative: 2 },
        { day: '2026-03-02', count: 1, cumulative: 3 },
        { day: '2026-03-03', count: 3, cumulative: 6 },
      ]);
    });

    it('applies timezone offset to date grouping', () => {
      // This record is 2026-03-01 23:00 UTC, but in +05:00 it's 2026-03-02 04:00
      const records = [
        { completionDate: '2026-03-01T23:00:00Z' },
      ];
      const result = computeBurnup(records, '+05:00');
      expect(result).toEqual([
        { day: '2026-03-02', count: 1, cumulative: 1 },
      ]);
    });

    it('returns empty array for no records', () => {
      expect(computeBurnup([], '+00:00')).toEqual([]);
    });
  });

  describe('computeTrackStats', () => {
    it('aggregates completions per mission', () => {
      const records = [
        { taskLegacyId: 100, user_ID: 'u1', status: 'COMPLETED' },
        { taskLegacyId: 100, user_ID: 'u2', status: 'COMPLETED' },
        { taskLegacyId: 200, user_ID: 'u1', status: 'COMPLETED' },
      ];
      const missions = [
        { legacyId: 100, title: 'Mission A' },
        { legacyId: 200, title: 'Mission B' },
      ];
      const result = computeTrackStats(records, missions);
      expect(result).toEqual([
        { missionLegacyId: 100, title: 'Mission A', uniqueUsers: 2, completions: 2 },
        { missionLegacyId: 200, title: 'Mission B', uniqueUsers: 1, completions: 1 },
      ]);
    });
  });

  describe('computeCompletionSpeed', () => {
    it('calculates average completion time in minutes', () => {
      const records = [
        { taskLegacyId: 100, completionTime: 600 },  // 10 min
        { taskLegacyId: 100, completionTime: 1200 }, // 20 min
        { taskLegacyId: 200, completionTime: 300 },  // 5 min
      ];
      const tasks = [
        { legacyId: 100, title: 'Tutorial A' },
        { legacyId: 200, title: 'Tutorial B' },
      ];
      const result = computeCompletionSpeed(records, tasks);
      expect(result).toEqual([
        { taskLegacyId: 100, title: 'Tutorial A', avgMinutes: 15, completions: 2 },
        { taskLegacyId: 200, title: 'Tutorial B', avgMinutes: 5, completions: 1 },
      ]);
    });

    it('excludes records without completionTime', () => {
      const records = [
        { taskLegacyId: 100, completionTime: 600 },
        { taskLegacyId: 100, completionTime: null },
      ];
      const tasks = [{ legacyId: 100, title: 'Tutorial A' }];
      const result = computeCompletionSpeed(records, tasks);
      expect(result).toEqual([
        { taskLegacyId: 100, title: 'Tutorial A', avgMinutes: 10, completions: 1 },
      ]);
    });
  });

  describe('computeLeaderboard', () => {
    it('ranks users by completion count', () => {
      const records = [
        { user_ID: 'u1', status: 'COMPLETED' },
        { user_ID: 'u1', status: 'COMPLETED' },
        { user_ID: 'u1', status: 'COMPLETED' },
        { user_ID: 'u2', status: 'COMPLETED' },
        { user_ID: 'u2', status: 'COMPLETED' },
        { user_ID: 'u3', status: 'COMPLETED' },
      ];
      const users = [
        { ID: 'u1', legacyId: 1, displayName: 'Alice' },
        { ID: 'u2', legacyId: 2, displayName: 'Bob' },
        { ID: 'u3', legacyId: 3, displayName: 'Carol' },
      ];
      const result = computeLeaderboard(records, users, 2);
      expect(result).toEqual([
        { userLegacyId: 1, displayName: 'Alice', completions: 3, points: 30 },
        { userLegacyId: 2, displayName: 'Bob', completions: 2, points: 20 },
      ]);
    });
  });
});
```

- [x] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/lib/event-statistics.test.js`
Expected: FAIL — module not found

- [x] **Step 3: Implement the event-statistics library**

```js
// srv/lib/event-statistics.js

/**
 * Compute task completion counts by type and unique user count.
 * @param {Array} records - TaskRecords with taskType, status, user_ID
 * @returns {{ tutorials: number, groups: number, missions: number, uniqueUsers: number }}
 */
export function computeEventStatistics(records) {
  const completed = records.filter(r => r.status === 'COMPLETED');
  const users = new Set();
  let tutorials = 0, groups = 0, missions = 0;

  for (const r of completed) {
    users.add(r.user_ID);
    if (r.taskType === 'TUTORIAL') tutorials++;
    else if (r.taskType === 'GROUP') groups++;
    else if (r.taskType === 'MISSION') missions++;
  }

  return { tutorials, groups, missions, uniqueUsers: users.size };
}

/**
 * Compute daily completion burnup with cumulative totals.
 * @param {Array} records - Completed TaskRecords with completionDate
 * @param {string} tzOffset - Timezone offset string like "+05:00" or "-08:00"
 * @returns {Array<{ day: string, count: number, cumulative: number }>}
 */
export function computeBurnup(records, tzOffset) {
  if (records.length === 0) return [];

  const offsetMs = parseOffsetToMs(tzOffset);
  const dayCounts = new Map();

  for (const r of records) {
    if (!r.completionDate) continue;
    const adjusted = new Date(new Date(r.completionDate).getTime() + offsetMs);
    const day = adjusted.toISOString().slice(0, 10);
    dayCounts.set(day, (dayCounts.get(day) || 0) + 1);
  }

  const sorted = [...dayCounts.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  let cumulative = 0;
  return sorted.map(([day, count]) => {
    cumulative += count;
    return { day, count, cumulative };
  });
}

/**
 * Aggregate completions per mission (track stats).
 * @param {Array} records - TaskRecords with taskLegacyId, user_ID, status
 * @param {Array} missions - Mission entities with legacyId, title
 */
export function computeTrackStats(records, missions) {
  const completed = records.filter(r => r.status === 'COMPLETED');
  const missionMap = new Map(missions.map(m => [m.legacyId, m.title]));
  const stats = new Map();

  for (const r of completed) {
    if (!missionMap.has(r.taskLegacyId)) continue;
    if (!stats.has(r.taskLegacyId)) {
      stats.set(r.taskLegacyId, { users: new Set(), completions: 0 });
    }
    const s = stats.get(r.taskLegacyId);
    s.users.add(r.user_ID);
    s.completions++;
  }

  return missions
    .filter(m => stats.has(m.legacyId))
    .map(m => {
      const s = stats.get(m.legacyId);
      return {
        missionLegacyId: m.legacyId,
        title: m.title,
        uniqueUsers: s.users.size,
        completions: s.completions
      };
    });
}

/**
 * Calculate average completion time per task.
 * @param {Array} records - TaskRecords with taskLegacyId, completionTime (seconds)
 * @param {Array} tasks - Task entities with legacyId, title
 */
export function computeCompletionSpeed(records, tasks) {
  const taskMap = new Map(tasks.map(t => [t.legacyId, t.title]));
  const grouped = new Map();

  for (const r of records) {
    if (r.completionTime == null || !taskMap.has(r.taskLegacyId)) continue;
    if (!grouped.has(r.taskLegacyId)) grouped.set(r.taskLegacyId, []);
    grouped.get(r.taskLegacyId).push(r.completionTime);
  }

  return tasks
    .filter(t => grouped.has(t.legacyId))
    .map(t => {
      const times = grouped.get(t.legacyId);
      const avgSeconds = times.reduce((sum, v) => sum + v, 0) / times.length;
      return {
        taskLegacyId: t.legacyId,
        title: t.title,
        avgMinutes: Math.round(avgSeconds / 60),
        completions: times.length
      };
    });
}

/**
 * Compute leaderboard: top N users by completion count.
 * @param {Array} records - TaskRecords with user_ID, status
 * @param {Array} users - User entities with ID, legacyId, displayName
 * @param {number} top - Number of users to return
 */
export function computeLeaderboard(records, users, top) {
  const completed = records.filter(r => r.status === 'COMPLETED');
  const counts = new Map();

  for (const r of completed) {
    counts.set(r.user_ID, (counts.get(r.user_ID) || 0) + 1);
  }

  const userMap = new Map(users.map(u => [u.ID, u]));
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, top)
    .map(([userId, completions]) => {
      const user = userMap.get(userId);
      return {
        userLegacyId: user?.legacyId || 0,
        displayName: user?.displayName || '',
        completions,
        points: completions * 10
      };
    });
}

function parseOffsetToMs(offset) {
  if (!offset) return 0;
  const match = offset.match(/^([+-])(\d{2}):(\d{2})$/);
  if (!match) return 0;
  const sign = match[1] === '+' ? 1 : -1;
  return sign * (parseInt(match[2]) * 3600000 + parseInt(match[3]) * 60000);
}
```

- [x] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/lib/event-statistics.test.js`
Expected: All 9 tests PASS

- [x] **Step 5: Commit**

```bash
git add srv/lib/event-statistics.js test/lib/event-statistics.test.js
git commit -m "feat: add event statistics computation library with unit tests"
```

---

## Task 3: Export Helpers Library + Unit Tests

**Files:**
- Create: `srv/lib/export-helpers.js`
- Create: `test/lib/export-helpers.test.js`

Provides CSV and JSON formatting for task record export. The Java app exports CSV with columns: DATE & TIME, TYPE, TITLE, TIME SPENT.

- [x] **Step 1: Write failing tests**

```js
// test/lib/export-helpers.test.js
import { describe, it, expect } from 'vitest';
import { formatTaskRecordsCSV, formatAwardMissionsCSV, formatTimeSpent } from '../../srv/lib/export-helpers.js';

describe('export-helpers', () => {

  describe('formatTimeSpent', () => {
    it('formats seconds to human-readable', () => {
      expect(formatTimeSpent(3600)).toBe('1 hr');
      expect(formatTimeSpent(5400)).toBe('1 hr, 30 min');
      expect(formatTimeSpent(7200)).toBe('2 hrs');
      expect(formatTimeSpent(900)).toBe('15 min');
      expect(formatTimeSpent(0)).toBe('0 min');
      expect(formatTimeSpent(null)).toBe('');
    });
  });

  describe('formatTaskRecordsCSV', () => {
    it('produces CSV with header and rows', () => {
      const records = [
        {
          completionDate: '2026-03-15T10:30:00Z',
          taskType: 'TUTORIAL',
          titleSnapshot: 'Setup BTP Account',
          completionTime: 5400
        },
        {
          completionDate: '2026-03-16T14:00:00Z',
          taskType: 'MISSION',
          titleSnapshot: 'Get Started Mission',
          completionTime: null
        }
      ];
      const csv = formatTaskRecordsCSV(records);
      const lines = csv.split('\n');
      expect(lines[0]).toBe('DATE & TIME,TYPE,TITLE,TIME SPENT');
      expect(lines[1]).toContain('TUTORIAL');
      expect(lines[1]).toContain('Setup BTP Account');
      expect(lines[1]).toContain('1 hr, 30 min');
      expect(lines[2]).toContain('MISSION');
      expect(lines[2]).toContain('Get Started Mission');
    });

    it('returns header only for empty records', () => {
      const csv = formatTaskRecordsCSV([]);
      expect(csv).toBe('DATE & TIME,TYPE,TITLE,TIME SPENT');
    });
  });

  describe('formatAwardMissionsCSV', () => {
    it('produces CSV for mission awards', () => {
      const awards = [
        { userDisplayName: 'Alice', missionTitle: 'BTP Basics', completionDate: '2026-03-15T10:30:00Z' },
        { userDisplayName: 'Bob', missionTitle: 'CAP Deep Dive', completionDate: '2026-03-16T14:00:00Z' },
      ];
      const csv = formatAwardMissionsCSV(awards);
      const lines = csv.split('\n');
      expect(lines[0]).toBe('USER,MISSION,COMPLETED AT');
      expect(lines[1]).toContain('Alice');
      expect(lines[1]).toContain('BTP Basics');
    });
  });
});
```

- [x] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/lib/export-helpers.test.js`
Expected: FAIL — module not found

- [x] **Step 3: Implement export helpers**

```js
// srv/lib/export-helpers.js

export function formatTimeSpent(seconds) {
  if (seconds == null) return '';
  if (seconds === 0) return '0 min';
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.round((seconds % 3600) / 60);
  const parts = [];
  if (hours === 1) parts.push('1 hr');
  else if (hours > 1) parts.push(`${hours} hrs`);
  if (minutes > 0) parts.push(`${minutes} min`);
  return parts.join(', ');
}

export function formatTaskRecordsCSV(records) {
  const header = 'DATE & TIME,TYPE,TITLE,TIME SPENT';
  if (records.length === 0) return header;

  const rows = records.map(r => {
    const date = r.completionDate ? formatDate(r.completionDate) : '';
    const type = r.taskType || '';
    const title = escapeCSV(r.titleSnapshot || '');
    const time = formatTimeSpent(r.completionTime);
    return `${date},${type},${title},${time}`;
  });

  return [header, ...rows].join('\n');
}

export function formatAwardMissionsCSV(awards) {
  const header = 'USER,MISSION,COMPLETED AT';
  if (awards.length === 0) return header;

  const rows = awards.map(a => {
    const date = a.completionDate ? formatDate(a.completionDate) : '';
    return `${escapeCSV(a.userDisplayName || '')},${escapeCSV(a.missionTitle || '')},${date}`;
  });

  return [header, ...rows].join('\n');
}

function formatDate(isoString) {
  const d = new Date(isoString);
  const day = d.getUTCDate().toString().padStart(2, '0');
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const month = months[d.getUTCMonth()];
  const year = d.getUTCFullYear();
  const time = d.toISOString().slice(11, 19);
  return `${day} ${month} ${year} ${time}`;
}

function escapeCSV(value) {
  if (value.includes(',') || value.includes('"') || value.includes('\n')) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}
```

- [x] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/lib/export-helpers.test.js`
Expected: All 5 tests PASS

- [x] **Step 5: Commit**

```bash
git add srv/lib/export-helpers.js test/lib/export-helpers.test.js
git commit -m "feat: add CSV export helpers with unit tests"
```

---

## Task 4: GDPR Anonymization Library + Unit Tests

**Files:**
- Create: `srv/lib/anonymization.js`
- Create: `test/lib/anonymization.test.js`

Implements user anonymization logic per GDPR requirements. The Java app: (1) nulls User.sapId, (2) deletes UserMetaData, (3) blanks audit fields (createdBy/modifiedBy on all related records). In CAP, `managed` aspect auto-populates createdBy/modifiedBy — we null those on anonymization.

- [x] **Step 1: Write failing tests**

```js
// test/lib/anonymization.test.js
import { describe, it, expect, vi } from 'vitest';
import { buildAnonymizationOps } from '../../srv/lib/anonymization.js';

describe('anonymization', () => {

  describe('buildAnonymizationOps', () => {
    it('produces operations to anonymize a user', () => {
      const user = {
        ID: 'u1',
        sapId: 'S1234567',
        firstName: 'John',
        lastName: 'Doe',
        email: 'john@example.com',
        displayName: 'John Doe',
        avatarUrl: 'https://example.com/avatar.jpg'
      };

      const ops = buildAnonymizationOps(user);

      expect(ops.userUpdate).toEqual({
        ID: 'u1',
        sapId: null,
        firstName: 'ANONYMIZED',
        lastName: 'ANONYMIZED',
        email: null,
        displayName: 'ANONYMIZED',
        avatarUrl: null
      });
      expect(ops.deleteMetadata).toBe(true);
      expect(ops.auditFieldsValue).toBe('ANONYMIZED');
    });

    it('handles already-anonymized user gracefully', () => {
      const user = {
        ID: 'u1',
        sapId: null,
        firstName: 'ANONYMIZED',
        lastName: 'ANONYMIZED',
        email: null,
        displayName: 'ANONYMIZED',
        avatarUrl: null
      };

      const ops = buildAnonymizationOps(user);
      expect(ops.userUpdate.sapId).toBeNull();
      expect(ops.userUpdate.firstName).toBe('ANONYMIZED');
    });
  });
});
```

- [x] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/lib/anonymization.test.js`
Expected: FAIL — module not found

- [x] **Step 3: Implement anonymization library**

```js
// srv/lib/anonymization.js

const ANON_VALUE = 'ANONYMIZED';

/**
 * Build the set of operations needed to anonymize a user.
 * Returns an operations descriptor — the caller (service handler) executes them.
 */
export function buildAnonymizationOps(user) {
  return {
    userUpdate: {
      ID: user.ID,
      sapId: null,
      firstName: ANON_VALUE,
      lastName: ANON_VALUE,
      email: null,
      displayName: ANON_VALUE,
      avatarUrl: null
    },
    deleteMetadata: true,
    auditFieldsValue: ANON_VALUE
  };
}
```

- [x] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/lib/anonymization.test.js`
Expected: All 2 tests PASS

- [x] **Step 5: Commit**

```bash
git add srv/lib/anonymization.js test/lib/anonymization.test.js
git commit -m "feat: add GDPR anonymization operations builder with unit tests"
```

---

## Task 5: AdminService Custom Handler

**Files:**
- Create: `srv/admin-service.js`

Wires the statistics, export, and anonymization libraries into the AdminService. Implements inline: cleanup actions, featured ordering, account merge status, DSR lookup. Stubs integration-dependent actions.

- [x] **Step 1: Create the AdminService handler**

```js
// srv/admin-service.js
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
    });

    this.on('anonymizeByDsrRequest', async (req) => {
      const { sapId, dsrRequestNumber } = req.data;
      const user = await SELECT.one.from(Users).where({ sapId });
      if (!user) return req.reject(404, `User not found with sapId: ${sapId}`);

      // Record the DSR action
      await INSERT.into(PrivacyProtectionActions).entries({
        userUuid: user.uuid,
        actionType: 'ANONYMIZE',
        requestedAt: new Date().toISOString(),
        status: 'PROCESSING',
        legacyId: await getNextLegacyId('PrivacyProtectionActions', db)
      });

      await this._executeAnonymization(user);

      // Mark action complete
      await UPDATE(PrivacyProtectionActions)
        .where({ userUuid: user.uuid, actionType: 'ANONYMIZE', status: 'PROCESSING' })
        .set({ status: 'COMPLETED', completedAt: new Date().toISOString() });
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

      // Record the DSR search action
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

    // --- Integration stubs (Plan 3) ---

    this.on('sendToNgds', async (req) => {
      return req.reject(501, 'sendToNgds: Not yet implemented (Plan 3 - Integrations)');
    });

    this.on('syncTutorialMetadata', async (req) => {
      return req.reject(501, 'syncTutorialMetadata: Not yet implemented (Plan 3 - Integrations)');
    });

    this.on('sendContributorNotifications', async (req) => {
      return req.reject(501, 'sendContributorNotifications: Not yet implemented (Plan 3 - Integrations)');
    });

    await super.init();
  }

  async _executeAnonymization(user) {
    const { Users, UserMetaData, TaskRecords } = cds.entities('com.sap.developers.ims');
    const ops = buildAnonymizationOps(user);

    // 1. Update user record
    await UPDATE(Users, user.ID).set(ops.userUpdate);

    // 2. Delete metadata
    if (ops.deleteMetadata) {
      await DELETE.from(UserMetaData).where({ user_ID: user.ID });
    }

    // 3. Blank audit fields on related task records
    await UPDATE(TaskRecords)
      .where({ user_ID: user.ID })
      .set({ createdBy: ops.auditFieldsValue, modifiedBy: ops.auditFieldsValue });
  }
}
```

- [x] **Step 2: Verify CDS and handler load without errors**

Run: `npx cds serve --project . --in-memory 2>&1 | head -20`
Expected: Output includes both `[cds] - serving AdminService { at: '/admin' }` and `[cds] - serving DeveloperService { at: '/api' }`

- [x] **Step 3: Commit**

```bash
git add srv/admin-service.js
git commit -m "feat: implement AdminService handlers for statistics, export, GDPR, and cleanup"
```

---

## Task 6: AdminService Integration Tests

**Files:**
- Create: `test/admin-service.test.js`

Tests AdminService endpoints via `cds.test()` with mocked auth (admin user from `.cdsrc.json`).

- [x] **Step 1: Write integration tests**

```js
// test/admin-service.test.js
import { describe, it, expect, beforeAll } from 'vitest';
import cds from '@sap/cds';

const project = cds.test('serve', '--project', '.', '--in-memory');

const adminAuth = { auth: { username: 'admin', password: 'admin' } };
const devAuth = { auth: { username: 'developer', password: 'developer' } };

describe('AdminService', () => {

  describe('Authorization', () => {
    it('rejects non-admin users', async () => {
      const { status } = await project.get('/admin/Users', {
        ...devAuth, validateStatus: () => true
      });
      expect(status).toBe(403);
    });

    it('allows admin users', async () => {
      const { status } = await project.get('/admin/Users', adminAuth);
      expect(status).toBe(200);
    });
  });

  describe('CRUD Operations', () => {
    it('creates and reads an event', async () => {
      const event = {
        name: 'TechEd 2026',
        startDate: '2026-10-01T08:00:00Z',
        endDate: '2026-10-03T18:00:00Z',
        timeZone: '+02:00'
      };
      const { status, data } = await project.post('/admin/Events', event, adminAuth);
      expect(status).toBe(201);
      expect(data.name).toBe('TechEd 2026');
      expect(data.ID).toBeDefined();

      const { data: fetched } = await project.get(`/admin/Events(${data.ID})`, adminAuth);
      expect(fetched.name).toBe('TechEd 2026');
    });

    it('lists tutorials', async () => {
      const { status, data } = await project.get('/admin/Tutorials', adminAuth);
      expect(status).toBe(200);
      expect(data.value).toBeDefined();
    });

    it('reads the Tasks union view', async () => {
      const { status, data } = await project.get('/admin/Tasks', adminAuth);
      expect(status).toBe(200);
      expect(data.value).toBeDefined();
    });
  });

  describe('Event Statistics', () => {
    let eventLegacyId;

    beforeAll(async () => {
      const { Events, Users, TaskRecords } = cds.entities('com.sap.developers.ims');

      await INSERT.into(Events).entries({
        ID: 'eeeeeeee-0000-0000-0000-000000000001',
        name: 'Stats Test Event',
        startDate: '2026-03-01T00:00:00Z',
        endDate: '2026-03-05T23:59:59Z',
        timeZone: '+00:00',
        legacyId: 9001
      });
      eventLegacyId = 9001;

      await INSERT.into(Users).entries([
        { ID: 'dddddddd-0000-0000-0000-000000000001', uuid: 'stats-u1', legacyId: 6001, displayName: 'Alice' },
        { ID: 'dddddddd-0000-0000-0000-000000000002', uuid: 'stats-u2', legacyId: 6002, displayName: 'Bob' },
      ]);

      await INSERT.into(TaskRecords).entries([
        { user_ID: 'dddddddd-0000-0000-0000-000000000001', taskLegacyId: 100, taskType: 'TUTORIAL', status: 'COMPLETED', event_ID: 'eeeeeeee-0000-0000-0000-000000000001', completionDate: '2026-03-01T10:00:00Z', completionTime: 600, titleSnapshot: 'Tutorial A', legacyId: 7001 },
        { user_ID: 'dddddddd-0000-0000-0000-000000000001', taskLegacyId: 200, taskType: 'MISSION', status: 'COMPLETED', event_ID: 'eeeeeeee-0000-0000-0000-000000000001', completionDate: '2026-03-02T14:00:00Z', completionTime: 1200, titleSnapshot: 'Mission A', legacyId: 7002 },
        { user_ID: 'dddddddd-0000-0000-0000-000000000002', taskLegacyId: 100, taskType: 'TUTORIAL', status: 'COMPLETED', event_ID: 'eeeeeeee-0000-0000-0000-000000000001', completionDate: '2026-03-01T15:00:00Z', completionTime: 900, titleSnapshot: 'Tutorial A', legacyId: 7003 },
      ]);
    });

    it('getEventStatistics returns counts', async () => {
      const { data } = await project.get(
        `/admin/getEventStatistics(eventLegacyId=${eventLegacyId})`, adminAuth
      );
      expect(data.tutorials).toBe(2);
      expect(data.missions).toBe(1);
      expect(data.uniqueUsers).toBe(2);
    });

    it('getEventBurnup returns daily burnup', async () => {
      const { data } = await project.get(
        `/admin/getEventBurnup(eventLegacyId=${eventLegacyId})`, adminAuth
      );
      expect(data.value.length).toBeGreaterThan(0);
      expect(data.value[0]).toHaveProperty('day');
      expect(data.value[0]).toHaveProperty('cumulative');
    });

    it('exportTaskRecords returns CSV', async () => {
      const { data } = await project.get(
        `/admin/exportTaskRecords(eventLegacyId=${eventLegacyId},format='csv')`, adminAuth
      );
      expect(data.value).toContain('DATE & TIME,TYPE,TITLE,TIME SPENT');
      expect(data.value).toContain('TUTORIAL');
    });
  });

  describe('GDPR Anonymization', () => {
    beforeAll(async () => {
      const { Users, UserMetaData } = cds.entities('com.sap.developers.ims');
      await INSERT.into(Users).entries({
        ID: 'ffffffff-0000-0000-0000-000000000001',
        uuid: 'gdpr-test-user',
        sapId: 'S9999999',
        firstName: 'Jane',
        lastName: 'Smith',
        email: 'jane@example.com',
        displayName: 'Jane Smith',
        legacyId: 8001
      });
      await INSERT.into(UserMetaData).entries([
        { user_ID: 'ffffffff-0000-0000-0000-000000000001', 'key': 'pref1', value: 'val1', legacyId: 8101 },
        { user_ID: 'ffffffff-0000-0000-0000-000000000001', 'key': 'pref2', value: 'val2', legacyId: 8102 },
      ]);
    });

    it('anonymizeUser blanks PII and deletes metadata', async () => {
      const { status } = await project.post('/admin/anonymizeUser',
        { sapId: 'S9999999' }, adminAuth);
      expect(status).toBe(204);

      // Verify user is anonymized
      const { Users, UserMetaData } = cds.entities('com.sap.developers.ims');
      const user = await SELECT.one.from(Users, 'ffffffff-0000-0000-0000-000000000001');
      expect(user.sapId).toBeNull();
      expect(user.firstName).toBe('ANONYMIZED');
      expect(user.email).toBeNull();

      // Verify metadata deleted
      const meta = await SELECT.from(UserMetaData).where({ user_ID: user.ID });
      expect(meta.length).toBe(0);
    });
  });

  describe('Cleanup Actions', () => {
    beforeAll(async () => {
      const { StepFailures } = cds.entities('com.sap.developers.ims');
      const old = new Date(Date.now() - 100 * 86400000).toISOString();
      const recent = new Date().toISOString();
      await INSERT.into(StepFailures).entries([
        { failureDate: old, stepNumber: 1, errorMessage: 'old failure', legacyId: 9901 },
        { failureDate: recent, stepNumber: 2, errorMessage: 'recent failure', legacyId: 9902 },
      ]);
    });

    it('cleanupStepFailures removes old records', async () => {
      const { status } = await project.post('/admin/cleanupStepFailures',
        { olderThanDays: 90 }, adminAuth);
      expect(status).toBe(204);

      const { StepFailures } = cds.entities('com.sap.developers.ims');
      const remaining = await SELECT.from(StepFailures);
      expect(remaining.length).toBe(1);
      expect(remaining[0].errorMessage).toBe('recent failure');
    });
  });

  describe('Featured Tasks', () => {
    it('setFeaturedOrder creates new featured entry', async () => {
      const { status } = await project.post('/admin/setFeaturedOrder',
        { taskLegacyId: 100, taskType: 'TUTORIAL', featuredOrder: 1 }, adminAuth);
      expect(status).toBe(204);

      const { FeaturedTasks } = cds.entities('com.sap.developers.ims');
      const feat = await SELECT.one.from(FeaturedTasks).where({ taskLegacyId: 100 });
      expect(feat.featuredOrder).toBe(1);
    });

    it('setFeaturedOrder updates existing entry', async () => {
      await project.post('/admin/setFeaturedOrder',
        { taskLegacyId: 100, taskType: 'TUTORIAL', featuredOrder: 5 }, adminAuth);

      const { FeaturedTasks } = cds.entities('com.sap.developers.ims');
      const feat = await SELECT.one.from(FeaturedTasks).where({ taskLegacyId: 100 });
      expect(feat.featuredOrder).toBe(5);
    });
  });

  describe('Integration Stubs', () => {
    it('sendToNgds returns 501', async () => {
      const { status } = await project.post('/admin/sendToNgds',
        { taskRecordLegacyId: 1 },
        { ...adminAuth, validateStatus: () => true });
      expect(status).toBe(501);
    });
  });
});
```

- [x] **Step 2: Run tests**

Run: `npx vitest run test/admin-service.test.js`
Expected: All tests PASS

- [x] **Step 3: Fix any failures and re-run**

If tests fail due to CDS compilation or handler issues, fix the handler code and re-run.

- [x] **Step 4: Commit**

```bash
git add test/admin-service.test.js
git commit -m "test: add AdminService integration tests for CRUD, stats, GDPR, and cleanup"
```

---

## Task 7: DisplayService CDS Definition

**Files:**
- Create: `srv/display-service.cds`

Read-only service for the event display dashboard. Uses `DisplayApp` scope.

- [x] **Step 1: Create the DisplayService CDS file**

```cds
using { com.sap.developers.ims as ims } from '../db/schema';

@path: '/display'
@requires: 'DisplayApp'
service DisplayService {

  @readonly entity Events as projection on ims.Events;
  @readonly entity DashboardMonitoredRecords as projection on ims.DashboardMonitoredRecords;

  function getEventBuckets(eventLegacyId : Integer) returns many {
    bucketName  : String;
    count       : Integer;
    percentage  : Decimal;
  };

  function getEventBurnup(eventLegacyId : Integer) returns many {
    day         : Date;
    count       : Integer;
    cumulative  : Integer;
  };

  function getEventTrackStats(eventLegacyId : Integer) returns many {
    missionLegacyId : Integer;
    title           : String;
    uniqueUsers     : Integer;
    completions     : Integer;
  };

  function getCompletionSpeed(eventLegacyId : Integer) returns many {
    taskLegacyId    : Integer;
    title           : String;
    avgMinutes      : Decimal;
    completions     : Integer;
  };

  function getLeaderboard(eventLegacyId : Integer, top : Integer) returns many {
    userLegacyId : Integer;
    displayName  : String;
    completions  : Integer;
    points       : Integer;
  };
}
```

- [x] **Step 2: Verify CDS compiles**

Run: `npx cds compile srv/display-service.cds --to json > /dev/null`
Expected: Exit code 0

- [x] **Step 3: Commit**

```bash
git add srv/display-service.cds
git commit -m "feat: add DisplayService CDS definition with read-only event dashboard endpoints"
```

---

## Task 8: DisplayService Custom Handler + Integration Tests

**Files:**
- Create: `srv/display-service.js`
- Create: `test/display-service.test.js`

Reuses the event-statistics library. Adds `getEventBuckets` (distribution of users by completion count) and `getLeaderboard`.

- [x] **Step 1: Create the DisplayService handler**

```js
// srv/display-service.js
import cds from '@sap/cds';
import { computeBurnup, computeTrackStats, computeCompletionSpeed, computeLeaderboard } from './lib/event-statistics.js';

export default class DisplayService extends cds.ApplicationService {

  async init() {
    const { Events, Missions, Tutorials, Users, TaskRecords } = cds.entities('com.sap.developers.ims');

    this.on('getEventBuckets', async (req) => {
      const { eventLegacyId } = req.data;
      const event = await SELECT.one.from(Events).where({ legacyId: eventLegacyId });
      if (!event) return req.reject(404, `Event not found: ${eventLegacyId}`);

      const records = await SELECT.from(TaskRecords).where({
        event_ID: event.ID,
        taskType: 'TUTORIAL',
        status: 'COMPLETED'
      });

      // Bucket users by number of completions
      const userCounts = new Map();
      for (const r of records) {
        userCounts.set(r.user_ID, (userCounts.get(r.user_ID) || 0) + 1);
      }

      const buckets = new Map();
      for (const count of userCounts.values()) {
        const name = `${count} tutorial${count > 1 ? 's' : ''}`;
        buckets.set(name, (buckets.get(name) || 0) + 1);
      }

      const totalUsers = userCounts.size;
      return [...buckets.entries()]
        .sort((a, b) => parseInt(a[0]) - parseInt(b[0]))
        .map(([bucketName, count]) => ({
          bucketName,
          count,
          percentage: totalUsers > 0 ? Math.round((count / totalUsers) * 10000) / 100 : 0
        }));
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

    this.on('getLeaderboard', async (req) => {
      const { eventLegacyId, top } = req.data;
      const event = await SELECT.one.from(Events).where({ legacyId: eventLegacyId });
      if (!event) return req.reject(404, `Event not found: ${eventLegacyId}`);

      const records = await SELECT.from(TaskRecords).where({
        event_ID: event.ID,
        status: 'COMPLETED'
      });

      const userIds = [...new Set(records.map(r => r.user_ID))];
      const users = userIds.length > 0
        ? await SELECT.from(Users).where({ ID: { in: userIds } })
        : [];

      return computeLeaderboard(records, users, top || 10);
    });

    await super.init();
  }
}
```

- [x] **Step 2: Write integration tests**

```js
// test/display-service.test.js
import { describe, it, expect, beforeAll } from 'vitest';
import cds from '@sap/cds';

const project = cds.test('serve', '--project', '.', '--in-memory');

const displayAuth = { auth: { username: 'display', password: 'display' } };
const devAuth = { auth: { username: 'developer', password: 'developer' } };

describe('DisplayService', () => {

  describe('Authorization', () => {
    it('rejects users without DisplayApp role', async () => {
      const { status } = await project.get('/display/Events', {
        ...devAuth, validateStatus: () => true
      });
      expect(status).toBe(403);
    });

    it('allows display users', async () => {
      const { status } = await project.get('/display/Events', displayAuth);
      expect(status).toBe(200);
    });
  });

  describe('Event Data', () => {
    beforeAll(async () => {
      const { Events, Users, Tutorials, Missions, TaskRecords } = cds.entities('com.sap.developers.ims');

      await INSERT.into(Events).entries({
        ID: 'aaaaaaaa-1111-0000-0000-000000000001',
        name: 'Display Test Event',
        startDate: '2026-06-01T00:00:00Z',
        endDate: '2026-06-03T23:59:59Z',
        timeZone: '+00:00',
        legacyId: 5001
      });

      await INSERT.into(Users).entries([
        { ID: 'aaaaaaaa-1111-0000-0000-000000000011', uuid: 'disp-u1', legacyId: 5011, displayName: 'Player1' },
        { ID: 'aaaaaaaa-1111-0000-0000-000000000012', uuid: 'disp-u2', legacyId: 5012, displayName: 'Player2' },
        { ID: 'aaaaaaaa-1111-0000-0000-000000000013', uuid: 'disp-u3', legacyId: 5013, displayName: 'Player3' },
      ]);

      await INSERT.into(Tutorials).entries([
        { ID: 'aaaaaaaa-1111-0000-0000-000000000021', title: 'Tut 1', slug: 'disp-tut-1', legacyId: 5021 },
      ]);

      await INSERT.into(Missions).entries([
        { ID: 'aaaaaaaa-1111-0000-0000-000000000031', title: 'Mission Alpha', legacyId: 5031 },
      ]);

      await INSERT.into(TaskRecords).entries([
        { user_ID: 'aaaaaaaa-1111-0000-0000-000000000011', taskLegacyId: 5021, taskType: 'TUTORIAL', status: 'COMPLETED', event_ID: 'aaaaaaaa-1111-0000-0000-000000000001', completionDate: '2026-06-01T10:00:00Z', completionTime: 600, legacyId: 5101 },
        { user_ID: 'aaaaaaaa-1111-0000-0000-000000000011', taskLegacyId: 5031, taskType: 'MISSION', status: 'COMPLETED', event_ID: 'aaaaaaaa-1111-0000-0000-000000000001', completionDate: '2026-06-01T12:00:00Z', completionTime: 1800, legacyId: 5102 },
        { user_ID: 'aaaaaaaa-1111-0000-0000-000000000012', taskLegacyId: 5021, taskType: 'TUTORIAL', status: 'COMPLETED', event_ID: 'aaaaaaaa-1111-0000-0000-000000000001', completionDate: '2026-06-01T14:00:00Z', completionTime: 900, legacyId: 5103 },
        { user_ID: 'aaaaaaaa-1111-0000-0000-000000000013', taskLegacyId: 5021, taskType: 'TUTORIAL', status: 'COMPLETED', event_ID: 'aaaaaaaa-1111-0000-0000-000000000001', completionDate: '2026-06-02T09:00:00Z', completionTime: 450, legacyId: 5104 },
      ]);
    });

    it('getEventBurnup returns daily tutorial completions', async () => {
      const { status, data } = await project.get(
        '/display/getEventBurnup(eventLegacyId=5001)', displayAuth
      );
      expect(status).toBe(200);
      expect(data.value.length).toBe(2); // 2 days with completions
      expect(data.value[0].day).toBe('2026-06-01');
      expect(data.value[0].count).toBe(2);
      expect(data.value[0].cumulative).toBe(2);
      expect(data.value[1].cumulative).toBe(3);
    });

    it('getEventBuckets returns user distribution', async () => {
      const { status, data } = await project.get(
        '/display/getEventBuckets(eventLegacyId=5001)', displayAuth
      );
      expect(status).toBe(200);
      expect(data.value.length).toBeGreaterThan(0);
      // Player1 has 1 tutorial, Player2 has 1, Player3 has 1
      expect(data.value[0].bucketName).toBe('1 tutorial');
      expect(data.value[0].count).toBe(3);
    });

    it('getLeaderboard returns top users', async () => {
      const { status, data } = await project.get(
        '/display/getLeaderboard(eventLegacyId=5001,top=2)', displayAuth
      );
      expect(status).toBe(200);
      // Player1 has 2 completions (1 tutorial + 1 mission), others have 1
      expect(data.value[0].displayName).toBe('Player1');
      expect(data.value[0].completions).toBe(2);
      expect(data.value.length).toBe(2);
    });

    it('getEventTrackStats returns mission completion stats', async () => {
      const { status, data } = await project.get(
        '/display/getEventTrackStats(eventLegacyId=5001)', displayAuth
      );
      expect(status).toBe(200);
      expect(data.value[0].title).toBe('Mission Alpha');
      expect(data.value[0].completions).toBe(1);
    });

    it('getCompletionSpeed returns average times', async () => {
      const { status, data } = await project.get(
        '/display/getCompletionSpeed(eventLegacyId=5001)', displayAuth
      );
      expect(status).toBe(200);
      expect(data.value[0].title).toBe('Tut 1');
      expect(data.value[0].completions).toBe(3);
      // avg of 600, 900, 450 seconds = 650 seconds ≈ 11 minutes
      expect(data.value[0].avgMinutes).toBe(11);
    });

    it('returns 404 for unknown event', async () => {
      const { status } = await project.get(
        '/display/getEventBurnup(eventLegacyId=99999)',
        { ...displayAuth, validateStatus: () => true }
      );
      expect(status).toBe(404);
    });
  });
});
```

- [x] **Step 3: Run all tests**

Run: `npx vitest run test/display-service.test.js`
Expected: All tests PASS

- [x] **Step 4: Run the full test suite**

Run: `npx vitest run test/`
Expected: All test files pass (developer-service, admin-service, display-service, unit tests)

- [x] **Step 5: Commit**

```bash
git add srv/display-service.js test/display-service.test.js
git commit -m "feat: implement DisplayService with event dashboard endpoints and integration tests"
```

---

## Task 9: Verify All Services Serve Together + Final Cleanup

**Files:**
- Possibly modify: `srv/admin-service.js`, `srv/admin-service.cds`, `srv/display-service.js` (fix any issues found)

- [x] **Step 1: Start all services and verify**

Run: `npx cds serve --project . --in-memory 2>&1 | head -30`
Expected output includes all three services:
```
[cds] - serving AdminService { at: '/admin' }
[cds] - serving DeveloperService { at: '/api' }
[cds] - serving DisplayService { at: '/display' }
```

- [x] **Step 2: Run the complete test suite**

Run: `npx vitest run`
Expected: All tests pass across all test files.

- [x] **Step 3: Verify CDS builds for production**

Run: `npx cds build --production 2>&1 | tail -10`
Expected: Build completes without errors. `gen/srv/` and `gen/db/` are produced.

- [x] **Step 4: Commit any fixes**

If fixes were needed, commit them:
```bash
git add -u
git commit -m "fix: resolve integration issues from full service verification"
```

---

## Notes for Plan 3

The following AdminService actions are **stubbed with 501** and will be implemented in Plan 3 (Integrations + Jobs):

- `sendToNgds` — Requires NGDS destination client + BTP Destination service binding
- `syncTutorialMetadata` — Requires GitHub API integration or reading from build pipeline output
- `sendContributorNotifications` — Requires email/notification integration

Plan 3 will also add:
- `srv/jobs/scheduler.js` — Cron-based job scheduling
- `srv/jobs/job-lock.js` — Distributed lock via JobLocks entity
- `srv/lib/ngds-client.js` — NGDS integration client
- Scheduled execution of `cleanupStepFailures`, `cleanupUnusedTags`, etc.
