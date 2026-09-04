import cds from '@sap/cds';

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
    await super.init();
  }
}
