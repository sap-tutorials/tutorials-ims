---
title: External Integrations
description: GitHub, XSUAA, NGDS, Adobe Analytics, BTP Mail, AI Core, Audit Log, Cloud Logging, and CF API integration points.
---

# External Integrations

> Source: extracted from project README, 2026-05-25.

| System | Direction | Bound via | Purpose |
| --- | --- | --- | --- |
| GitHub `sap-tutorials` org (public) | Build-time | `GITHUB_TOKEN` (rate-limit avoidance) | Tutorial markdown source, discovered via `discoverAllTutorials()` |
| GitHub `*-Contribution` repos (private) | Build-time | `GITHUB_TOKEN` (required) | Validation quiz `rules.vr` files; QA channel content (`ONLY_CONTRIBUTION_REPOS=true`) |
| XSUAA / SAP IDP | Inbound | `tutorials-xsuaa` (`xsuaa/application`) | OAuth2 + JWT issuance; per-scope authorization (`Admin`, `MobileApp`, `DisplayApp`, `Tutorial.Author`, `ConsolidationScope`) |
| NGDS (legacy IMS analytics) | Outbound | `tutorials-destination` → `ngds` destination | `POST /ngds/developers/ims` on tutorial/accomplishment completion. Failed sends persisted in `NGDSFailedMessages`; `srv/jobs/ngds-retry.js` replays them with backoff |
| Adobe Analytics | Outbound | Direct fetch — no binding | XML beacon `event86` to `sap.d1.sc.omtrdc.net` (report suite `sapdeveloperdev`); see [srv/lib/adobe-analytics.js](../../../srv/lib/adobe-analytics.js) |
| BTP Mail | Outbound | `tutorials-mail` (`mail/standard`) | Contributor + author notifications via `srv/lib/mail-client.js`; failed sends queued in `FailedEmails` |
| SAP AI Core | Outbound | `tutorials-aicore` (`aicore/extended`, optional) | Chat completions for `ChatService` + RAG; embedding generation for `TutorialEmbedding`. Degrades to 503 when unbound |
| SAP Audit Log | Outbound | `tutorials-audit-log` (`auditlog/standard`, optional) | `@PersonalData`-driven access/modification events on `Users`/`UserMetaData`/`TaskRecords`; falls back to console sink when unbound |
| SAP Cloud Logging | Outbound | `tutorials-cloud-logging` (`cloud-logging/standard`, optional, `ingest_otlp.enabled=true`) | OTLP export; backs `cfLogsUrl` virtual on `PipelineLog`/`JobExecutionLog`. No-ops when unbound |
| SAP Cloud Foundry API | Outbound | `cf` CLI inside `migrate-from-hana.js` | Resolves `cf service-key` for cross-instance HANA migration (cutover only) |

#### Identity is JWT-only on CAP

The Java IMS calls SCI (SAP Cloud Identity) over HTTPS to enrich user profiles after JWT validation. CAP does **not** — `req.user.attr.email`/`given_name`/`family_name` come straight from the XSUAA JWT's `xs.user.attributes` claims, eliminating that network hop and the corresponding destination binding. SCI lookups remain in scope only for the `migrate-user-progress.js` script during cutover, which talks to Java IMS REST endpoints that still go through SCI on the Java side.
