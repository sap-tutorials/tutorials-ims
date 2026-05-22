---
title: "U9 glossary demo"
description: "Demo page for inline SAP-acronym tooltips (U9 prototype)."
draft: false
---

# Inline glossary tooltips (U9)

Hover (or focus with Tab) any of the dotted-underlined acronyms below to see a
Horizon-themed `ui5-popover` with a one-line definition and a link to a longer
primer. Only the *first* occurrence of each term per page is wrapped, so the
body copy stays readable.

<div class="glossary-scope">

## What's covered

This site teaches developers how to build cloud-native business apps on SAP
BTP. The default stack is CAP — the SAP Cloud Application Programming Model —
which leans on CDS for data and service modeling. ABAP developers building
on S/4HANA Cloud will instead reach for RAP, the ABAP-side equivalent.

## Deployment story

Production apps ship as an MTA (multitarget application) bundle pushed to
Cloud Foundry. The deployment binds an XSUAA instance for authentication, an
HDI container for HANA schema isolation, and optionally an IAS tenant when
the customer has a corporate IDP they want to federate against. The HANA
database itself runs as a managed BTP service — no infrastructure to babysit.

## What you don't pay for

Note how each acronym in this paragraph (BTP, CAP, CDS, RAP, MTA, XSUAA, HDI,
IAS, IDP, HANA) appears underlined only on its *first* mention above. The
second mention here renders as plain text — that's the "tag only the first
occurrence per page" policy.

## OData appears once too

CAP services expose OData endpoints by default, and once you've seen OData
underlined you won't see it again on this page either.

</div>

## Why this matters

SAP terminology is the single biggest onboarding tax for new developers.
An inline glossary makes every page self-explaining without forcing the
reader to context-switch to a separate cheat sheet.
