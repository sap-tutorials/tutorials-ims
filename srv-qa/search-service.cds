using { com.sap.developers.ims.qa as qa } from '../db-qa/schema';
// Required so the @cap-js/change-tracking plugin's deploySQLiteTriggers()
// finds sap.changelog.Changes in the in-memory db during unit tests.
using from '@cap-js/change-tracking';

@path: '/search'
@requires: 'Tutorial.Author'
service SearchService {

  // CAP runtime handles $search natively. @cds.search restricts which
  // columns are matched; bodyText is the only meaningful field here.
  @readonly
  @cds.search: { bodyText }
  entity Tutorials as projection on qa.TutorialBodyText;
}
