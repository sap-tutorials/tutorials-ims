import cds from '@sap/cds';
import { getDestination } from '@sap-cloud-sdk/connectivity';

// NGDS (SAP internal analytics/badging) outbound client.
//
// The payload MUST match the legacy Java IMS contract byte-for-byte, because
// the NGDS receiver joins incoming events against IMS reference data by the
// exact JSON keys below. The pre-#1471 CAP payload used ad-hoc camelCase keys
// (`taskId`, `timestamp`, `title`) that NGDS could not match — tutorials were
// mismatched on key name/type and missions were unmatchable entirely because
// the receiver keys missions on `imsData.CommunityID`, which we never sent.
//
// Ground truth for every field/key below:
//   com.sap.developers.ims (Java) NGDSSenderServiceImpl.java + model/ngds/*.java
//     MessageModel  → { context, trackingInfo, imsData, interactionData, isSmcServiceEnabled }
//     Context       → adobe_id, user_id
//     TrackingInfo  → tracking, url, eventDate
//     ImsData       → IMSID, IMSName, InquiryType, CommunityID
//     InteractionData → INTEREST_ITEM, IA_TYPE, COMM_MEDIUM, IA_REASON,
//                       SYSTEM_ID, SiteLanguage, ContentLanguage
//
// Gson (the Java serializer) omits null fields by default (no serializeNulls),
// so we OMIT absent fields here rather than emit `null` — matching the exact
// wire shape the receiver has always seen.

const NGDS_PATH = '/ngds/developers/ims';

// TaskType.getName() from the legacy enum (title-case display names). Used for
// imsData.InquiryType. Distinct from the IA_REASON suffix, which uses the
// UPPERCASE enum name (TaskType.toString()).
const INQUIRY_TYPE_BY_TASK_TYPE = {
  TUTORIAL: 'Tutorial',
  MISSION: 'Mission',
  GROUP: 'Group',
  STEP: 'Step',
  CHECKPOINT: 'Checkpoint',
};

// Format an ISO timestamp to the legacy NGDS_DATE_FORMAT: yyyy-MM-dd'T'HH:mm:ss.SSS
// (no timezone suffix — matches DateTimeFormatter.ofPattern used in Java).
// Returns undefined for a falsy/invalid input so the field is omitted.
export function formatNgdsDate(input) {
  if (!input) return undefined;
  const d = new Date(input);
  if (Number.isNaN(d.getTime())) return undefined;
  // toISOString() → "2026-04-28T10:30:00.000Z"; strip the trailing "Z" to match
  // the zone-less legacy pattern with millisecond precision.
  return d.toISOString().replace(/Z$/, '');
}

// Only set a key when the value is present — mirrors Gson's default null-omission
// so the wire shape matches the legacy sender exactly.
function put(obj, key, value) {
  if (value !== undefined && value !== null && value !== '') obj[key] = value;
  return obj;
}

/**
 * Build the NGDS MessageModel from already-resolved fields. Pure — all DB
 * lookups happen in the caller (resolveTaskRecordNgdsFields). Field names and
 * defaults reproduce the legacy Java MessageModel exactly.
 *
 * @param {object} f
 * @param {string} f.userId        SCI/IAS uid → context.user_id (CAP: Users.sapId)
 * @param {string} [f.adobeId]     visitor id → context.adobe_id (omitted if absent)
 * @param {string} [f.tracking]    submissionId → trackingInfo.tracking (dedup key)
 * @param {string} [f.eventDate]   pre-formatted (formatNgdsDate) → trackingInfo.eventDate
 * @param {string|number} f.imsId  task legacy id → imsData.IMSID (emitted as STRING)
 * @param {string} [f.imsName]     task title → imsData.IMSName
 * @param {string} f.taskType      raw enum (TUTORIAL|MISSION|GROUP|...) — drives InquiryType + IA_REASON
 * @param {string} [f.communityId] missions only → imsData.CommunityID
 * @param {boolean} f.completed    true → COMP, false → START (drives IA_REASON prefix)
 * @param {string} [f.interestItem] pipe-joined semaphore ids → interactionData.INTEREST_ITEM
 * @param {string} [f.contentLanguage]
 * @param {string} [f.siteLanguage]
 */
export function buildNgdsPayload(f = {}) {
  const context = {};
  put(context, 'adobe_id', f.adobeId);
  put(context, 'user_id', f.userId);

  const trackingInfo = { url: 'https://developers.sap.com' };
  put(trackingInfo, 'tracking', f.tracking);
  put(trackingInfo, 'eventDate', f.eventDate);

  const imsData = {};
  // IMSID is a STRING in the legacy contract (String.valueOf(task.getId())).
  put(imsData, 'IMSID', f.imsId === undefined || f.imsId === null ? undefined : String(f.imsId));
  put(imsData, 'IMSName', f.imsName);
  put(imsData, 'InquiryType', INQUIRY_TYPE_BY_TASK_TYPE[f.taskType] || f.taskType);
  // Missions match on CommunityID. Legacy falls back to the task id (as string)
  // when communityMissionId is empty; the caller applies that fallback.
  put(imsData, 'CommunityID', f.communityId === undefined || f.communityId === null ? undefined : String(f.communityId));

  const eventPrefix = f.completed ? 'COMP' : 'START';
  const interactionData = {
    IA_TYPE: 'YY_DEV_WEB_IA',
    COMM_MEDIUM: 'WEB',
    IA_REASON: `${eventPrefix}_DEV_${String(f.taskType || '').toUpperCase()}`,
    SYSTEM_ID: 'Developers',
  };
  put(interactionData, 'INTEREST_ITEM', f.interestItem);
  put(interactionData, 'SiteLanguage', f.siteLanguage);
  put(interactionData, 'ContentLanguage', f.contentLanguage);

  return {
    context,
    trackingInfo,
    imsData,
    interactionData,
    isSmcServiceEnabled: false,
  };
}

// Resolve the parent task (Tutorial/Mission/Group) for a TaskRecord and collect
// the NGDS-relevant fields the legacy sender pulled from the JPA graph:
//   - imsName        (task title; falls back to the record's titleSnapshot)
//   - communityId    (missions: communityMissionId || String(taskLegacyId))
//   - interestItem   (up to 3 pipe-joined semaphoreIds of interest-item tags)
// Returns {} for unknown/unsupported task types so the payload still builds.
async function resolveTaskContext(record, db) {
  const { Tutorials, Missions, Groups, Tags } = cds.entities('com.sap.developers.ims');
  const legacyId = record.taskLegacyId;

  async function interestItemsFor(tagLinkEntity, fkColumn, ownerId) {
    // tagLinkEntity rows carry (owner, tag) associations; resolve the linked
    // Tags and keep the interest-item ones' semaphoreIds (max 3, pipe-joined),
    // matching NGDSSenderServiceImpl.getInterestItems.
    const links = await db.run(
      SELECT.from(tagLinkEntity).columns('tag_ID').where({ [fkColumn]: ownerId })
    );
    const tagIds = links.map(l => l.tag_ID).filter(Boolean);
    if (tagIds.length === 0) return undefined;
    const tags = await db.run(
      SELECT.from(Tags).columns('semaphoreId', 'isInterestItem').where({ ID: { in: tagIds } })
    );
    const items = tags
      .filter(t => t.isInterestItem && t.semaphoreId)
      .map(t => t.semaphoreId)
      .slice(0, 3);
    return items.length ? items.join('|') : undefined;
  }

  if (record.taskType === 'TUTORIAL') {
    const tut = await db.run(SELECT.one.from(Tutorials).columns('ID', 'title').where({ legacyId }));
    if (!tut) return { imsName: record.titleSnapshot };
    const { TutorialTags } = cds.entities('com.sap.developers.ims');
    return {
      imsName: tut.title || record.titleSnapshot,
      interestItem: await interestItemsFor(TutorialTags, 'tutorial_ID', tut.ID),
    };
  }

  if (record.taskType === 'MISSION') {
    const m = await db.run(
      SELECT.one.from(Missions).columns('ID', 'title', 'communityMissionId').where({ legacyId })
    );
    if (!m) return { imsName: record.titleSnapshot, communityId: legacyId };
    const { MissionTags } = cds.entities('com.sap.developers.ims');
    return {
      imsName: m.title || record.titleSnapshot,
      // Legacy: communityMissionId when set, else the task id (as string).
      communityId: m.communityMissionId || legacyId,
      interestItem: await interestItemsFor(MissionTags, 'mission_ID', m.ID),
    };
  }

  if (record.taskType === 'GROUP') {
    const g = await db.run(SELECT.one.from(Groups).columns('ID', 'title').where({ legacyId }));
    if (!g) return { imsName: record.titleSnapshot };
    const { GroupTags } = cds.entities('com.sap.developers.ims');
    return {
      imsName: g.title || record.titleSnapshot,
      interestItem: await interestItemsFor(GroupTags, 'group_ID', g.ID),
    };
  }

  return { imsName: record.titleSnapshot };
}

/**
 * Assemble the full NGDS payload for a persisted TaskRecord by resolving the
 * parent task, the user identity, and the visitor id. Shared by the manual
 * admin action and (future) automatic completion trigger.
 */
export async function resolveTaskRecordNgdsFields(record, db) {
  const { Users, UserMetaData } = cds.entities('com.sap.developers.ims');

  const user = record.user_ID
    ? await db.run(SELECT.one.from(Users).columns('ID', 'sapId', 'uuid').where({ ID: record.user_ID }))
    : null;

  // context.adobe_id came from UserMetaData.visitorId in legacy IMS. CAP stores
  // UserMetaData as key/value rows; look up the 'visitorId' key if present.
  let adobeId;
  if (user?.ID) {
    const meta = await db.run(
      SELECT.one.from(UserMetaData).columns('value').where({ user_ID: user.ID, key: 'visitorId' })
    );
    adobeId = meta?.value || undefined;
  }

  const taskCtx = await resolveTaskContext(record, db);
  const completed = record.status === 'COMPLETED';

  return buildNgdsPayload({
    // Legacy context.user_id = SCI uid; CAP's equivalent is Users.sapId.
    userId: user?.sapId || user?.uuid,
    adobeId,
    // Dedup key. CAP does not yet populate submission ids on most write paths;
    // omitted when absent (Gson-default behavior) — see the tracking gap note
    // in the PR/report.
    tracking: completed ? record.submissionIdCompleted : record.submissionIdStarted,
    eventDate: formatNgdsDate(record.completionDate || record.modifiedAt),
    imsId: record.taskLegacyId,
    imsName: taskCtx.imsName,
    taskType: record.taskType,
    communityId: taskCtx.communityId,
    completed,
    interestItem: taskCtx.interestItem,
    contentLanguage: record.contentLanguage,
    siteLanguage: record.siteLanguage,
  });
}

// ---------------------------------------------------------------------------
// Manual token handling for NGDS
//
// `ngds-destination` is a BasicAuthentication destination (user `ims-user` @
// https://api2.services.sap.com). NGDS itself requires a two-step call that the
// BTP destination adapter does not perform: first Basic-auth the destination's
// username/password against the SAP auth-service to obtain a JWT, then send that
// JWT as a Bearer token to the NGDS payload endpoint. So we read the resolved
// credentials off the SDK Destination object and do both steps ourselves.
//
// Verified against the working manual curl (Tom, 2026-08-13):
//   POST {tokenUrl}?grant_type=client_credentials
//     Authorization: Basic base64(user:pass)   -> { access_token, ... }
//   POST {baseUrl}/ngds/developers/ims
//     Authorization: Bearer {access_token}
// ---------------------------------------------------------------------------

// Module-level token cache — one per process (CF worker).
let _cachedToken = null;   // { accessToken: string, expiresAt: number } | null
let _inflightFetch = null; // Promise<{accessToken,expiresAt}> | null — deduplicates concurrent refreshes

async function _fetchToken({ user, pass, tokenUrl } = {}) {
  const rawUrl = (tokenUrl || '').trim();
  if (!rawUrl || !user || !pass) {
    throw new Error(
      'ngds-destination missing token credentials (username/password) or token URL'
    );
  }
  // The auth-service token endpoint requires grant_type as a query param.
  const url = rawUrl.includes('grant_type')
    ? rawUrl
    : rawUrl + (rawUrl.includes('?') ? '&' : '?') + 'grant_type=client_credentials';

  const basic = Buffer.from(`${user}:${pass}`).toString('base64');
  const ac = new AbortController();
  const tid = setTimeout(() => ac.abort(), 10_000);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Basic ${basic}`, Accept: 'application/json' },
      signal: ac.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`NGDS token fetch HTTP ${res.status}: ${body.slice(0, 200)}`);
    }
    const data = await res.json();
    if (!data.access_token) throw new Error('NGDS token response missing access_token');
    // Refresh 60 s before nominal expiry to avoid edge-expiry 401s.
    const expiresAt = Date.now() + ((data.expires_in ?? 3600) - 60) * 1_000;
    return { accessToken: data.access_token, expiresAt };
  } finally {
    clearTimeout(tid);
  }
}

async function _getToken(creds) {
  if (_cachedToken && Date.now() < _cachedToken.expiresAt) return _cachedToken.accessToken;
  // Share a single in-flight request across concurrent callers.
  if (!_inflightFetch) {
    _inflightFetch = _fetchToken(creds)
      .then(t => { _cachedToken = t; return t; })
      .finally(() => { _inflightFetch = null; });
  }
  return (await _inflightFetch).accessToken;
}

function _invalidateToken() {
  _cachedToken = null;
  _inflightFetch = null; // abandon any in-flight fetch — next caller starts fresh
}

// Send a pre-built payload to NGDS.
// Resolves the 'ngds-destination' BTP destination, Basic-auths its
// username/password against the auth-service to fetch a JWT, then POSTs the
// payload with that JWT as a Bearer token.  Retries once on 401 after
// invalidating the token cache.  Exported so ngds-retry.js can call it directly.
export async function postPayload(payload) {
  const dest = await getDestination({ destinationName: 'ngds-destination' });
  if (!dest) throw new Error("Destination 'ngds-destination' not found");

  // getDestination() returns a normalized SDK Destination — there is NO
  // `dest.destinationConfiguration` (that shape only exists on the raw
  // destination-service REST response). For the BasicAuthentication
  // ngds-destination the creds are dest.username/dest.password. Fall back to
  // OAuth2* client creds and originalProperties in case it is reconfigured.
  const op = dest.originalProperties ?? {};
  const user = dest.username ?? dest.clientId ?? op.User ?? op.clientId;
  const pass = dest.password ?? dest.clientSecret ?? op.Password ?? op.clientSecret;
  const baseUrl = (dest.url ?? op.URL ?? '').replace(/\/$/, '');
  if (!baseUrl) throw new Error("ngds-destination has no URL");
  // Token endpoint: an explicit tokenServiceUrl if the destination carries one,
  // else the SAP auth-service on the same host (matches the working curl).
  const tokenUrl = dest.tokenServiceUrl ?? op.tokenServiceURL ?? op.tokenServiceUrl
    ?? (baseUrl + '/auth-service/oauth/token');

  const creds = { user, pass, tokenUrl };
  const url = baseUrl + NGDS_PATH;

  const doPost = async (token) => {
    const ac = new AbortController();
    const tid = setTimeout(() => ac.abort(), 15_000);
    try {
      return await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify(payload),
        signal: ac.signal,
      });
    } finally {
      clearTimeout(tid);
    }
  };

  let token = await _getToken(creds);
  let res = await doPost(token);

  if (res.status === 401) {
    // Token may have been revoked or expired slightly early — refresh once.
    _invalidateToken();
    token = await _getToken(creds);
    res = await doPost(token);
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`NGDS POST HTTP ${res.status}: ${body.slice(0, 200)}`);
  }
}

/**
 * Send a persisted TaskRecord to NGDS. Resolves the full legacy-shaped payload,
 * posts it, and queues it in NGDSFailedMessages on failure for the retry job.
 */
export async function sendTaskRecordToNgds(record, db) {
  const { NGDSFailedMessages } = cds.entities('com.sap.developers.ims');
  const database = db || await cds.connect.to('db');
  const payload = await resolveTaskRecordNgdsFields(record, database);

  try {
    await postPayload(payload);
    return { success: true };
  } catch (err) {
    cds.log('ngds').error('NGDS send failed, storing for retry:', err.message);
    await INSERT.into(NGDSFailedMessages).entries({
      payload: JSON.stringify(payload),
      errorMessage: err.message,
      createdAt: new Date().toISOString(),
      retryCount: 0,
      status: 'PENDING',
    });
    return { success: false, error: err.message };
  }
}
