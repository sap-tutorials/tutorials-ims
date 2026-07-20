# BAIP External-Links Category Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an Admin-only "BAIP" group to the admin-shell sidebar with three external quick-links (AI Launchpad, BTP Subaccount cockpit, HANA Cloud console) that open in a new browser tab.

**Architecture:** Config-only change. The admin-shell `SideNavigation` (UI5 `sap.tnt`) already binds `href`/`target` on nav items and renders external links as native anchors — the existing `analyticsExternal` and `dataInspector` items prove this. We append one group object to `app/admin-shell/webapp/model/navigation.json`. No route, controller, view, or backend change. Admin-only visibility is enforced client-side by the existing `_filterNavigationByRole` logic, which requires `requiredScope: "Admin"` on both the group and every child item.

**Tech Stack:** UI5 `sap.tnt.ToolPage`/`SideNavigation`, plain JSON config, Vitest for the static shape test.

## Global Constraints

- **Auth scope:** BAIP group and all three child items MUST carry `requiredScope: "Admin"`. Both levels are load-bearing under `_filterNavigationByRole` (`app/admin-shell/webapp/controller/Shell.controller.js:340`) — a child without a scope leaks to authors.
- **Link target:** every BAIP link item uses `"target": "_blank"` (new tab).
- **Item labels (verbatim):** `AI Launchpad`, `BTP Subaccount`, `HANA Cloud`.
- **Group label (verbatim):** `BAIP`.
- **Placement:** BAIP is the **last** group in `navigation.json`'s `groups` array (after `runtimeSettings`).
- **URLs (verbatim):**
  - AI Launchpad: `https://tutorial-system.ai-launchpad.prod.eu-central-1.aws.ai-prod.cloud.sap/aic/index.html`
  - BTP Subaccount: `https://emea.cockpit.btp.cloud.sap/cockpit/#/globalaccount/a0ec0d63-f690-42ab-8113-9f6567cd897e/subaccount/3c6fa3f1-db8c-4e47-9048-fa8c84b867cb/subaccountoverview`
  - HANA Cloud: `https://devrel.hana-tooling.ingress.orchestration.prod-eu10.hanacloud.ondemand.com/hcs/sap/hana/cloud/index.html`
- **No controller wiring:** do NOT add the BAIP keys to `NAV_KEY_TO_ROUTE` / `NAV_KEY_TO_TITLE` in `Shell.controller.js`. Adding them wires the anchors to non-existent routes and breaks native navigation.
- **Windows/CRLF:** repo is edited on Windows; keep `navigation.json` line endings consistent with the existing file (LF). Do not let an editor flip to CRLF.

---

### Task 1: Add the BAIP group to the navigation model + guard test

**Files:**
- Modify: `app/admin-shell/webapp/model/navigation.json` (append group after `runtimeSettings`, currently ends at line 121–123)
- Test: `test/unit/admin-shell-baip-links.test.js` (create)

**Interfaces:**
- Consumes: the existing `navigation.json` shape — top-level `{ "selectedNavKey": ..., "groups": [ { "key", "title", "icon", "requiredScope"?, "items"? } ] }`. External-link items follow the `dataInspector` shape: `{ "key", "title", "href", "target", "requiredScope" }`.
- Produces: a new group `{ key: "baip" }` with three items keyed `baipAiLaunchpad`, `baipBtpSubaccount`, `baipHanaCloud`. No consumer in later tasks (single-task plan) — the test locks the contract.

- [ ] **Step 1: Write the failing test**

Create `test/unit/admin-shell-baip-links.test.js`:

```javascript
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const NAV = JSON.parse(
  readFileSync(join(import.meta.dirname, '../../app/admin-shell/webapp/model/navigation.json'), 'utf8')
);
const SHELL = readFileSync(
  join(import.meta.dirname, '../../app/admin-shell/webapp/controller/Shell.controller.js'),
  'utf8'
);

const EXPECTED = {
  baipAiLaunchpad:   'https://tutorial-system.ai-launchpad.prod.eu-central-1.aws.ai-prod.cloud.sap/aic/index.html',
  baipBtpSubaccount: 'https://emea.cockpit.btp.cloud.sap/cockpit/#/globalaccount/a0ec0d63-f690-42ab-8113-9f6567cd897e/subaccount/3c6fa3f1-db8c-4e47-9048-fa8c84b867cb/subaccountoverview',
  baipHanaCloud:     'https://devrel.hana-tooling.ingress.orchestration.prod-eu10.hanacloud.ondemand.com/hcs/sap/hana/cloud/index.html'
};

const TITLES = {
  baipAiLaunchpad:   'AI Launchpad',
  baipBtpSubaccount: 'BTP Subaccount',
  baipHanaCloud:     'HANA Cloud'
};

describe('admin-shell BAIP external-links group', () => {
  const baip = NAV.groups.find(g => g.key === 'baip');

  it('adds a BAIP group as the last sidebar group', () => {
    expect(baip).toBeTruthy();
    expect(baip.title).toBe('BAIP');
    expect(baip.icon).toBeTruthy();
    expect(NAV.groups[NAV.groups.length - 1].key).toBe('baip');
  });

  it('gates the group on the Admin scope', () => {
    expect(baip.requiredScope).toBe('Admin');
  });

  it('has exactly the three expected external-link items', () => {
    const keys = baip.items.map(i => i.key);
    expect(keys).toEqual(['baipAiLaunchpad', 'baipBtpSubaccount', 'baipHanaCloud']);
  });

  it('every item opens in a new tab, is Admin-gated, and points at the exact https URL', () => {
    for (const item of baip.items) {
      expect(item.title).toBe(TITLES[item.key]);
      expect(item.target).toBe('_blank');
      expect(item.requiredScope).toBe('Admin');
      expect(item.href).toBe(EXPECTED[item.key]);
      expect(item.href.startsWith('https://')).toBe(true);
    }
  });

  it('does NOT wire BAIP keys into Shell.controller route/title maps (native anchor nav)', () => {
    for (const key of Object.keys(EXPECTED)) {
      expect(SHELL.includes(key)).toBe(false);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/admin-shell-baip-links.test.js`
Expected: FAIL — `baip` group not found, so `baip` is `undefined` and the first `expect(baip).toBeTruthy()` throws.

- [ ] **Step 3: Add the BAIP group to `navigation.json`**

In `app/admin-shell/webapp/model/navigation.json`, the `groups` array currently ends with the `runtimeSettings` group closing at line 121 (`    }`) followed by `  ]` and `}`. Add a comma after that `runtimeSettings` closing brace and insert the new group before the `  ]`. The tail becomes:

```json
    {
      "key": "runtimeSettings",
      "title": "Runtime Settings",
      "icon": "sap-icon://settings",
      "items": [
        { "key": "uiEvents", "title": "UI Events" },
        { "key": "search", "title": "Search" },
        { "key": "navigator", "title": "Navigator" },
        { "key": "display", "title": "Display" },
        { "key": "tenant", "title": "Tenant" },
        { "key": "featureFlags", "title": "Feature Flags", "requiredScope": "Admin" }
      ]
    },
    {
      "key": "baip",
      "title": "BAIP",
      "icon": "sap-icon://cloud",
      "requiredScope": "Admin",
      "items": [
        { "key": "baipAiLaunchpad", "title": "AI Launchpad", "href": "https://tutorial-system.ai-launchpad.prod.eu-central-1.aws.ai-prod.cloud.sap/aic/index.html", "target": "_blank", "requiredScope": "Admin" },
        { "key": "baipBtpSubaccount", "title": "BTP Subaccount", "href": "https://emea.cockpit.btp.cloud.sap/cockpit/#/globalaccount/a0ec0d63-f690-42ab-8113-9f6567cd897e/subaccount/3c6fa3f1-db8c-4e47-9048-fa8c84b867cb/subaccountoverview", "target": "_blank", "requiredScope": "Admin" },
        { "key": "baipHanaCloud", "title": "HANA Cloud", "href": "https://devrel.hana-tooling.ingress.orchestration.prod-eu10.hanacloud.ondemand.com/hcs/sap/hana/cloud/index.html", "target": "_blank", "requiredScope": "Admin" }
      ]
    }
  ]
}
```

- [ ] **Step 4: Verify the JSON parses**

Run: `node -e "JSON.parse(require('fs').readFileSync('app/admin-shell/webapp/model/navigation.json','utf8')); console.log('OK')"`
Expected: prints `OK` (no `SyntaxError` — catches a missing/extra comma).

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run test/unit/admin-shell-baip-links.test.js`
Expected: PASS — all five specs green.

- [ ] **Step 6: Run the full unit suite to confirm no regression**

Run: `npm test`
Expected: PASS — in particular `test/unit/admin-shell-explainer-registration.test.js` (which also parses `navigation.json`) still passes.

- [ ] **Step 7: Commit**

```bash
git add app/admin-shell/webapp/model/navigation.json test/unit/admin-shell-baip-links.test.js
git commit -m "feat(admin-shell): add Admin-only BAIP external-links category

New sidebar group 'BAIP' (last group) with three external quick-links —
AI Launchpad, BTP Subaccount cockpit, HANA Cloud console — opening in a new
tab. Config-only via navigation.json, reusing the existing href/target nav
pattern (analyticsExternal/dataInspector). Admin-gated on group + every child
so it never leaks to Tutorial.Author. No route/controller/view change."
```

---

## Manual verification (after implementation)

Optional but recommended before deploy — the automated test covers the config contract, but a human eye confirms rendering:

1. Run the admin shell locally: `cd app/admin-shell && npm start` (serves `index.html` via `ui5 serve`).
2. As an Admin user, confirm the **BAIP** group appears last in the sidebar with the three items.
3. Click each item — confirm it opens the correct console in a **new tab** and the admin console stays open behind it.
4. (If an author test account is available) confirm the BAIP group is **not** visible to a `Tutorial.Author`-only user.

## Deploy note

Ships with the admin-shell static assets. The MTA Assemble step builds `app/admin-shell` via `ui5 build` and copies `dist/` into `static/admin-ui` (`.deploy/mta.yaml:170-173`); `navigation.json` is copied verbatim by `ui5 build`. No DB migration, env var, or backend change. Confirm admin-shell is in the deploy scope with the maintainer.
