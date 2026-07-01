---
title: Developers
description: Building and maintaining the SAP Tutorial Platform — architecture, operations, and reference for platform engineers.
---

# Developers — Building and Maintaining the Platform

You're in the right place if you're a platform engineer working on the tutorials-ims codebase: the CAP backend, AppRouter, Hugo site, build pipeline, deployment, or anything else under `srv/`, `app/`, `hugo/`, `approuter/`, or `scripts/`.

## Start here

- **[Getting Started](getting-started.md)** — local dev setup, folder map, scripts reference, environment variables. Read this first if you're new.

## Architecture

How the platform fits together. Read these when you need to understand a subsystem before changing it.

- [Authentication](architecture/authentication.md) — IdP → JWT → user resolution
- [Runtime Architecture](architecture/runtime.md) — request flow, AppRouter, CAP
- [Build Architecture](architecture/build.md) — fetch → parse → Hugo → publish
- [Joule Architecture](architecture/joule.md) — chat, tools, RAG, embeddings
- [Joule Aurora Background](architecture/joule-aurora.md) — aurora mesh background animation (#392)
- [CAP Backend](architecture/cap-backend.md) — services, entities, jobs, bootstrap
- [Frontend Apps](architecture/frontend-apps.md) — admin shell, scanner, display

## Operations

Runbooks and operational references. Read these when you need to deploy, test, or configure.

- [MTA Deployment](operations/mta-deployment.md) — full deploy procedure
- [Deployment Topology](operations/deployment.md) — what runs where
- [BTP Destinations (SCI / NGDS)](operations/btp-destinations.md) — destination names + PassVault links
- [Testing Guide](operations/testing-guide.md) — unit, hybrid, smoke
- [Testing Endpoints](operations/testing-endpoints.md) — UI + API endpoint reference
- [Live Probing](operations/live-probing.md) — verify fixes against the real binding before deploying
- [Production Readiness](operations/production-ready.md) — services and entitlements
- [QA Channel Bootstrap](operations/qa-channel-bootstrap.md) — author preview channel
- [Joule Chat Admin Settings](operations/joule-chat-admin-settings.md) — RAG and grounding
- [GitHub App Setup](operations/github-app-setup.md) — sap-tutorials-builder App
- [IAS Setup](operations/ias-setup.md) — Option A/B authentication on a subaccount

## Reference

Topics that aren't on a critical path but matter when you go looking.

- [CAP / CDS Gotchas](reference/cap-cds-gotchas.md) — discovered failure modes in CAP services, CDS models, drafts, audit-logging, OData
- [HANA / HDI / SQL Gotchas](reference/hana-hdi-gotchas.md) — discovered failure modes in HANA SQL, HDI deploy artifacts, SPARQL, hdbgrants
- [Vue Islands / Hugo / Vite Gotchas](reference/vue-islands-gotchas.md) — discovered failure modes in the frontend pipeline
- [Theme Variants](reference/theme-variants.md) — building event themes on Fiori Horizon
- [AI Consumption](reference/ai-consumption.md) — making developers.sap.com AI-friendly
- [Cookie & Storage Analysis](reference/cookie-and-storage-analysis.md) — auditor's reference
- [Sage Extension Migration](reference/sage-extension-migration.md) — VS Code extension coupling
- [External Integrations](reference/external-integrations.md) — what we integrate with
- [Key Design Decisions](reference/design-decisions.md) — why the platform looks the way it does
- [Architecture Decision Records](../decisions/README.md) — canonical, single-topic records with status and consequences
