using { com.sap.developers.ims as ims } from '../db/channels';

@path    : '/channel-submissions'
@requires: 'authenticated-user'
service ChannelSubmissionService {

  // Insert-only: logged-in developers propose changes; they cannot read others' proposals.
  @insertonly
  entity Submissions as projection on ims.ChannelSubmissions;
}
