import cds from '@sap/cds';

export default class ChannelSubmissionService extends cds.ApplicationService {
  async init() {
    // Stamp server-controlled fields; never trust client-sent status / reviewer / submitter.
    this.before('CREATE', 'Submissions', (req) => {
      req.data.submitterId = req.user.id;
      req.data.status = 'PENDING';
      req.data.reviewerId = null;
      req.data.reviewNote = null;
    });
    await super.init();
  }
}
