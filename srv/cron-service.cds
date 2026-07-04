namespace com.sap.developers.ims;

// Internal scheduling bus. NOT exposed on any protocol — no @path, no
// @requires, no @odata/@rest annotations. Only used as a target for
// srv.schedule(...).every(...).as(...) calls originating from
// srv/jobs/scheduler.js. All 32 registered jobs land here as
// events named 'cron.<jobName>'.
//
// Migration spec: docs/superpowers/specs/2026-07-04-958-cap10-scheduler-migration-design.md
service CronService {}
