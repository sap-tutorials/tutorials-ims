using AdminService from '../srv/admin-service';

// --- Change Tracking: entity identifiers and tracked fields ---

annotate AdminService.Events with @changelog: [name] @changelog.disable_facet {
  name      @changelog;
  startDate @changelog;
  endDate   @changelog;
  timeZone  @changelog;
};

annotate AdminService.Missions with @changelog: [title] @changelog.disable_facet {
  title              @changelog;
  description        @changelog;
  slug               @changelog;
  status             @changelog;
  experienceTag      @changelog;
  communityMissionId @changelog;
};

annotate AdminService.Accomplishments with @changelog: [name] @changelog.disable_facet {
  name        @changelog;
  description @changelog;
  rule        @changelog;
};

annotate AdminService.Prizes with @changelog: [name] @changelog.disable_facet {
  name @changelog;
};

annotate AdminService.ImsConfig with @changelog: [value] @changelog.disable_facet {
  ![key] @changelog;
  value  @changelog;
};

annotate AdminService.FeaturedTasks with @changelog: [taskLegacyId] {
  taskLegacyId  @changelog;
  taskType      @changelog;
  featuredOrder @changelog;
};
