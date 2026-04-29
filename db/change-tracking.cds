using { sap.changelog.aspect as changelog } from '@cap-js/change-tracking';
using { com.sap.developers.ims as ims } from './schema';

extend ims.Events with changelog;
extend ims.Missions with changelog;
extend ims.Groups with changelog;
extend ims.Accomplishments with changelog;
extend ims.Prizes with changelog;
extend ims.ImsConfig with changelog;
extend ims.FeaturedTasks with changelog;
