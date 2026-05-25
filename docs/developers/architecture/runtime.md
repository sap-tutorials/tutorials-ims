---
title: Runtime Architecture
description: How traffic flows once the platform is deployed — AppRouter, CAP services, HANA, WebSocket transport.
---

# Runtime Architecture
> Source: extracted from project README, 2026-05-25.

How traffic flows once the platform is deployed. Build-time data flow is in the next section.

```mermaid
flowchart LR
    subgraph clients[Clients]
        Browser["Browsers<br/>developers.sap.com"]
        Author["Authors<br/>(Tutorial.Author scope)"]
        Mobile["Scanner devices<br/>(MobileApp scope)"]
        Monitor["Event display monitors"]
        VSCode["SAP Tutorials<br/>VSCode Extension"]
        Publisher["GitHub Actions<br/>publish-content"]
    end

    subgraph btp[SAP BTP Cloud Foundry / DevRel subaccount]
        AR["tutorials-approuter<br/>static + XSUAA route auth"]
        XSUAA[("XSUAA<br/>SAP IDP")]

        subgraph prodLane[Production lane]
            SRV["tutorials-srv<br/>CAP Node.js<br/>(9 services + jobs + Socket.IO)"]
            HANA[("tutorials-hana<br/>HDI container")]
        end

        subgraph qaLane["QA author-preview lane (Tutorial.Author)"]
            SRVQA["tutorials-srv-qa<br/>CAP + Hugo preview renderer"]
            HANAQA[("tutorials-hana-qa<br/>HDI container")]
        end

        subgraph backing[Managed services]
            DEST["Destination"]
            MAIL["BTP Mail"]
            AUDIT["Audit Log"]
            CLOG["Cloud Logging"]
            AI["AI Core<br/>(Joule + embeddings)"]
        end
    end

    subgraph external[External systems]
        GH["GitHub<br/>raw.githubusercontent.com<br/>(tutorial images)"]
        NGDS["NGDS analytics"]
        ADOBE["Adobe Analytics"]
        SCI["SCI / IDP"]
        SMTP["SMTP relay"]
    end

    Browser -->|"/, /tutorials/*, /api/*<br/>/chat/*, /search/*"| AR
    Author -->|"/tutorials-qa/*, /qa-search/*<br/>/admin-ui/, /analytics-ui/"| AR
    Mobile -->|"/scanner-ui/, /scanner/*"| AR
    Monitor -.->|"Socket.IO<br/>/ws/display"| SRV
    VSCode ==>|"POST /preview/render<br/>direct, bearer JWT"| SRVQA
    Publisher ==>|"POST /content/publish<br/>bearer CONTENT_API_KEY"| SRV
    Publisher ==>|"POST /content/publish<br/>bearer CONTENT_API_KEY_QA"| SRVQA

    AR --> XSUAA
    AR -->|"destination<br/>srv-api"| SRV
    AR -->|"destination<br/>srv-qa-api"| SRVQA

    SRV --> HANA
    SRVQA --> HANAQA
    SRV --> AI
    SRVQA --> AI
    SRV --> DEST
    SRV --> MAIL
    SRV --> AUDIT
    SRV --> CLOG
    SRVQA --> CLOG

    SRV -.->|tutorial completion| NGDS
    SRV -.->|event86 beacons| ADOBE
    DEST -.-> SCI
    MAIL -.-> SMTP
    Browser -.->|images CDN| GH

    classDef ext fill:#f4f4f4,stroke:#888,color:#333
    class GH,NGDS,ADOBE,SCI,SMTP ext
```

**Notes:**

- **Approuter is the only XSUAA-protected entry point for browser traffic.** Each route declares its scope (`MobileApp`, `Admin`, `DisplayApp`, `ConsolidationScope`, `Tutorial.Author`) — see [approuter/xs-app.json](approuter/xs-app.json). Public routes (`/build/*`, `/feedback/*`, `/health`, `/.well-known/*`, `/ord/*`, `/content/*`, `/tutorials/*`) bypass auth.
- **Display monitors** connect via Socket.IO directly to `tutorials-srv` (`/ws/display` namespace, approuter route `^/socket\.io/` with `authenticationType: 'none'`); the `DisplayApp` scope check happens at the CAP WebSocket plugin layer when joining the namespace.
- **VSCode Author Preview** posts raw markdown to `tutorials-srv-qa`'s `POST /preview/render` directly with its own JWT — no approuter route wired (see [docs/superpowers/specs/2026-05-23-vscode-author-preview-design.md](docs/superpowers/specs/2026-05-23-vscode-author-preview-design.md)).
- **Two HDI containers** isolate prod and QA author content. `db/` deploys to `tutorials-hana`; `db-qa/` deploys to `tutorials-hana-qa`. Schemas drift-checked by `.github/workflows/schema-drift-check.yml`.
- **Tutorial HTML lives in HANA**, not static files — `tutorials-approuter` rewrites `/tutorials/*` to `/content/tutorials/*` on the CAP srv, which decompresses gzipped BLOBs from `ContentFiles`.
