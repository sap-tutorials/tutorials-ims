---
title: "Cookie Policy"
description: "How developers.sap.com Tutorial Platform uses cookies and browser storage."
lastmod: 2026-05-20
sitemap:
  priority: 0.3
---

## What this page covers

This policy explains how the SAP Developers Tutorial Platform
(`developers.sap.com`) uses cookies and similar technologies — including
browser storage (`localStorage` and `sessionStorage`).

For SAP's group-level cookie policy that applies to all SAP web properties,
see the
[SAP Cookie Statement](https://www.sap.com/about/legal/privacy/cookies.html).
This page documents the platform-specific cookies and storage entries set by
this site, in addition to those covered by the group statement.

Under EU law (GDPR Art. 5(3) and the ePrivacy Directive) and similar
regulations elsewhere, the rules that apply to cookies also apply to any
mechanism that reads or writes data on your device — so we treat browser
storage the same way we treat cookies.

## Cookies we set

### Required {#required}

These cookies are required for the site to work. You cannot opt out of
required cookies.

| Name | Purpose | Set by | Duration |
| --- | --- | --- | --- |
| Session cookie (XSUAA) | Keeps you signed in after you log in with your SAP account | SAP Application Router (XSUAA) | Session |
| Routing cookie (`__VCAP_ID__`) | Routes your requests to the same backend instance for stable sessions | SAP BTP Cloud Foundry router | Session |
| SAP Identity Provider cookies | Set during the login flow when you authenticate with your SAP account | `accounts.sap.com` | Session / persistent — see the [SAP Trust Center privacy statement](https://www.sap.com/about/legal/privacy.html) |

### Functional {#functional}

We do not currently set functional cookies. Theme and chat preferences are
stored in browser storage instead — see below.

### Advertising {#advertising}

We do not currently set advertising cookies on this site.
If we add any in the future, we will update this policy and you can change
your preferences at any time using the **Cookie Preferences** link in the
footer.

## Browser storage we use

The platform uses two browser-storage mechanisms:

- **`localStorage`** — persists across sessions, scoped to this site.
- **`sessionStorage`** — cleared when you close the tab; scoped to this
  site and to that single tab.

Neither localStorage nor sessionStorage data is sent to our servers. It
stays on your device.

| Key | Storage | Category | Purpose | Cleared when |
| --- | --- | --- | --- | --- |
| `theme` | localStorage | Functional | Remembers your light/dark theme choice | You clear site data |
| `consent.v1` | localStorage | Required | Stores your cookie-category choices (required / functional / advertising) | You clear site data, or open "Cookie Preferences" in the footer and re-save |
| `joule.config.v1` | sessionStorage | Functional | Caches Joule chat configuration for 60 seconds to reduce network calls | You close the tab, or after 60 seconds |
| `joule.history` | sessionStorage | Functional | Stores your Joule chat transcript so it survives page navigation | You close the tab, click "Clear chat", or log out |
| `joule.user.v1` | sessionStorage | Functional | Caches your name and email for 60 seconds so the chat panel can greet you without refetching | You close the tab, log out, or after 60 seconds |

## Third-party content

Some tutorial pages embed content hosted by third parties — for example
YouTube videos and SAP documentation pages. When you interact with this
content, the third party may set its own cookies subject to its own privacy
policy.

The platform applies a strict Content Security Policy that limits which
third parties can load resources, but it does not prevent embedded content
from setting its own cookies once you choose to interact with it.

## Your choices

- **Click "Cookie Preferences"** in the footer at the bottom of any page to
  open the cookie settings dialog. From there you can toggle Functional and
  Advertising categories independently. Required cookies cannot be disabled.
  Your selection is saved in your browser as `consent.v1` (see the table
  above).
- **Click "Understood"** on the consent banner to accept all cookie
  categories. You can change your mind at any time via Cookie Preferences.
- **Sign out** to clear your session cookies and remove the cached Joule
  user/chat data from your tab.
- **Clear browser storage** in your browser's developer tools or privacy
  settings to remove `theme`, `joule.history`, `consent.v1`, etc.
- **Block cookies** in your browser settings — this will sign you out and
  prevent you from logging back in.

## Changes to this policy

We will update this page when we add or remove cookies, or when our
practices change. The "last updated" date at the top reflects the most
recent change.

## Contact

Questions about this policy can be sent via the
[SAP Privacy Statement contact form](https://www.sap.com/registration/contact.html?countryOfOrigin=en_us&navTitle=Contact%20Form&pageTitle=SAP%20Privacy%20Statement&refererContentPath=%2Fcontent%2Fsapdx%2Fcountries%2Fen_us%2Fabout%2Flegal%2Fprivacy&refererPagePath=https%3A%2F%2Fwww.sap.com%2Fabout%2Flegal%2Fprivacy.html).
For SAP-wide privacy enquiries, see the
[SAP Trust Center](https://www.sap.com/about/trust-center/privacy.html).
