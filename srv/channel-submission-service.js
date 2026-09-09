import cds from '@sap/cds';
import * as alerting from './lib/alerting.js';

const LOG = cds.log('channel-submission');

// Pure alert builder (mirrors buildSecretExpiryAlerts / phaseToPayload): takes a
// freshly-created submission row and returns the ANS alert envelope to raise, or
// null. No I/O, so severity/subject/body are testable in isolation (#2198).
// A new community submission awaiting moderation is informational, not urgent →
// NOTICE, which routes to the devrel-deploys channel only (see package.json
// cds.requires.alerts.routes), never paging on-call.
export function buildChannelSubmissionAlert(submission = {}) {
  const kind = submission.kind;
  if (!kind) return null;
  const submitter = submission.submitterId || 'unknown';
  const target = submission.targetChannel_ID ? ` (target channel ${submission.targetChannel_ID})` : '';
  const rationale = (submission.rationale || '').trim();
  const bodyLines = [
    `A new ${kind} channel submission from ${submitter}${target} is awaiting approval.`,
  ];
  if (rationale) bodyLines.push(`Rationale: ${rationale.slice(0, 300)}`);
  bodyLines.push('Review it in the admin moderation queue: /admin-ui/#ChannelSubmissions-manage');
  return {
    eventType: 'ChannelSubmissionPending',
    severity: 'NOTICE',
    subject: `Channel submission awaiting approval: ${kind}`,
    body: bodyLines.join(' '),
  };
}

export default class ChannelSubmissionService extends cds.ApplicationService {
  async init() {
    // Stamp server-controlled fields; never trust client-sent status / reviewer / submitter.
    this.before('CREATE', 'Submissions', (req) => {
      // EDIT / REMOVE act on an existing channel — reject at submit time (400) instead of
      // letting the row sit PENDING only to fail at approve. ADD carries no target.
      if ((req.data.kind === 'EDIT' || req.data.kind === 'REMOVE') && !req.data.targetChannel_ID) {
        return req.reject(400, `A target channel is required for ${req.data.kind} submissions.`, 'targetChannel_ID');
      }
      req.data.submitterId = req.user.id;
      req.data.status = 'PENDING';
      req.data.reviewerId = null;
      req.data.reviewNote = null;
    });

    // #2198: notify DevRel when a new submission lands in the moderation queue.
    // Fire-and-forget beside the persisted row — alerting.raise is itself
    // fail-open (DB-gated, 5s-capped, never throws), so a degraded ANS path can
    // never break or slow the developer's submit. A per-ID resourceName keeps
    // each distinct submission outside the plugin's dedup window.
    this.after('CREATE', 'Submissions', (results, req) => {
      const submission = { ...req.data, ...(results || {}) };
      const alert = buildChannelSubmissionAlert(submission);
      if (!alert) return;
      const id = submission.ID || req.data?.ID || cds.utils.uuid();
      alerting
        .raise({ ...alert, category: 'ALERT', resource: { resourceName: `channel-submission-${id}`, resourceType: 'moderation-queue' } })
        .catch((err) => LOG.warn('channel-submission alert raise failed (swallowed):', err?.message ?? err));
    });

    await super.init();
  }
}
