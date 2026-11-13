using { com.sap.developers.ims as ims } from './schema';
using { com.sap.developers.ims.external as ext } from './external-content';

// Deploy as .hdbmigrationtable for schema evolution (ALTER TABLE instead of DROP+CREATE)
annotate ims.Tutorials with @cds.persistence.journal;
annotate ims.Missions with @cds.persistence.journal;
annotate ims.Groups with @cds.persistence.journal;
annotate ims.Steps with @cds.persistence.journal;
annotate ims.Checkpoints with @cds.persistence.journal;
annotate ims.Puzzles with @cds.persistence.journal;
annotate ims.Petoberfests with @cds.persistence.journal;
annotate ims.PetSubmissions with @cds.persistence.journal;
annotate ims.GridTemplates with @cds.persistence.journal;
annotate ims.Users with @cds.persistence.journal;
annotate ims.TaskRecords with @cds.persistence.journal;
annotate ims.UserMetaData with @cds.persistence.journal;
annotate ims.DeveloperEnvironmentTabs with @cds.persistence.journal;
annotate ims.DeveloperEnvironmentLinks with @cds.persistence.journal;
annotate ims.Events with @cds.persistence.journal;
annotate ims.Prizes with @cds.persistence.journal;
annotate ims.PrizeRecords with @cds.persistence.journal;
annotate ims.Tags with @cds.persistence.journal;
annotate ims.TutorialTags with @cds.persistence.journal;
annotate ims.Accomplishments with @cds.persistence.journal;
annotate ims.AccomplishmentRecords with @cds.persistence.journal;
annotate ims.CompletionPaths with @cds.persistence.journal;
annotate ims.CompletionPathItems with @cds.persistence.journal;
annotate ims.TutorialMeta with @cds.persistence.journal;
annotate ims.TutorialContributors with @cds.persistence.journal;
annotate ims.TutorialVariables with @cds.persistence.journal;
annotate ims.TutorialRepositories with @cds.persistence.journal;
annotate ims.ActiveLearnerRecords with @cds.persistence.journal;
annotate ims.DashboardMonitoredRecords with @cds.persistence.journal;
annotate ims.StepFailures with @cds.persistence.journal;
annotate ims.NGDSFailedMessages with @cds.persistence.journal;
annotate ims.ImsConfig with @cds.persistence.journal;
annotate ims.JobLocks with @cds.persistence.journal;
annotate ims.PrimaryAccounts with @cds.persistence.journal;
annotate ims.SecondaryAccounts with @cds.persistence.journal;
annotate ims.PrivacyProtectionActions with @cds.persistence.journal;
annotate ims.FeaturedTasks with @cds.persistence.journal;
annotate ims.FailedEmails with @cds.persistence.journal;
annotate ims.ContentFiles with @cds.persistence.journal;
annotate ims.ContentManifest with @cds.persistence.journal;
annotate ims.ChatSettings with @cds.persistence.journal;
annotate ims.GroupSlugRedirects with @cds.persistence.journal;
annotate ims.MissionSlugRedirects with @cds.persistence.journal;
annotate ims.UIEvent with @cds.persistence.journal;
annotate ims.DevtoberfestConfig with @cds.persistence.journal;
annotate ims.EventRegistrations with @cds.persistence.journal;
annotate ims.CatGameAwards with @cds.persistence.journal;   // #2042 Hit-the-Cat daily points ledger
// #805 — Observability
annotate ims.MetricSnapshots with @cds.persistence.journal;
annotate ims.PublishTimings with @cds.persistence.journal;
annotate ims.TutorialValidationRules with @cds.persistence.journal;
annotate ims.Channels with @cds.persistence.journal;
annotate ims.ChannelCollections with @cds.persistence.journal;
annotate ims.ChannelCollectionItems with @cds.persistence.journal;
annotate ims.ChannelTopicMap with @cds.persistence.journal;
annotate ims.ChannelSubmissions with @cds.persistence.journal;
annotate ims.KttLessons with @cds.persistence.journal;
// #2552 identity-linkage: this container's .hdiconfig maps only hdbmigrationtable
// (no plain-hdbtable plugin), so a persisted entity MUST be journaled to deploy.
annotate ims.UserIdentities with @cds.persistence.journal;

// #2810 — Knowledge-graph tables were never journaled, so (per the .hdiconfig
// note above) their plain .hdbtable artifacts were silently ignored by HDI and
// no KG schema change ever deployed; the live tables are pre-restriction fossils.
// Journal them so they deploy as .hdbmigrationtable and schema changes land.
// (embeddingVec stays a Node-written plain column — see concept-embedding-backfill.js.)
annotate ims.Concepts with @cds.persistence.journal;
annotate ims.TutorialConceptLinks with @cds.persistence.journal;
annotate ims.ConceptEdges with @cds.persistence.journal;
annotate ims.ConceptAliases with @cds.persistence.journal;
annotate ims.GraphMetadata with @cds.persistence.journal;
annotate ims.CoCompletions with @cds.persistence.journal;
annotate ims.ConceptRank with @cds.persistence.journal;
annotate ims.TutorialRank with @cds.persistence.journal;
annotate ims.HomepageFeaturedTopics with @cds.persistence.journal;
annotate ims.FeaturedTopicsSnapshot with @cds.persistence.journal;

// External-namespace concept-link tables (com.sap.developers.ims.external).
annotate ext.LearningJourneyConceptLinks with @cds.persistence.journal;
annotate ext.BlogPostConceptLinks with @cds.persistence.journal;
annotate ext.DiscoveryMissionConceptLinks with @cds.persistence.journal;
annotate ext.VideoConceptLinks with @cds.persistence.journal;
annotate ext.ApiDocConceptLinks with @cds.persistence.journal;
annotate ext.SampleConceptLinks with @cds.persistence.journal;
annotate ext.HelpDocConceptLinks with @cds.persistence.journal;
annotate ext.CommunityEventConceptLinks with @cds.persistence.journal;
annotate ext.DevtoberfestSessionConceptLinks with @cds.persistence.journal;
annotate ext.TechEdSessionConceptLinks with @cds.persistence.journal;

// #3130 — Same systemic bug as #2810: the external-content PARENT tables were
// never journaled, so (per the .hdiconfig note above — this container maps only
// hdbmigrationtable, no plain hdbtable) their .hdbtable artifacts were silently
// ignored by HDI and no schema change to any of them ever deployed. The live
// tables are pre-restriction fossils, frozen at an old deploy's shape. Journal
// them so they deploy as .hdbmigrationtable and future schema changes land.
// Data-preserving: the legacy src/gen/*.hdbtable paths are added to
// db/undeploy.json, so HDI adopts each populated table as migration v1 with no
// DDL and no data loss (the #2810 mechanism, proven zero-loss on DEV + PROD).
annotate ext.LearningJourneys with @cds.persistence.journal;
annotate ext.LearningJourneyPrerequisites with @cds.persistence.journal;
annotate ext.BlogPosts with @cds.persistence.journal;
annotate ext.DiscoveryMissions with @cds.persistence.journal;
annotate ext.DiscoveryMissionServices with @cds.persistence.journal;
annotate ext.Videos with @cds.persistence.journal;
annotate ext.VideoServices with @cds.persistence.journal;
annotate ext.ApiDocs with @cds.persistence.journal;
annotate ext.Samples with @cds.persistence.journal;
annotate ext.HelpDocs with @cds.persistence.journal;
annotate ext.CommunityEvents with @cds.persistence.journal;
annotate ext.NewsItems with @cds.persistence.journal;
annotate ext.RelevanceSeedExemplars with @cds.persistence.journal;
annotate ext.DevtoberfestSessions with @cds.persistence.journal;
annotate ext.TechEdSessions with @cds.persistence.journal;
annotate ext.TechEdSpeakers with @cds.persistence.journal;
annotate ext.TechEdTracks with @cds.persistence.journal;
annotate ext.TechEdSessionSpeakers with @cds.persistence.journal;
