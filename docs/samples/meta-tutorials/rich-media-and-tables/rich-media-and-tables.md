---
parser: v2
auto_validation: true
time: 30
tags: [ tutorial>beginner, software-product>sap-btp ]
primary_tag: software-product>sap-btp
author_name: SAP Developer
author_profile: https://github.com/SAP
---

# Deploy a CAP Application to SAP BTP Cloud Foundry

> **Note:** This file is a documentation sample for the `tutorial-rich-media-and-tables` platform feature.
> It is NOT published to the tutorial catalog.
> Its purpose is to demonstrate every rich-media directive in a realistic authoring context.

In this tutorial you will deploy a CAP (Cloud Application Programming Model) Node.js application to SAP BTP Cloud Foundry. Along the way you will see how rich media directives can make tutorial content clearer and more interactive.

## Prerequisites

- An SAP BTP trial or productive account
- The Cloud Foundry CLI installed (`cf --version` ≥ 8)
- The `@sap/cds-dk` package installed globally (`npm i -g @sap/cds-dk`)
- A modern browser (Chrome, Edge, or Firefox)

---

## Step 1: Understand the BTP Cockpit Layout

Before you deploy, familiarise yourself with the main areas of the SAP BTP Cockpit. Two views are most important: the **Global Account overview** and the **Subaccount detail**.

:::figure[SAP BTP Cockpit — global account and subaccount views]{width=90% align=center}
![BTP Cockpit global account screen](cockpit-global-account.png)
![BTP Cockpit subaccount detail screen](cockpit-subaccount-detail.png)
:::

In the global account view you manage entitlements across all subaccounts. Drill into a subaccount to see its spaces, service instances, and routes.

To reach the subaccount overview, click :image[Go to subaccount button]{src=icon-goto-subaccount.png width=18} next to the subaccount name, or click the name itself.

---

## Step 2: Log In and Select a Target Space

Run the following commands to log in to Cloud Foundry and point the CLI at the space where you will deploy.

```bash
cf login -a https://api.cf.eu10-005.hana.ondemand.com --sso
cf target -o <your-org> -s dev
```

After login, the terminal confirms the API endpoint, organisation, and space. The comparison below shows the difference between a first-time login (which prompts for SSO) and a subsequent re-authentication (which reuses a cached token).

::compare{before=cf-login-first-time.png after=cf-login-cached-token.png labels="First-time login (SSO prompt)|Re-authentication (cached token)"}

---

## Step 3: Understand the Deployment Architecture

The diagram below shows how the three tiers of a standard CAP application map to BTP Cloud Foundry components after deployment.

::diagram[cap-cf-architecture.svg]{alt="CAP application architecture: AppRouter in front, CAP srv in the middle, SAP HANA Cloud at the back, connected by service bindings" caption="CAP three-tier deployment on BTP Cloud Foundry" src-dark=cap-cf-architecture-dark.svg}

The key connection points are:

- The **AppRouter** authenticates users via XSUAA and proxies requests to the CAP service.
- The **CAP service** (`tutorials-srv`) serves OData endpoints and reads/writes data through the HDI container binding.
- **SAP HANA Cloud** stores all business data; the HDI container manages schema migrations.

Now annotate this on a real screenshot to see exactly where each component appears in the BTP Cockpit.

![Deployed applications in the BTP Cockpit space view](cockpit-space-apps.png){hotspots="1:22%,34% 2:55%,34% 3:80%,60%"}

1. The **AppRouter** (`tutorials-approuter`) — the public-facing entry point. Check that it shows **1/1** running instances.
2. The **CAP service** (`tutorials-srv`) — the backend API. It should also show **1/1** running instances.
3. The **HANA Cloud service instance** (`tutorials-hana`) in the service instances list — bound to both apps.

---

## Step 4: Build and Deploy

Run the Multi-Target Application (MTA) build and deploy commands. The recording below shows a complete `mbt build` + `cf deploy` sequence on a minimal CAP project.

::cast[mbt-build-and-deploy.cast]{rows=26 cols=100 speed=1.3 poster="0:05" idle-limit=2}

If the deploy fails with `No credentials configured for HDI container`, the HANA service binding is missing. Bind it manually:

```bash
cf bind-service tutorials-srv tutorials-hana
cf restart tutorials-srv
```

---

## Step 5: Verify the Deployment

After deploy completes, open the AppRouter URL and confirm that each surface is reachable.

| Surface | URL pattern | Expected response |
|---------|-------------|-------------------|
| Root | `https://<approuter>/` | Redirects to `/browse` |
| OData metadata | `https://<approuter>/srv/catalog/$metadata` | Returns EDMX XML |
| Admin UI | `https://<approuter>/admin-ui/` | Requires `Tutorial.Admin` scope |
| Health check | `https://<srv-direct>/health` | `{ "status": "UP" }` |
{.sortable .filterable}

The table above lists all surfaces you should verify. Use the filter box to narrow by surface name, or click the **URL pattern** column header to sort alphabetically.

**Congratulations — your CAP application is live on SAP BTP Cloud Foundry.**
