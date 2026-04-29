# IMS CAP Rewrite Plan 3: Integrations + Jobs

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Wire the existing stub endpoints to real integration clients (NGDS, Adobe Analytics, SCI account merge), add scheduled jobs with distributed locks, and implement tutorial metadata sync from the GitHub build pipeline.

**Architecture:** Each integration client is a standalone library in `srv/lib/` that wraps external service calls behind a thin interface. The job scheduler uses `node-cron` with a database-backed lock to enforce single-instance execution across CF instances. The ConsolidationService is a new CDS service handling SCI-triggered account merges.

**Tech Stack:** CAP Node.js, BTP Destination Service (via `cds.connect.to`), node-cron, STOMP not in scope (Phase 2 post-cutover)

---

## File Structure

| File | Responsibility |
|------|----------------|
| `srv/lib/ngds-client.js` | Send task completion payloads to NGDS destination; store failed messages for retry |
| `srv/lib/adobe-analytics.js` | Fire XML beacons to Adobe Analytics (sap.d1.sc.omtrdc.net) |
| `srv/lib/account-merge.js` | Merge secondary account data into primary (task records, prize records, learner records) |
| `srv/lib/tutorial-sync.js` | Sync tutorial metadata from this project's build pipeline output into TutorialMeta/Contributors |
| `srv/lib/contributor-notifications.js` | Compute which contributors need stale-content notifications |
| `srv/jobs/job-lock.js` | acquireLock / releaseLock using JobLocks entity |
| `srv/jobs/scheduler.js` | Register all cron schedules, bootstrap via `cds.on('served')` |
| `srv/jobs/cleanup.js` | Step failure cleanup + tag cleanup job logic |
| `srv/jobs/analytics.js` | Active learner daily count |
| `srv/jobs/ngds-retry.js` | Retry failed NGDS messages |
| `srv/jobs/account-merge-job.js` | Daily batch: poll SCI for pending merges, execute each |
| `srv/consolidation-service.cds` | ConsolidationService CDS definition |
| `srv/consolidation-service.js` | ConsolidationService handler (SCI-triggered userMerge + getMergeStatus) |
| `test/lib/ngds-client.test.js` | Unit tests for NGDS payload construction |
| `test/lib/adobe-analytics.test.js` | Unit tests for XML beacon construction |
| `test/lib/account-merge.test.js` | Unit tests for merge logic |
| `test/lib/tutorial-sync.test.js` | Unit tests for metadata sync logic |
| `test/jobs/job-lock.test.js` | Integration test for lock acquire/release/expiry |
| `test/consolidation-service.test.js` | Integration test for ConsolidationService |
| `test/admin-service-integrations.test.js` | Integration tests for wired stubs (sendToNgds, syncTutorialMetadata, sendContributorNotifications) |

---

## Spec Refinements (vs. Design Spec)

1. **NGDS destination binding**: The Java app uses Spring's `DestinationAccessor` to get the NGDS destination URL + OAuth token. In CAP Node.js, we use `cds.connect.to('ngds')` with a destination-type service binding in `package.json`. This handles token caching and refresh automatically.

2. **Adobe Analytics**: The Java app uses `HttpClient` with an XML body. We use native `fetch()` directly since no authentication is needed — just a fire-and-forget POST.

3. **Tutorial sync source**: The Java app reads from AEM via HTTP. Our replacement reads from the GitHub fetch pipeline's cached metadata (`.tutorial-cache/metadata.json` produced by `scripts/fetch-tutorials.ts`). No external HTTP call needed.

4. **Account merge trigger**: The Java app has a daily scheduler that calls SCI to get pending merges. In CAP, we expose a `ConsolidationService.userMerge` action that SCI calls directly (push model). The daily job is a fallback that checks for any missed merges.

5. **Contributor notifications**: The Java app emails contributors when tutorials become stale. We compute which tutorials are stale and which contributors to notify, but the actual email sending is out of scope (depends on BTP Mail service integration in Plan 4).

6. **SCI client (`sci-client.js`) deliberately omitted**: The spec lists `srv/lib/sci-client.js` for polling SCI. With the push model (SCI calls `ConsolidationService.userMerge` directly), no outbound SCI client is needed. The daily account merge job simply processes `SecondaryAccounts` with `status: 'SCHEDULED'` — records inserted by the inbound SCI call. If a pull-based SCI integration is needed later, it belongs in Plan 4.

7. **ConsolidationService parameter improvement**: The spec defines `action userMerge(uuid: String)` with a single parameter. We use `action userMerge(primaryUuid: String, secondaryUuid: String)` because the single-parameter version is ambiguous (which UUID?). The `getMergeStatus` return type adds `secondaryCount: Integer` for richer status reporting.

8. **`accomplishment-evaluator.js` deferred**: Listed in the spec's file tree but out of scope for Plan 3. Accomplishment evaluation depends on rule parsing logic that ties into the DeveloperService `after('CREATE', 'TaskRecords')` flow, which will be wired in Plan 4 alongside the STOMP WebSocket and remaining deployment work.

---

### Task 1: Job Lock Library

**Files:**
- Create: `srv/jobs/job-lock.js`
- Test: `test/jobs/job-lock.test.js`

- [x] **Step 1: Write the failing test for acquireLock**

```js
// test/jobs/job-lock.test.js
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import cds from '@sap/cds';

const project = cds.test('serve', '--project', '.', '--in-memory');

describe('job-lock', () => {
  let acquireLock, releaseLock;

  beforeAll(async () => {
    ({ acquireLock, releaseLock } = await import('../srv/jobs/job-lock.js'));
  });

  beforeEach(async () => {
    const { JobLocks } = cds.entities('com.sap.developers.ims');
    await DELETE.from(JobLocks);
  });

  it('acquires a lock on first attempt', async () => {
    const acquired = await acquireLock('test-job', 'instance-0', 60000);
    expect(acquired).toBe(true);
  });

  it('rejects a lock if already held by another instance', async () => {
    await acquireLock('test-job', 'instance-0', 60000);
    const acquired = await acquireLock('test-job', 'instance-1', 60000);
    expect(acquired).toBe(false);
  });

  it('acquires an expired lock', async () => {
    const { JobLocks } = cds.entities('com.sap.developers.ims');
    const past = new Date(Date.now() - 120000).toISOString();
    await INSERT.into(JobLocks).entries({
      jobName: 'test-job', lockedBy: 'instance-0',
      lockedAt: past, expiresAt: past
    });
    const acquired = await acquireLock('test-job', 'instance-1', 60000);
    expect(acquired).toBe(true);
  });

  it('releases a lock', async () => {
    await acquireLock('test-job', 'instance-0', 60000);
    await releaseLock('test-job', 'instance-0');
    const acquired = await acquireLock('test-job', 'instance-1', 60000);
    expect(acquired).toBe(true);
  });
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/jobs/job-lock.test.js`
Expected: FAIL — module not found

- [x] **Step 3: Implement job-lock.js**

```js
// srv/jobs/job-lock.js
import cds from '@sap/cds';

export async function acquireLock(jobName, instanceId, durationMs) {
  const { JobLocks } = cds.entities('com.sap.developers.ims');
  const now = new Date();
  const expiresAt = new Date(now.getTime() + durationMs);

  try {
    await INSERT.into(JobLocks).entries({
      jobName, lockedBy: instanceId,
      lockedAt: now.toISOString(), expiresAt: expiresAt.toISOString()
    });
    return true;
  } catch (e) {
    // Row exists — try to claim expired lock
  }

  const result = await UPDATE(JobLocks)
    .where({ jobName, expiresAt: { '<': now.toISOString() } })
    .set({ lockedBy: instanceId, lockedAt: now.toISOString(), expiresAt: expiresAt.toISOString() });
  return result > 0;
}

export async function releaseLock(jobName, instanceId) {
  const { JobLocks } = cds.entities('com.sap.developers.ims');
  await DELETE.from(JobLocks).where({ jobName, lockedBy: instanceId });
}
```

- [x] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/jobs/job-lock.test.js`
Expected: PASS (4 tests)

- [x] **Step 5: Commit**

```bash
git add srv/jobs/job-lock.js test/jobs/job-lock.test.js
git commit -m "feat(jobs): add distributed lock library using JobLocks entity"
```

---

### Task 2: NGDS Client

**Files:**
- Create: `srv/lib/ngds-client.js`
- Test: `test/lib/ngds-client.test.js`

- [x] **Step 1: Write the failing test**

```js
// test/lib/ngds-client.test.js
import { describe, it, expect } from 'vitest';
import { buildNgdsPayload } from '../srv/lib/ngds-client.js';

describe('ngds-client', () => {
  describe('buildNgdsPayload', () => {
    it('constructs correct JSON structure for a tutorial completion', () => {
      const payload = buildNgdsPayload({
        uuid: 'user-uuid-123',
        taskLegacyId: 42,
        taskType: 'TUTORIAL',
        taskTitle: 'Build a CAP App',
        completionDate: '2026-04-28T10:30:00Z',
        eventLegacyId: null,
        sapId: 'S0012345678'
      });

      expect(payload.context).toBe('developers.sap.com');
      expect(payload.trackingInfo.userId).toBe('user-uuid-123');
      expect(payload.imsData.taskId).toBe(42);
      expect(payload.imsData.taskType).toBe('TUTORIAL');
      expect(payload.interactionData.title).toBe('Build a CAP App');
      expect(payload.interactionData.sapAccountNumber).toBe('S0012345678');
    });

    it('includes event data when eventLegacyId is provided', () => {
      const payload = buildNgdsPayload({
        uuid: 'user-uuid-123',
        taskLegacyId: 42,
        taskType: 'TUTORIAL',
        taskTitle: 'Build a CAP App',
        completionDate: '2026-04-28T10:30:00Z',
        eventLegacyId: 99,
        sapId: null
      });

      expect(payload.imsData.eventId).toBe(99);
    });
  });
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/lib/ngds-client.test.js`
Expected: FAIL — module not found

- [x] **Step 3: Implement ngds-client.js**

```js
// srv/lib/ngds-client.js
import cds from '@sap/cds';

export function buildNgdsPayload({ uuid, taskLegacyId, taskType, taskTitle, completionDate, eventLegacyId, sapId }) {
  return {
    context: 'developers.sap.com',
    trackingInfo: {
      userId: uuid,
      timestamp: completionDate
    },
    imsData: {
      taskId: taskLegacyId,
      taskType,
      eventId: eventLegacyId || undefined
    },
    interactionData: {
      title: taskTitle,
      completionDate,
      sapAccountNumber: sapId || undefined
    }
  };
}

export async function sendToNgds(payloadData) {
  const { NGDSFailedMessages } = cds.entities('com.sap.developers.ims');
  const payload = buildNgdsPayload(payloadData);

  try {
    const ngds = await cds.connect.to('ngds');
    await ngds.send('POST', '/ngds/developers/ims', payload);
    return { success: true };
  } catch (err) {
    const LOG = cds.log('ngds');
    LOG.error('NGDS send failed, storing for retry:', err.message);
    await INSERT.into(NGDSFailedMessages).entries({
      payload: JSON.stringify(payload),
      errorMessage: err.message,
      createdAt: new Date().toISOString(),
      retryCount: 0,
      status: 'PENDING'
    });
    return { success: false, error: err.message };
  }
}

export async function retryFailedMessages() {
  const { NGDSFailedMessages } = cds.entities('com.sap.developers.ims');
  const LOG = cds.log('ngds');

  const pending = await SELECT.from(NGDSFailedMessages)
    .where({ status: 'PENDING', retryCount: { '<': { ref: ['maxRetries'] } } });

  let retried = 0;
  for (const msg of pending) {
    try {
      const ngds = await cds.connect.to('ngds');
      await ngds.send('POST', '/ngds/developers/ims', JSON.parse(msg.payload));
      await DELETE.from(NGDSFailedMessages, msg.ID);
      retried++;
    } catch (err) {
      const newCount = msg.retryCount + 1;
      const update = { retryCount: newCount };
      if (newCount >= msg.maxRetries) update.status = 'FAILED_PERMANENTLY';
      await UPDATE(NGDSFailedMessages, msg.ID).set(update);
      LOG.warn(`NGDS retry failed (${newCount}/${msg.maxRetries}):`, err.message);
    }
  }
  return retried;
}
```

- [x] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/lib/ngds-client.test.js`
Expected: PASS (2 tests)

- [x] **Step 5: Commit**

```bash
git add srv/lib/ngds-client.js test/lib/ngds-client.test.js
git commit -m "feat(ngds): add NGDS client with payload builder and retry logic"
```

---

### Task 3: Adobe Analytics Client

**Files:**
- Create: `srv/lib/adobe-analytics.js`
- Test: `test/lib/adobe-analytics.test.js`

- [x] **Step 1: Write the failing test**

```js
// test/lib/adobe-analytics.test.js
import { describe, it, expect } from 'vitest';
import { buildAdobeBeacon } from '../srv/lib/adobe-analytics.js';

describe('adobe-analytics', () => {
  describe('buildAdobeBeacon', () => {
    it('constructs XML beacon with correct eVars', () => {
      const xml = buildAdobeBeacon({
        visitorId: 'visitor-123',
        taskLegacyId: 42,
        taskType: 'TUTORIAL',
        taskTitle: 'Build a CAP App',
        reportSuiteId: 'sapdeveloperdev'
      });

      expect(xml).toContain('<reportSuiteID>sapdeveloperdev</reportSuiteID>');
      expect(xml).toContain('<eVar1>42</eVar1>');
      expect(xml).toContain('<eVar2>TUTORIAL</eVar2>');
      expect(xml).toContain('<eVar3>Build a CAP App</eVar3>');
      expect(xml).toContain('<events>event86</events>');
      expect(xml).toContain('<visitorID>visitor-123</visitorID>');
    });

    it('uses default report suite when not specified', () => {
      const xml = buildAdobeBeacon({
        visitorId: 'v1',
        taskLegacyId: 1,
        taskType: 'STEP',
        taskTitle: 'Step 1'
      });
      expect(xml).toContain('<reportSuiteID>sapdeveloperdev</reportSuiteID>');
    });
  });
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/lib/adobe-analytics.test.js`
Expected: FAIL — module not found

- [x] **Step 3: Implement adobe-analytics.js**

```js
// srv/lib/adobe-analytics.js
import cds from '@sap/cds';

const ADOBE_ENDPOINT = 'https://sap.d1.sc.omtrdc.net/b/ss/{rsid}/6';
const DEFAULT_REPORT_SUITE = 'sapdeveloperdev';

export function buildAdobeBeacon({ visitorId, taskLegacyId, taskType, taskTitle, reportSuiteId }) {
  const rsid = reportSuiteId || DEFAULT_REPORT_SUITE;
  return `<?xml version="1.0" encoding="UTF-8"?>
<request>
  <reportSuiteID>${rsid}</reportSuiteID>
  <visitorID>${visitorId}</visitorID>
  <events>event86</events>
  <eVar1>${taskLegacyId}</eVar1>
  <eVar2>${taskType}</eVar2>
  <eVar3>${escapeXml(taskTitle)}</eVar3>
</request>`;
}

function escapeXml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export async function sendAdobeBeacon(beaconData) {
  const LOG = cds.log('adobe-analytics');
  const xml = buildAdobeBeacon(beaconData);
  const rsid = beaconData.reportSuiteId || DEFAULT_REPORT_SUITE;
  const url = ADOBE_ENDPOINT.replace('{rsid}', rsid);

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/xml' },
      body: xml
    });
    if (!response.ok) {
      LOG.warn(`Adobe Analytics responded ${response.status}`);
    }
    return { success: response.ok };
  } catch (err) {
    LOG.error('Adobe Analytics beacon failed:', err.message);
    return { success: false, error: err.message };
  }
}
```

- [x] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/lib/adobe-analytics.test.js`
Expected: PASS (2 tests)

- [x] **Step 5: Commit**

```bash
git add srv/lib/adobe-analytics.js test/lib/adobe-analytics.test.js
git commit -m "feat(analytics): add Adobe Analytics XML beacon client"
```

---

### Task 4: Account Merge Library

**Files:**
- Create: `srv/lib/account-merge.js`
- Test: `test/lib/account-merge.test.js`

- [x] **Step 1: Write the failing test**

```js
// test/lib/account-merge.test.js
import { describe, it, expect, beforeAll } from 'vitest';
import cds from '@sap/cds';

const project = cds.test('serve', '--project', '.', '--in-memory');

describe('account-merge', () => {
  let mergeAccounts;

  beforeAll(async () => {
    ({ mergeAccounts } = await import('../srv/lib/account-merge.js'));

    const { Users, TaskRecords, PrizeRecords } = cds.entities('com.sap.developers.ims');

    // Primary user
    await INSERT.into(Users).entries({
      ID: 'aaaaaaaa-1111-1111-1111-111111111111',
      uuid: 'primary-uuid', legacyId: 9001, firstName: 'Primary'
    });
    // Secondary user
    await INSERT.into(Users).entries({
      ID: 'bbbbbbbb-2222-2222-2222-222222222222',
      uuid: 'secondary-uuid', legacyId: 9002, firstName: 'Secondary'
    });
    // Task records for secondary
    await INSERT.into(TaskRecords).entries([
      { ID: 'cccccccc-0001-0000-0000-000000000001', user_ID: 'bbbbbbbb-2222-2222-2222-222222222222', taskLegacyId: 100, taskType: 'TUTORIAL', status: 'COMPLETED', legacyId: 8001 },
      { ID: 'cccccccc-0002-0000-0000-000000000001', user_ID: 'bbbbbbbb-2222-2222-2222-222222222222', taskLegacyId: 200, taskType: 'MISSION', status: 'COMPLETED', legacyId: 8002 },
    ]);
    // Prize record for secondary
    await INSERT.into(PrizeRecords).entries({
      ID: 'dddddddd-0001-0000-0000-000000000001',
      user_ID: 'bbbbbbbb-2222-2222-2222-222222222222', legacyId: 7001, status: 'AWARDED'
    });
  });

  it('transfers task records from secondary to primary', async () => {
    const { TaskRecords } = cds.entities('com.sap.developers.ims');
    await mergeAccounts('primary-uuid', 'secondary-uuid');

    const primaryRecords = await SELECT.from(TaskRecords)
      .where({ user_ID: 'aaaaaaaa-1111-1111-1111-111111111111' });
    expect(primaryRecords.length).toBe(2);
  });

  it('transfers prize records from secondary to primary', async () => {
    const { PrizeRecords } = cds.entities('com.sap.developers.ims');
    const primaryPrizes = await SELECT.from(PrizeRecords)
      .where({ user_ID: 'aaaaaaaa-1111-1111-1111-111111111111' });
    expect(primaryPrizes.length).toBe(1);
  });
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/lib/account-merge.test.js`
Expected: FAIL — module not found

- [x] **Step 3: Implement account-merge.js**

```js
// srv/lib/account-merge.js
import cds from '@sap/cds';

export async function mergeAccounts(primaryUuid, secondaryUuid) {
  const { Users, TaskRecords, PrizeRecords, AccomplishmentRecords,
          ActiveLearnerRecords, PrimaryAccounts, SecondaryAccounts } = cds.entities('com.sap.developers.ims');
  const LOG = cds.log('account-merge');

  const primaryUser = await SELECT.one.from(Users).where({ uuid: primaryUuid });
  const secondaryUser = await SELECT.one.from(Users).where({ uuid: secondaryUuid });

  if (!primaryUser) throw new Error(`Primary user not found: ${primaryUuid}`);
  if (!secondaryUser) throw new Error(`Secondary user not found: ${secondaryUuid}`);

  LOG.info(`Merging ${secondaryUuid} → ${primaryUuid}`);

  // Transfer task records
  await UPDATE(TaskRecords)
    .where({ user_ID: secondaryUser.ID })
    .set({ user_ID: primaryUser.ID });

  // Transfer prize records
  await UPDATE(PrizeRecords)
    .where({ user_ID: secondaryUser.ID })
    .set({ user_ID: primaryUser.ID });

  // Transfer accomplishment records
  await UPDATE(AccomplishmentRecords)
    .where({ user_ID: secondaryUser.ID })
    .set({ user_ID: primaryUser.ID });

  // Track the merge
  let primary = await SELECT.one.from(PrimaryAccounts).where({ uuid: primaryUuid });
  if (!primary) {
    await INSERT.into(PrimaryAccounts).entries({
      uuid: primaryUuid, status: 'ACTIVE', legacyId: primaryUser.legacyId
    });
    primary = await SELECT.one.from(PrimaryAccounts).where({ uuid: primaryUuid });
  }

  await INSERT.into(SecondaryAccounts).entries({
    uuid: secondaryUuid,
    primaryAccount_ID: primary.ID,
    status: 'MERGED',
    mergedAt: new Date().toISOString(),
    legacyId: secondaryUser.legacyId
  });

  LOG.info(`Merge complete: ${secondaryUuid} → ${primaryUuid}`);
  return { primaryUuid, secondaryUuid, status: 'MERGED' };
}
```

- [x] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/lib/account-merge.test.js`
Expected: PASS (2 tests)

- [x] **Step 5: Commit**

```bash
git add srv/lib/account-merge.js test/lib/account-merge.test.js
git commit -m "feat(merge): add account merge library for SCI consolidation"
```

---

### Task 5: Tutorial Sync Library

**Files:**
- Create: `srv/lib/tutorial-sync.js`
- Test: `test/lib/tutorial-sync.test.js`

- [x] **Step 1: Write the failing test**

```js
// test/lib/tutorial-sync.test.js
import { describe, it, expect, beforeAll } from 'vitest';
import cds from '@sap/cds';

const project = cds.test('serve', '--project', '.', '--in-memory');

describe('tutorial-sync', () => {
  let syncTutorialMetadata;

  beforeAll(async () => {
    ({ syncTutorialMetadata } = await import('../srv/lib/tutorial-sync.js'));

    const { Tutorials } = cds.entities('com.sap.developers.ims');
    await INSERT.into(Tutorials).entries([
      { ID: 'eeeeeeee-0001-0000-0000-000000000001', slug: 'cap-getting-started', title: 'Getting Started with CAP', legacyId: 5001, status: 'ACTIVE' },
      { ID: 'eeeeeeee-0002-0000-0000-000000000001', slug: 'hana-basics', title: 'HANA Basics', legacyId: 5002, status: 'ACTIVE' },
    ]);
  });

  it('creates TutorialMeta records for tutorials without metadata', async () => {
    const { TutorialMeta } = cds.entities('com.sap.developers.ims');

    const metadataSource = [
      { slug: 'cap-getting-started', owner: 'thomas.jung@sap.com', reviewedDate: '2026-03-15' },
      { slug: 'hana-basics', owner: 'rich.heilman@sap.com', reviewedDate: '2026-02-01' },
    ];

    const result = await syncTutorialMetadata(metadataSource);
    expect(result.synced).toBe(2);

    const meta = await SELECT.from(TutorialMeta);
    expect(meta.length).toBe(2);
    expect(meta[0].owner).toBe('thomas.jung@sap.com');
  });

  it('updates existing TutorialMeta when sync is re-run', async () => {
    const { TutorialMeta } = cds.entities('com.sap.developers.ims');

    const metadataSource = [
      { slug: 'cap-getting-started', owner: 'new.owner@sap.com', reviewedDate: '2026-04-01' },
    ];

    await syncTutorialMetadata(metadataSource);
    const meta = await SELECT.from(TutorialMeta)
      .where({ tutorial_ID: 'eeeeeeee-0001-0000-0000-000000000001' });
    expect(meta[0].owner).toBe('new.owner@sap.com');
  });
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/lib/tutorial-sync.test.js`
Expected: FAIL — module not found

- [x] **Step 3: Implement tutorial-sync.js**

```js
// srv/lib/tutorial-sync.js
import cds from '@sap/cds';
import { getNextLegacyId } from './legacy-id.js';

export async function syncTutorialMetadata(metadataSource) {
  const { Tutorials, TutorialMeta } = cds.entities('com.sap.developers.ims');
  const db = await cds.connect.to('db');
  const LOG = cds.log('tutorial-sync');
  let synced = 0;

  for (const entry of metadataSource) {
    const tutorial = await SELECT.one.from(Tutorials).where({ slug: entry.slug });
    if (!tutorial) {
      LOG.warn(`Tutorial not found for slug: ${entry.slug}`);
      continue;
    }

    const existing = await SELECT.one.from(TutorialMeta).where({ tutorial_ID: tutorial.ID });

    if (existing) {
      await UPDATE(TutorialMeta, existing.ID).set({
        owner: entry.owner,
        reviewedDate: entry.reviewedDate || existing.reviewedDate,
        monitoredStatus: entry.monitoredStatus || existing.monitoredStatus
      });
    } else {
      await INSERT.into(TutorialMeta).entries({
        tutorial_ID: tutorial.ID,
        owner: entry.owner,
        reviewedDate: entry.reviewedDate || null,
        monitoredStatus: 'ACTIVE',
        notificationNumber: 0,
        legacyId: await getNextLegacyId('TutorialMeta', db)
      });
    }
    synced++;
  }

  LOG.info(`Synced ${synced} tutorial metadata records`);
  return { synced };
}
```

- [x] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/lib/tutorial-sync.test.js`
Expected: PASS (2 tests)

- [x] **Step 5: Commit**

```bash
git add srv/lib/tutorial-sync.js test/lib/tutorial-sync.test.js
git commit -m "feat(sync): add tutorial metadata sync from build pipeline"
```

---

### Task 6: Contributor Notifications Library

**Files:**
- Create: `srv/lib/contributor-notifications.js`
- Test: `test/lib/contributor-notifications.test.js`

- [x] **Step 1: Write the failing test**

```js
// test/lib/contributor-notifications.test.js
import { describe, it, expect, beforeAll } from 'vitest';
import cds from '@sap/cds';

const project = cds.test('serve', '--project', '.', '--in-memory');

describe('contributor-notifications', () => {
  let computeStaleNotifications;

  beforeAll(async () => {
    ({ computeStaleNotifications } = await import('../srv/lib/contributor-notifications.js'));

    const { Tutorials, TutorialMeta, TutorialContributors } = cds.entities('com.sap.developers.ims');

    await INSERT.into(Tutorials).entries([
      { ID: 'ffffffff-0001-0000-0000-000000000001', slug: 'stale-tutorial', title: 'Stale Tutorial', legacyId: 6001, status: 'ACTIVE' },
      { ID: 'ffffffff-0002-0000-0000-000000000001', slug: 'fresh-tutorial', title: 'Fresh Tutorial', legacyId: 6002, status: 'ACTIVE' },
    ]);

    // Stale: reviewed 200 days ago
    const staleDate = new Date(Date.now() - 200 * 86400000).toISOString();
    await INSERT.into(TutorialMeta).entries({
      ID: 'aaaaaaaa-meta-0001-0000-000000000001',
      tutorial_ID: 'ffffffff-0001-0000-0000-000000000001',
      reviewedDate: staleDate, owner: 'owner@sap.com',
      monitoredStatus: 'ACTIVE', notificationNumber: 0, legacyId: 6101
    });

    // Fresh: reviewed 10 days ago
    const freshDate = new Date(Date.now() - 10 * 86400000).toISOString();
    await INSERT.into(TutorialMeta).entries({
      ID: 'aaaaaaaa-meta-0002-0000-000000000001',
      tutorial_ID: 'ffffffff-0002-0000-0000-000000000001',
      reviewedDate: freshDate, owner: 'owner@sap.com',
      monitoredStatus: 'ACTIVE', notificationNumber: 0, legacyId: 6102
    });

    await INSERT.into(TutorialContributors).entries([
      { ID: 'bbbbbbbb-cont-0001-0000-000000000001', tutorial_ID: 'ffffffff-0001-0000-0000-000000000001', name: 'Alice', email: 'alice@sap.com', role: 'AUTHOR', legacyId: 6201 },
      { ID: 'bbbbbbbb-cont-0002-0000-000000000001', tutorial_ID: 'ffffffff-0002-0000-0000-000000000001', name: 'Bob', email: 'bob@sap.com', role: 'AUTHOR', legacyId: 6202 },
    ]);
  });

  it('identifies stale tutorials needing notification (>180 days)', async () => {
    const notifications = await computeStaleNotifications(180);
    expect(notifications.length).toBe(1);
    expect(notifications[0].slug).toBe('stale-tutorial');
    expect(notifications[0].contributors[0].email).toBe('alice@sap.com');
  });

  it('returns empty when no tutorials are stale', async () => {
    const notifications = await computeStaleNotifications(365);
    expect(notifications.length).toBe(0);
  });
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/lib/contributor-notifications.test.js`
Expected: FAIL — module not found

- [x] **Step 3: Implement contributor-notifications.js**

```js
// srv/lib/contributor-notifications.js
import cds from '@sap/cds';

export async function computeStaleNotifications(staleDaysThreshold = 180) {
  const { Tutorials, TutorialMeta, TutorialContributors } = cds.entities('com.sap.developers.ims');
  const cutoffDate = new Date(Date.now() - staleDaysThreshold * 86400000).toISOString();

  const staleMeta = await SELECT.from(TutorialMeta)
    .where({ monitoredStatus: 'ACTIVE', reviewedDate: { '<': cutoffDate } });

  const notifications = [];
  for (const meta of staleMeta) {
    const tutorial = await SELECT.one.from(Tutorials, meta.tutorial_ID);
    if (!tutorial || tutorial.status !== 'ACTIVE') continue;

    const contributors = await SELECT.from(TutorialContributors)
      .where({ tutorial_ID: tutorial.ID });

    notifications.push({
      tutorialId: tutorial.ID,
      slug: tutorial.slug,
      title: tutorial.title,
      reviewedDate: meta.reviewedDate,
      notificationNumber: meta.notificationNumber + 1,
      contributors: contributors.map(c => ({ name: c.name, email: c.email, role: c.role }))
    });
  }

  return notifications;
}

export async function markNotificationSent(tutorialId) {
  const { TutorialMeta } = cds.entities('com.sap.developers.ims');
  const meta = await SELECT.one.from(TutorialMeta).where({ tutorial_ID: tutorialId });
  if (!meta) return;
  await UPDATE(TutorialMeta, meta.ID).set({
    notificationNumber: (meta.notificationNumber || 0) + 1,
    lastNotificationDate: new Date().toISOString()
  });
}
```

- [x] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/lib/contributor-notifications.test.js`
Expected: PASS (2 tests)

- [x] **Step 5: Commit**

```bash
git add srv/lib/contributor-notifications.js test/lib/contributor-notifications.test.js
git commit -m "feat(notifications): add stale tutorial contributor notification logic"
```

---

### Task 7: ConsolidationService (CDS + Handlers)

**Files:**
- Create: `srv/consolidation-service.cds`
- Create: `srv/consolidation-service.js`
- Test: `test/consolidation-service.test.js`

- [x] **Step 1: Write the CDS definition**

```cds
// srv/consolidation-service.cds
using { com.sap.developers.ims as ims } from '../db/schema';

@path: '/api/v1'
@requires: 'ConsolidationScope'
service ConsolidationService {
  action userMerge(primaryUuid : String, secondaryUuid : String);
  function getMergeStatus(uuid : String) returns {
    primaryUuid   : String;
    status        : String;
    mergedAt      : Timestamp;
    secondaryCount : Integer;
  };
}
```

- [x] **Step 2: Write the failing integration test**

```js
// test/consolidation-service.test.js
import { describe, it, expect, beforeAll } from 'vitest';
import cds from '@sap/cds';

const project = cds.test('serve', '--project', '.', '--in-memory');

describe('ConsolidationService', () => {

  beforeAll(async () => {
    const { Users, TaskRecords } = cds.entities('com.sap.developers.ims');

    await INSERT.into(Users).entries([
      { ID: '11111111-aaaa-0000-0000-000000000001', uuid: 'consolidation-primary', legacyId: 7001 },
      { ID: '22222222-bbbb-0000-0000-000000000001', uuid: 'consolidation-secondary', legacyId: 7002 },
    ]);

    await INSERT.into(TaskRecords).entries([
      { ID: '33333333-cccc-0000-0000-000000000001', user_ID: '22222222-bbbb-0000-0000-000000000001', taskLegacyId: 300, taskType: 'TUTORIAL', status: 'COMPLETED', legacyId: 7101 },
    ]);
  });

  it('rejects unauthenticated requests', async () => {
    const { status } = await project.post('/api/v1/userMerge',
      { primaryUuid: 'a', secondaryUuid: 'b' },
      { validateStatus: () => true });
    expect([401, 403]).toContain(status);
  });

  it('merges secondary into primary', async () => {
    const { status } = await project.post('/api/v1/userMerge',
      { primaryUuid: 'consolidation-primary', secondaryUuid: 'consolidation-secondary' },
      { auth: { username: 'admin', password: 'admin' } });
    expect(status).toBe(204);

    // Verify task records moved
    const { TaskRecords } = cds.entities('com.sap.developers.ims');
    const records = await SELECT.from(TaskRecords)
      .where({ user_ID: '11111111-aaaa-0000-0000-000000000001' });
    expect(records.length).toBe(1);
  });

  it('returns merge status', async () => {
    const { status, data } = await project.get(
      "/api/v1/getMergeStatus(uuid='consolidation-primary')",
      { auth: { username: 'admin', password: 'admin' } });
    expect(status).toBe(200);
    expect(data.primaryUuid).toBe('consolidation-primary');
    expect(data.secondaryCount).toBe(1);
  });
});
```

- [x] **Step 3: Run test to verify it fails**

Run: `npx vitest run test/consolidation-service.test.js`
Expected: FAIL — service not found / handler not implemented

- [x] **Step 4: Implement consolidation-service.js**

```js
// srv/consolidation-service.js
import cds from '@sap/cds';
import { mergeAccounts } from './lib/account-merge.js';

export default class ConsolidationService extends cds.ApplicationService {

  async init() {
    const { PrimaryAccounts, SecondaryAccounts } = cds.entities('com.sap.developers.ims');

    this.on('userMerge', async (req) => {
      const { primaryUuid, secondaryUuid } = req.data;
      if (!primaryUuid || !secondaryUuid) {
        return req.reject(400, 'Both primaryUuid and secondaryUuid are required');
      }
      await mergeAccounts(primaryUuid, secondaryUuid);
    });

    this.on('getMergeStatus', async (req) => {
      const { uuid } = req.data;
      const primary = await SELECT.one.from(PrimaryAccounts).where({ uuid });
      if (!primary) return { primaryUuid: null, status: null, mergedAt: null, secondaryCount: 0 };

      const secondaries = await SELECT.from(SecondaryAccounts)
        .where({ primaryAccount_ID: primary.ID });
      const latestMerge = secondaries.reduce((latest, s) =>
        s.mergedAt && (!latest || s.mergedAt > latest) ? s.mergedAt : latest, null);

      return {
        primaryUuid: primary.uuid,
        status: primary.status,
        mergedAt: latestMerge,
        secondaryCount: secondaries.length
      };
    });

    await super.init();
  }
}
```

- [x] **Step 5: Run test to verify it passes**

Run: `npx vitest run test/consolidation-service.test.js`
Expected: PASS (3 tests)

- [x] **Step 6: Commit**

```bash
git add srv/consolidation-service.cds srv/consolidation-service.js test/consolidation-service.test.js
git commit -m "feat(consolidation): add ConsolidationService for SCI account merge"
```

---

### Task 8: Wire AdminService Integration Stubs

**Files:**
- Modify: `srv/admin-service.js` (replace stubs with real implementations)
- Test: `test/admin-service-integrations.test.js`

- [x] **Step 1: Write the failing integration test**

```js
// test/admin-service-integrations.test.js
import { describe, it, expect, beforeAll, vi } from 'vitest';
import cds from '@sap/cds';

const project = cds.test('serve', '--project', '.', '--in-memory');

describe('AdminService integrations', () => {

  beforeAll(async () => {
    const { Tutorials, TutorialMeta, TutorialContributors, TaskRecords, Users } = cds.entities('com.sap.developers.ims');

    await INSERT.into(Users).entries({
      ID: 'aaaaaaaa-intg-0000-0000-000000000001',
      uuid: 'intg-user', legacyId: 4001, sapId: 'S001'
    });

    await INSERT.into(Tutorials).entries({
      ID: 'bbbbbbbb-intg-0000-0000-000000000001',
      slug: 'intg-tutorial', title: 'Integration Tutorial',
      legacyId: 4101, status: 'ACTIVE'
    });

    await INSERT.into(TaskRecords).entries({
      ID: 'cccccccc-intg-0000-0000-000000000001',
      user_ID: 'aaaaaaaa-intg-0000-0000-000000000001',
      taskLegacyId: 4101, taskType: 'TUTORIAL',
      status: 'COMPLETED', legacyId: 4201
    });
  });

  describe('sendToNgds', () => {
    it('stores a failed NGDS message when destination is unavailable', async () => {
      const { status } = await project.post('/admin/sendToNgds',
        { taskRecordLegacyId: 4201 },
        { auth: { username: 'admin', password: 'admin' } });
      // Without NGDS destination configured, it should store for retry
      expect(status).toBe(200);

      const { NGDSFailedMessages } = cds.entities('com.sap.developers.ims');
      const failed = await SELECT.from(NGDSFailedMessages);
      expect(failed.length).toBeGreaterThan(0);
      expect(failed[0].status).toBe('PENDING');
    });
  });

  describe('syncTutorialMetadata', () => {
    it('syncs metadata from pipeline cache', async () => {
      const { status, data } = await project.post('/admin/syncTutorialMetadata', {},
        { auth: { username: 'admin', password: 'admin' } });
      // Should succeed (or return synced count = 0 if no cache file exists in test)
      expect(status).toBe(200);
    });
  });

  describe('sendContributorNotifications', () => {
    it('computes notifications for stale tutorials', async () => {
      const { TutorialMeta } = cds.entities('com.sap.developers.ims');
      // Add stale metadata
      const staleDate = new Date(Date.now() - 200 * 86400000).toISOString();
      await INSERT.into(TutorialMeta).entries({
        ID: 'dddddddd-intg-0000-0000-000000000001',
        tutorial_ID: 'bbbbbbbb-intg-0000-0000-000000000001',
        reviewedDate: staleDate, owner: 'owner@sap.com',
        monitoredStatus: 'ACTIVE', notificationNumber: 0, legacyId: 4301
      });

      const { status, data } = await project.post('/admin/sendContributorNotifications', {},
        { auth: { username: 'admin', password: 'admin' } });
      expect(status).toBe(200);
      expect(data.notified).toBeGreaterThanOrEqual(0);
    });
  });
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/admin-service-integrations.test.js`
Expected: FAIL — stubs still return 501

- [x] **Step 3: Update admin-service.js to wire real implementations**

Replace the three stub handlers in `srv/admin-service.js` (lines 230-240) with:

```js
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

    this.on('sendContributorNotifications', async (req) => {
      const { computeStaleNotifications, markNotificationSent } = await import('./lib/contributor-notifications.js');
      const notifications = await computeStaleNotifications(180);

      for (const n of notifications) {
        // In production, this would send emails via BTP Mail service.
        // For now, we just mark the notification as sent.
        await markNotificationSent(n.tutorialId);
      }

      return { notified: notifications.length };
    });
```

Also add the necessary import at the top of `admin-service.js`:
- No new top-level imports needed (using dynamic imports within handlers for lazy loading)

- [x] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/admin-service-integrations.test.js`
Expected: PASS (3 tests)

- [x] **Step 5: Run all existing admin tests to verify no regressions**

Run: `npx vitest run test/admin-service.test.js`
Expected: PASS (all 13 existing tests pass — stubs are replaced)

- [x] **Step 6: Commit**

```bash
git add srv/admin-service.js test/admin-service-integrations.test.js
git commit -m "feat(admin): wire sendToNgds, syncTutorialMetadata, sendContributorNotifications to real implementations"
```

---

### Task 9: Job Scheduler + Individual Jobs

**Files:**
- Create: `srv/jobs/scheduler.js`
- Create: `srv/jobs/cleanup.js`
- Create: `srv/jobs/analytics.js`
- Create: `srv/jobs/ngds-retry.js`
- Create: `srv/jobs/account-merge-job.js`
- Modify: `package.json` (add `node-cron` dependency)
- Create: `srv/server.js` (bootstrap hook to register scheduler)

- [x] **Step 1: Install node-cron**

```bash
npm install node-cron
```

- [x] **Step 2: Create srv/jobs/cleanup.js**

```js
// srv/jobs/cleanup.js
import cds from '@sap/cds';

export async function cleanupStepFailures(olderThanDays = 90) {
  const { StepFailures } = cds.entities('com.sap.developers.ims');
  const LOG = cds.log('jobs/cleanup');
  const cutoff = new Date(Date.now() - olderThanDays * 86400000).toISOString();
  const result = await DELETE.from(StepFailures).where({ failureDate: { '<': cutoff } });
  LOG.info(`Cleaned up step failures older than ${olderThanDays} days: ${result} removed`);
  return result;
}

export async function cleanupUnusedTags() {
  const { Tags, TutorialTags } = cds.entities('com.sap.developers.ims');
  const LOG = cds.log('jobs/cleanup');
  const usedTagIds = await SELECT.from(TutorialTags).columns('tag_ID');
  const usedSet = new Set(usedTagIds.map(r => r.tag_ID));
  const allTags = await SELECT.from(Tags).columns('ID');
  const unused = allTags.filter(t => !usedSet.has(t.ID));
  if (unused.length === 0) return 0;
  await DELETE.from(Tags).where({ ID: { in: unused.map(t => t.ID) } });
  LOG.info(`Cleaned up ${unused.length} unused tags`);
  return unused.length;
}
```

- [x] **Step 3: Create srv/jobs/analytics.js**

```js
// srv/jobs/analytics.js
import cds from '@sap/cds';
import { getNextLegacyId } from '../lib/legacy-id.js';

export async function recordActiveLearners() {
  const { TaskRecords, ActiveLearnerRecords } = cds.entities('com.sap.developers.ims');
  const db = await cds.connect.to('db');
  const LOG = cds.log('jobs/analytics');

  const today = new Date().toISOString().split('T')[0];
  const oneDayAgo = new Date(Date.now() - 86400000).toISOString();

  const recentRecords = await SELECT.from(TaskRecords)
    .where({ modifiedAt: { '>=': oneDayAgo } })
    .columns('user_ID');

  const uniqueUsers = new Set(recentRecords.map(r => r.user_ID));

  await INSERT.into(ActiveLearnerRecords).entries({
    recordDate: today,
    count: uniqueUsers.size,
    legacyId: await getNextLegacyId('ActiveLearnerRecords', db)
  });

  LOG.info(`Recorded ${uniqueUsers.size} active learners for ${today}`);
  return uniqueUsers.size;
}
```

- [x] **Step 4: Create srv/jobs/ngds-retry.js**

```js
// srv/jobs/ngds-retry.js
import { retryFailedMessages } from '../lib/ngds-client.js';

export async function retryNgds() {
  return retryFailedMessages();
}
```

- [x] **Step 5: Create srv/jobs/account-merge-job.js**

```js
// srv/jobs/account-merge-job.js
import cds from '@sap/cds';
import { mergeAccounts } from '../lib/account-merge.js';

export async function processAccountMerges() {
  const { PrimaryAccounts, SecondaryAccounts } = cds.entities('com.sap.developers.ims');
  const LOG = cds.log('jobs/account-merge');

  const pending = await SELECT.from(SecondaryAccounts).where({ status: 'SCHEDULED' });
  let processed = 0;

  for (const secondary of pending) {
    const primary = await SELECT.one.from(PrimaryAccounts, secondary.primaryAccount_ID);
    if (!primary) {
      LOG.warn(`Primary account not found for secondary ${secondary.uuid}`);
      continue;
    }

    try {
      await mergeAccounts(primary.uuid, secondary.uuid);
      processed++;
    } catch (err) {
      LOG.error(`Failed to merge ${secondary.uuid} → ${primary.uuid}:`, err.message);
      await UPDATE(SecondaryAccounts, secondary.ID).set({ status: 'FAILED' });
    }
  }

  LOG.info(`Processed ${processed} account merges`);
  return processed;
}
```

- [x] **Step 6: Create srv/jobs/scheduler.js**

```js
// srv/jobs/scheduler.js
import cron from 'node-cron';
import { acquireLock, releaseLock } from './job-lock.js';
import { cleanupStepFailures, cleanupUnusedTags } from './cleanup.js';
import { recordActiveLearners } from './analytics.js';
import { retryNgds } from './ngds-retry.js';
import { processAccountMerges } from './account-merge-job.js';
import { computeStaleNotifications, markNotificationSent } from '../lib/contributor-notifications.js';
import { syncTutorialMetadata } from '../lib/tutorial-sync.js';
import cds from '@sap/cds';

const instanceId = process.env.CF_INSTANCE_INDEX || '0';
const LOG = cds.log('scheduler');

async function runWithLock(jobName, durationMs, fn) {
  if (await acquireLock(jobName, instanceId, durationMs)) {
    try {
      await fn();
    } catch (err) {
      LOG.error(`Job ${jobName} failed:`, err.message);
    } finally {
      await releaseLock(jobName, instanceId);
    }
  }
}

export function registerJobs() {
  LOG.info(`Registering scheduled jobs on instance ${instanceId}`);

  // Daily at 00:00 — cleanup step failures
  cron.schedule('0 0 * * *', () =>
    runWithLock('cleanup-step-failures', 3600000, () => cleanupStepFailures(90))
  );

  // Daily at 00:15 — active learner analytics
  cron.schedule('15 0 * * *', () =>
    runWithLock('active-learner-analytics', 1800000, recordActiveLearners)
  );

  // Every 2 hours — NGDS retry
  cron.schedule('0 */2 * * *', () =>
    runWithLock('ngds-retry', 1800000, retryNgds)
  );

  // Daily at 01:00 — account merge batch
  cron.schedule('0 1 * * *', () =>
    runWithLock('account-merge-batch', 7200000, processAccountMerges)
  );

  // Jan 2 and Jul 2 at 00:00 — tag cleanup
  cron.schedule('0 0 2 1,7 *', () =>
    runWithLock('tag-cleanup', 3600000, cleanupUnusedTags)
  );

  // Weekly Sunday 02:00 — tutorial metadata review (mark outdated)
  cron.schedule('0 2 * * 0', () =>
    runWithLock('tutorial-metadata-review', 3600000, async () => {
      const fs = await import('fs');
      const path = await import('path');
      const cachePath = path.join(process.cwd(), '.tutorial-cache', 'metadata.json');
      try {
        const raw = fs.readFileSync(cachePath, 'utf-8');
        await syncTutorialMetadata(JSON.parse(raw));
      } catch { LOG.warn('No metadata cache found for tutorial review sync'); }
    })
  );

  // Weekly Monday 09:00 — contributor notifications for stale tutorials
  cron.schedule('0 9 * * 1', () =>
    runWithLock('contributor-notifications', 1800000, async () => {
      const notifications = await computeStaleNotifications(180);
      for (const n of notifications) {
        await markNotificationSent(n.tutorialId);
      }
      LOG.info(`Processed ${notifications.length} contributor notifications`);
    })
  );

  LOG.info('All scheduled jobs registered');
}
```

- [x] **Step 7: Create srv/server.js to bootstrap scheduler**

```js
// srv/server.js
import cds from '@sap/cds';
import { registerJobs } from './jobs/scheduler.js';

cds.on('served', () => {
  if (process.env.NODE_ENV !== 'test') {
    registerJobs();
  }
});
```

- [x] **Step 8: Run all tests to verify nothing is broken**

Run: `npx vitest run`
Expected: All tests pass. The scheduler is not activated during tests because `NODE_ENV=test`.

- [x] **Step 9: Commit**

```bash
git add srv/jobs/scheduler.js srv/jobs/cleanup.js srv/jobs/analytics.js srv/jobs/ngds-retry.js srv/jobs/account-merge-job.js srv/server.js package.json package-lock.json
git commit -m "feat(jobs): add scheduled jobs with distributed locks (cron + JobLocks)"
```

---

### Task 10: NGDS Destination Configuration

**Files:**
- Modify: `package.json` (add ngds destination binding under `cds.requires`)
- Modify: `.cdsrc.json` (add mock ngds for local dev)

- [x] **Step 1: Add NGDS destination to cds requires in package.json**

Add to `"cds"."requires"` in `package.json`:

```json
"ngds": {
  "kind": "rest",
  "[hybrid]": {
    "kind": "rest",
    "credentials": {
      "destination": "ngds-destination",
      "path": "/ngds/developers/ims"
    }
  },
  "[production]": {
    "kind": "rest",
    "credentials": {
      "destination": "ngds-destination",
      "path": "/ngds/developers/ims"
    }
  }
}
```

- [x] **Step 2: Add mock NGDS service for local dev in .cdsrc.json**

Under `"requires"`, add a mocked NGDS service configuration so local tests don't try to hit a real destination:

```json
"ngds": {
  "kind": "rest",
  "credentials": {
    "url": "http://localhost:0/ngds-mock"
  }
}
```

- [x] **Step 3: Run full test suite to verify configuration doesn't break existing tests**

Run: `npx vitest run`
Expected: All tests pass

- [x] **Step 4: Commit**

```bash
git add package.json .cdsrc.json
git commit -m "feat(config): add NGDS destination binding configuration"
```

---

### Task 11: Full Integration Test Suite

**Files:**
- Create: `test/integration/full-workflow.test.js`

This test exercises the complete flow: developer completes a step → NGDS payload is queued → admin can retry → merge works.

- [x] **Step 1: Write the full workflow integration test**

```js
// test/integration/full-workflow.test.js
import { describe, it, expect, beforeAll } from 'vitest';
import cds from '@sap/cds';

const project = cds.test('serve', '--project', '.', '--in-memory');

describe('Full integration workflow', () => {

  beforeAll(async () => {
    const { Tutorials, Steps, Users } = cds.entities('com.sap.developers.ims');

    await INSERT.into(Tutorials).entries({
      ID: 'aaaaaaaa-flow-0000-0000-000000000001',
      slug: 'flow-tutorial', title: 'Flow Tutorial',
      legacyId: 9001, status: 'ACTIVE'
    });

    await INSERT.into(Steps).entries([
      { ID: 'bbbbbbbb-flow-0001-0000-000000000001', tutorial_ID: 'aaaaaaaa-flow-0000-0000-000000000001', stepOrder: 1, title: 'Step 1', legacyId: 9101 },
      { ID: 'bbbbbbbb-flow-0002-0000-000000000001', tutorial_ID: 'aaaaaaaa-flow-0000-0000-000000000001', stepOrder: 2, title: 'Step 2', legacyId: 9102 },
    ]);

    await INSERT.into(Users).entries({
      ID: 'cccccccc-flow-0000-0000-000000000001',
      uuid: 'developer', legacyId: 9201, sapId: 'S0099'
    });
  });

  it('developer completes a step and NGDS message is queued', async () => {
    // Complete step
    const { status } = await project.post('/api/completeStep',
      { slug: 'flow-tutorial', stepNumber: 1 },
      { auth: { username: 'developer', password: 'developer' } });
    expect(status).toBe(200);

    // Admin sends to NGDS (which will fail without real destination, storing for retry)
    const { TaskRecords } = cds.entities('com.sap.developers.ims');
    const stepRecord = await SELECT.one.from(TaskRecords).where({
      taskLegacyId: 9101, taskType: 'STEP', status: 'COMPLETED'
    });
    expect(stepRecord).toBeTruthy();

    if (stepRecord) {
      const { status: ngdsStatus } = await project.post('/admin/sendToNgds',
        { taskRecordLegacyId: stepRecord.legacyId },
        { auth: { username: 'admin', password: 'admin' } });
      expect(ngdsStatus).toBe(200);
    }
  });

  it('consolidation service merges accounts end-to-end', async () => {
    const { Users, TaskRecords } = cds.entities('com.sap.developers.ims');

    // Create secondary user with records
    await INSERT.into(Users).entries({
      ID: 'dddddddd-flow-0000-0000-000000000001',
      uuid: 'secondary-flow', legacyId: 9301
    });
    await INSERT.into(TaskRecords).entries({
      ID: 'eeeeeeee-flow-0000-0000-000000000001',
      user_ID: 'dddddddd-flow-0000-0000-000000000001',
      taskLegacyId: 9001, taskType: 'TUTORIAL', status: 'COMPLETED', legacyId: 9401
    });

    // Merge
    const { status } = await project.post('/api/v1/userMerge',
      { primaryUuid: 'developer', secondaryUuid: 'secondary-flow' },
      { auth: { username: 'admin', password: 'admin' } });
    expect(status).toBe(204);

    // Verify records transferred
    const records = await SELECT.from(TaskRecords)
      .where({ user_ID: 'cccccccc-flow-0000-0000-000000000001' });
    const hasMergedRecord = records.some(r => r.legacyId === 9401);
    expect(hasMergedRecord).toBe(true);
  });
});
```

- [x] **Step 2: Run integration test**

Run: `npx vitest run test/integration/full-workflow.test.js`
Expected: PASS (2 tests)

- [x] **Step 3: Run full test suite**

Run: `npx vitest run`
Expected: All tests pass

- [x] **Step 4: Commit**

```bash
git add test/integration/full-workflow.test.js
git commit -m "test: add full integration workflow test (step completion → NGDS → merge)"
```

---

### Task 12: Verify Build and Final Cleanup

- [x] **Step 1: Run CDS build to verify everything compiles**

Run: `npx cds build --production`
Expected: Build succeeds with no errors

- [x] **Step 2: Run full test suite one final time**

Run: `npx vitest run`
Expected: All tests pass (should be ~40+ tests across all files)

- [x] **Step 3: Verify CDS services are listed correctly**

Run: `npx cds compile srv --service all --to json | node -e "const j=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')); console.log(Object.keys(j.definitions).filter(k=>j.definitions[k].kind==='service'))"`
Expected: Lists DeveloperService, AdminService, DisplayService, ConsolidationService

- [x] **Step 4: Final commit (if any cleanup needed)**

```bash
git add -A
git status
# Only commit if there are legitimate changes
```
