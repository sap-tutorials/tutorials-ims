# BAIP external-links category in the Admin UI

**Date:** 2026-07-20
**Status:** Approved (design)
**Scope:** Single feature — add an Admin-only "BAIP" sidebar category to the admin
shell with three external quick-links to infrastructure consoles.

## Problem

Admins operating this platform routinely jump to three external consoles that live
outside the admin UI: the AI Launchpad, the BTP subaccount cockpit, and the HANA
Cloud tooling console. Today they navigate by bookmark or by hand. We want first-class
quick-links inside the admin shell sidebar so these destinations are one click away.

## Goal

Add a new sidebar group **BAIP**, visible only to users with the XSUAA `Admin`
scope, containing three external links that open in a new browser tab:

| Item label      | URL |
|-----------------|-----|
| AI Launchpad    | `https://tutorial-system.ai-launchpad.prod.eu-central-1.aws.ai-prod.cloud.sap/aic/index.html` |
| BTP Subaccount  | `https://emea.cockpit.btp.cloud.sap/cockpit/#/globalaccount/a0ec0d63-f690-42ab-8113-9f6567cd897e/subaccount/3c6fa3f1-db8c-4e47-9048-fa8c84b867cb/subaccountoverview` |
| HANA Cloud      | `https://devrel.hana-tooling.ingress.orchestration.prod-eu10.hanacloud.ondemand.com/hcs/sap/hana/cloud/index.html` |

## Non-goals

- No new UI5 route, controller method, view, or component. These are external links.
- No embedding / iframing of the external consoles.
- No dynamic/config-driven URL management (admin-editable link table). URLs are
  static config in `navigation.json`, consistent with how `analyticsExternal` and
  `dataInspector` external items are already declared. If admin-editable links are
  wanted later, that is a separate feature.

## Why this needs almost no code

The admin shell's `SideNavigation` (`app/admin-shell/webapp/view/Shell.view.xml`)
already binds `href` and `target` on every `NavigationListItem`, at both group and
child level. UI5's `tnt.NavigationListItem` renders an entry with an `href` as a real
anchor and does **not** fire route navigation for it — it navigates the browser
directly. Two existing items prove the pattern:

- `analyticsExternal` — `{ "href": "/analytics-ui/", "target": "_self", ... }`
- `dataInspector`     — `{ "href": "/data-inspector-ui/", "target": "_self",
  "requiredScope": "Admin" }`

`onNavItemSelect` in `Shell.controller.js` looks up `NAV_KEY_TO_ROUTE[sKey]`; for an
external item there is no route mapping, so it no-ops and lets the anchor's native
navigation happen. Therefore the BAIP group requires **only** a config addition to
`navigation.json`.

## Design

### 1. Data change — `app/admin-shell/webapp/model/navigation.json`

Append one group object as the **last** entry in `groups` (after `runtimeSettings`):

```json
{
  "key": "baip",
  "title": "BAIP",
  "icon": "sap-icon://cloud",
  "requiredScope": "Admin",
  "items": [
    { "key": "baipAiLaunchpad",   "title": "AI Launchpad",   "href": "https://tutorial-system.ai-launchpad.prod.eu-central-1.aws.ai-prod.cloud.sap/aic/index.html", "target": "_blank", "requiredScope": "Admin" },
    { "key": "baipBtpSubaccount", "title": "BTP Subaccount", "href": "https://emea.cockpit.btp.cloud.sap/cockpit/#/globalaccount/a0ec0d63-f690-42ab-8113-9f6567cd897e/subaccount/3c6fa3f1-db8c-4e47-9048-fa8c84b867cb/subaccountoverview", "target": "_blank", "requiredScope": "Admin" },
    { "key": "baipHanaCloud",     "title": "HANA Cloud",     "href": "https://devrel.hana-tooling.ingress.orchestration.prod-eu10.hanacloud.ondemand.com/hcs/sap/hana/cloud/index.html", "target": "_blank", "requiredScope": "Admin" }
  ]
}
```

### 2. Auth gating — the load-bearing detail

The requirement is **Admin-only**. `_filterNavigationByRole` in
`Shell.controller.js:340` runs client-side and decides group/child visibility from
`requiredScope`:

- For an **admin**, `keepLeaf` returns `true` for everything → all BAIP items shown.
- For an **author**, the group's own `requiredScope: "Admin"` fails `keepLeaf`
  (author only satisfies `Tutorial.Author`), so the code drops into the
  "filter children" branch. Each child is then tested by `keepLeaf` individually.

Consequently **every child must also carry `requiredScope: "Admin"`** — otherwise a
child without a scope would survive the author's child-filter and the group would leak
to authors. This mirrors the `dataInspector` item, which sets `requiredScope: "Admin"`
at the item level for exactly this reason. Both the group and all three children set
it; belt-and-suspenders and correct under the existing filter logic.

Note: this filtering is a UX affordance, not a security boundary. The external
consoles enforce their own auth. But it keeps the sidebar honest about who these are
for.

### 3. No controller changes

`NAV_KEY_TO_ROUTE` / `NAV_KEY_TO_TITLE` are intentionally **not** touched. Adding the
BAIP keys there would wire them to non-existent routes and titles. Leaving them out is
what makes `onNavItemSelect` no-op and lets the anchor navigate. This is the same
treatment `analyticsExternal` and `dataInspector` get (neither is in those maps).

## Testing

Extend the existing pure-JSON shape test
`test/unit/admin-shell-explainer-registration.test.js` (or add a sibling test file)
with a `describe('BAIP external links')` block asserting:

1. `NAV.groups` contains a group with `key === 'baip'`, and it is the **last** group.
2. The group has `requiredScope === 'Admin'` and `icon` set.
3. The group has exactly three items with keys
   `baipAiLaunchpad`, `baipBtpSubaccount`, `baipHanaCloud`.
4. Every item has `target === '_blank'`, a non-empty `href` starting with `https://`,
   and `requiredScope === 'Admin'`.
5. None of the three BAIP keys appear in `Shell.controller.js`'s `NAV_KEY_TO_ROUTE`
   (guards against someone later mis-wiring them to routes).

These are static assertions requiring no UI5 runtime, matching the existing test's
approach. Run with `npm test`.

Manual verification: `node -e "JSON.parse(require('fs').readFileSync('app/admin-shell/webapp/model/navigation.json','utf8'))"` to confirm the JSON parses, then a
visual check of group placement against sibling groups.

## Files touched

- `app/admin-shell/webapp/model/navigation.json` — add the `baip` group (only
  functional change).
- `test/unit/admin-shell-explainer-registration.test.js` — add BAIP assertions
  (or a new `test/unit/admin-shell-baip-links.test.js`).

## Rollout

Ships with the admin shell static assets in the next approuter deploy. No DB
migration, no env var, no backend change. Because it is static approuter content,
confirm the admin-shell UI is included in the deploy scope (it is part of the standard
`hugo/public` + approuter bundle path).
