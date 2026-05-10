using AdminService from '../srv/admin-service';

// --- Change Tracking: entity identifiers and tracked fields ---
// NavigationRestrictions suppress the inline ChangeHistory facet on ObjectPages
// while keeping change tracking active. Changes are viewed via the standalone ChangeLog report.

annotate AdminService.Events with @changelog: [name]
@Capabilities.NavigationRestrictions.RestrictedProperties: [{
  NavigationProperty: changes,
  ReadRestrictions   : { Readable: false }
}] {
  name      @changelog;
  startDate @changelog;
  endDate   @changelog;
  timeZone  @changelog;
};

annotate AdminService.Missions with @changelog: [title]
@Capabilities.NavigationRestrictions.RestrictedProperties: [{
  NavigationProperty: changes,
  ReadRestrictions   : { Readable: false }
}] {
  title              @changelog;
  description        @changelog;
  slug               @changelog;
  status             @changelog;
  experienceTag      @changelog;
  communityMissionId @changelog;
};

annotate AdminService.Groups with @changelog: [title]
@Capabilities.NavigationRestrictions.RestrictedProperties: [{
  NavigationProperty: changes,
  ReadRestrictions   : { Readable: false }
}] {
  title         @changelog;
  description   @changelog;
  experienceTag @changelog;
};

annotate AdminService.Accomplishments with @changelog: [name]
@Capabilities.NavigationRestrictions.RestrictedProperties: [{
  NavigationProperty: changes,
  ReadRestrictions   : { Readable: false }
}] {
  name        @changelog;
  description @changelog;
  rule        @changelog;
};

annotate AdminService.Prizes with @changelog: [name]
@Capabilities.NavigationRestrictions.RestrictedProperties: [{
  NavigationProperty: changes,
  ReadRestrictions   : { Readable: false }
}] {
  name @changelog;
};

annotate AdminService.ImsConfig with @changelog: [value]
@Capabilities.NavigationRestrictions.RestrictedProperties: [{
  NavigationProperty: changes,
  ReadRestrictions   : { Readable: false }
}] {
  ![key] @changelog;
  value  @changelog;
};

annotate AdminService.FeaturedTasks with @changelog: [taskLegacyId]
@Capabilities.NavigationRestrictions.RestrictedProperties: [{
  NavigationProperty: changes,
  ReadRestrictions   : { Readable: false }
}] {
  taskLegacyId  @changelog;
  taskType      @changelog;
  featuredOrder @changelog;
};
