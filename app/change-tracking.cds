using AdminService from '../srv/admin-service';

// --- Change Tracking: entity identifiers and tracked fields ---

annotate AdminService.Events with @changelog: [name] {
  name      @changelog;
  startDate @changelog;
  endDate   @changelog;
  timeZone  @changelog;
};

annotate AdminService.Missions with @changelog: [title] {
  title              @changelog;
  description        @changelog;
  slug               @changelog;
  status             @changelog;
  experienceTag      @changelog;
  communityMissionId @changelog;
};

annotate AdminService.Groups with @changelog: [title] {
  title         @changelog;
  description   @changelog;
  experienceTag @changelog;
};

annotate AdminService.Accomplishments with @changelog: [name] {
  name        @changelog;
  description @changelog;
  rule        @changelog;
};

annotate AdminService.Prizes with @changelog: [name] {
  name @changelog;
};

annotate AdminService.ImsConfig with @changelog: [value] {
  ![key] @changelog;
  value  @changelog;
};

annotate AdminService.FeaturedTasks with @changelog: [taskLegacyId] {
  taskLegacyId  @changelog;
  taskType      @changelog;
  featuredOrder @changelog;
};
