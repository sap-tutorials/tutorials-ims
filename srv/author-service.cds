using { com.sap.developers.ims as ims } from '../db/schema';
using from '../db/views';

@path: '/author'
@requires: 'Tutorial.Author'
service AuthorService {

  @Capabilities.ChangeTracking : { Supported: true }
  @readonly entity Tutorials as projection on ims.Tutorials {
    ID, slug, title, primaryTag, status
  };

  @Capabilities.ChangeTracking : { Supported: true }
  @readonly entity Tags as projection on ims.Tags;

  @Capabilities.ChangeTracking : { Supported: true }
  @readonly entity MyTutorials as projection on ims.MyTutorialsView;

  action reviewTutorial(tutorialId : UUID) returns {
    reviewedDate       : Timestamp;
    notificationNumber : Integer;
  };

  action snoozeTutorial(tutorialId : UUID, days : Integer) returns {
    lastNotificationDate : Timestamp;
    notificationNumber   : Integer;
  };
}
