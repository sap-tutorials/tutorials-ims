using { com.sap.developers.ims.qa as qa } from '../db-qa/schema';

@path: '/search'
@requires: 'Tutorial.Author'
service SearchService {

  // CAP runtime handles $search natively. @cds.search restricts which
  // columns are matched; bodyText is the only meaningful field here.
  @readonly
  @cds.search: { bodyText }
  entity Tutorials as projection on qa.TutorialBodyText;
}
