# Admin Shell Navigation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace 11 separate UI5 admin apps with a single unified shell using `sap.tnt.ToolPage` for BTP Cockpit-style navigation, light/dark mode, and Router-managed component loading.

**Architecture:** A new `app/admin-shell/` application acts as the single entry point. It uses `sap.tnt.ToolPage` with `SideNavigation` for a collapsible nav tree, and `sap.m.App` as the Router-controlled content area. Fiori Elements apps load as `type: "Component"` Router targets via `componentUsages`. Four freestyle views (Board, Statistics, TutorialDashboard, Privacy) move directly into the shell. The old `admin-flp/` and `admin-custom/` apps are deleted.

**Tech Stack:** SAPUI5 1.136.0 (CDN), sap.tnt.ToolPage, sap.m.routing.Router with Component targets, OData V4, sap/ui/core/Theming API, localStorage, matchMedia

---

## File Structure

```
app/admin-shell/
├── webapp/
│   ├── index.html                    ← sole UI5 bootstrap
│   ├── Component.js                  ← root component, theme init, nav model
│   ├── manifest.json                 ← routes, targets, componentUsages, resourceRoots
│   ├── controller/
│   │   ├── Shell.controller.js       ← nav toggle, theme switch, component loading
│   │   ├── Home.controller.js        ← tile grid navigation
│   │   ├── Board.controller.js       ← moved from admin-custom (namespace adjusted)
│   │   ├── Statistics.controller.js  ← moved from admin-custom
│   │   ├── TutorialDashboard.controller.js ← moved from admin-custom
│   │   └── Privacy.controller.js     ← moved from admin-custom
│   ├── view/
│   │   ├── Shell.view.xml            ← ToolPage + SideNavigation + App
│   │   ├── Home.view.xml             ← tile grid (replaces admin-flp)
│   │   ├── Board.view.xml            ← moved from admin-custom
│   │   ├── Statistics.view.xml       ← moved from admin-custom
│   │   ├── TutorialDashboard.view.xml ← moved from admin-custom
│   │   └── Privacy.view.xml          ← moved from admin-custom
│   └── model/
│       └── navigation.json           ← nav tree structure
├── package.json                      ← build script
├── ui5.yaml                          ← UI5 tooling config
└── scripts/
    └── copy-components.js            ← copies feature component webapps to dist/
```

**Retirement:**
- Delete: `app/admin-flp/` (entire directory)
- Delete: `app/admin-custom/` (entire directory)
- Delete: `app/admin/*/webapp/index.html` (10 files)

**Approuter changes:**
- Replace 12 `APP_MOUNTS` entries with new paths under `/admin-ui/`

---

### Task 1: Create Shell App Scaffold

**Files:**
- Create: `app/admin-shell/webapp/index.html`
- Create: `app/admin-shell/package.json`
- Create: `app/admin-shell/ui5.yaml`

- [ ] **Step 1: Create directory structure**

Run: `mkdir -p app/admin-shell/webapp/{controller,view,model} app/admin-shell/scripts`

- [ ] **Step 2: Create index.html**

Create `app/admin-shell/webapp/index.html`:

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Admin Console</title>
  <script id="sap-ui-bootstrap"
    src="https://ui5.sap.com/1.136.0/resources/sap-ui-core.js"
    data-sap-ui-theme="sap_horizon"
    data-sap-ui-compatVersion="edge"
    data-sap-ui-async="true"
    data-sap-ui-resource-roots='{ "sap.tutorials.admin.shell": "./" }'
    data-sap-ui-on-init="module:sap/ui/core/ComponentSupport"
    data-sap-ui-frameOptions="allow">
  </script>
</head>
<body class="sapUiBody" id="content">
  <div data-sap-ui-component
    data-name="sap.tutorials.admin.shell"
    data-id="container"
    data-settings='{ "id": "sap.tutorials.admin.shell" }'
    style="height: 100%;">
  </div>
</body>
</html>
```

- [ ] **Step 3: Create package.json**

Create `app/admin-shell/package.json`:

```json
{
  "name": "admin-shell",
  "version": "0.0.1",
  "private": true,
  "scripts": {
    "start": "ui5 serve --open index.html",
    "build": "ui5 build --clean-dest --dest dist && node scripts/copy-components.js"
  },
  "devDependencies": {
    "@ui5/cli": "^4.0.0"
  }
}
```

- [ ] **Step 4: Create ui5.yaml**

Create `app/admin-shell/ui5.yaml`:

```yaml
specVersion: "4.0"
metadata:
  name: admin-shell
type: application
framework:
  name: SAPUI5
  version: "1.136.0"
  libraries:
    - name: sap.m
    - name: sap.tnt
    - name: sap.ui.core
    - name: sap.ui.layout
    - name: sap.ui.table
    - name: sap.fe.templates
```

- [ ] **Step 5: Commit scaffold**

```bash
git add app/admin-shell/webapp/index.html app/admin-shell/package.json app/admin-shell/ui5.yaml
git commit -m "feat(admin-shell): create app scaffold with index.html, package.json, ui5.yaml"
```

---

### Task 2: Create Component.js with Theme Detection

**Files:**
- Create: `app/admin-shell/webapp/Component.js`

- [ ] **Step 1: Create Component.js**

Create `app/admin-shell/webapp/Component.js`:

```javascript
sap.ui.define([
  "sap/ui/core/UIComponent",
  "sap/ui/core/Theming",
  "sap/ui/model/json/JSONModel"
], function (UIComponent, Theming, JSONModel) {
  "use strict";

  return UIComponent.extend("sap.tutorials.admin.shell.Component", {
    metadata: {
      manifest: "json"
    },

    init: function () {
      UIComponent.prototype.init.apply(this, arguments);

      this._initTheme();
      this._initNavModel();
      this.getRouter().initialize();
    },

    _initTheme: function () {
      var sStoredTheme = localStorage.getItem("sap-tutorials-admin-theme");
      var bOsDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
      var sTheme = sStoredTheme || (bOsDark ? "sap_horizon_dark" : "sap_horizon");
      Theming.setTheme(sTheme);

      var sMode = sStoredTheme ? (sStoredTheme === "sap_horizon_dark" ? "dark" : "light") : "auto";
      this.setModel(new JSONModel({ themeMode: sMode }), "theme");

      window.matchMedia("(prefers-color-scheme: dark)")
        .addEventListener("change", function (e) {
          if (!localStorage.getItem("sap-tutorials-admin-theme")) {
            Theming.setTheme(e.matches ? "sap_horizon_dark" : "sap_horizon");
          }
        });
    },

    _initNavModel: function () {
      var oNavModel = new JSONModel();
      oNavModel.loadData(sap.ui.require.toUrl("sap/tutorials/admin/shell/model/navigation.json"));
      this.setModel(oNavModel, "nav");
    }
  });
});
```

- [ ] **Step 2: Commit**

```bash
git add app/admin-shell/webapp/Component.js
git commit -m "feat(admin-shell): add Component.js with theme detection and nav model init"
```

---

### Task 3: Create Navigation Model

**Files:**
- Create: `app/admin-shell/webapp/model/navigation.json`

- [ ] **Step 1: Create navigation.json**

Create `app/admin-shell/webapp/model/navigation.json`:

```json
{
  "selectedNavKey": "home",
  "groups": [
    {
      "key": "content",
      "title": "Content",
      "icon": "sap-icon://folder-blank",
      "expanded": true,
      "items": [
        { "key": "events", "title": "Events", "icon": "sap-icon://calendar" },
        { "key": "missions", "title": "Missions", "icon": "sap-icon://target-group" },
        { "key": "groups", "title": "Groups", "icon": "sap-icon://group" },
        { "key": "tutorials", "title": "Tutorials", "icon": "sap-icon://education" },
        { "key": "tags", "title": "Tags", "icon": "sap-icon://tags" }
      ]
    },
    {
      "key": "rewards",
      "title": "Rewards",
      "icon": "sap-icon://gift",
      "expanded": true,
      "items": [
        { "key": "accomplishments", "title": "Accomplishments", "icon": "sap-icon://badge" },
        { "key": "prizes", "title": "Prizes", "icon": "sap-icon://gift" }
      ]
    },
    {
      "key": "system",
      "title": "System",
      "icon": "sap-icon://action-settings",
      "expanded": true,
      "items": [
        { "key": "operations", "title": "Operations", "icon": "sap-icon://action-settings" },
        { "key": "accounts", "title": "Accounts", "icon": "sap-icon://person-placeholder" },
        { "key": "changelog", "title": "Change Log", "icon": "sap-icon://history" },
        { "key": "board", "title": "Board", "icon": "sap-icon://dashboard" },
        { "key": "dashboard", "title": "Dashboard", "icon": "sap-icon://monitor-payments" },
        { "key": "statistics", "title": "Statistics", "icon": "sap-icon://bar-chart" },
        { "key": "privacy", "title": "Privacy", "icon": "sap-icon://shield" }
      ]
    }
  ]
}
```

- [ ] **Step 2: Commit**

```bash
git add app/admin-shell/webapp/model/navigation.json
git commit -m "feat(admin-shell): add navigation model with grouped nav items"
```

---

### Task 4: Create Shell View and Controller

**Files:**
- Create: `app/admin-shell/webapp/view/Shell.view.xml`
- Create: `app/admin-shell/webapp/controller/Shell.controller.js`

- [ ] **Step 1: Create Shell.view.xml**

Create `app/admin-shell/webapp/view/Shell.view.xml`:

```xml
<mvc:View
  controllerName="sap.tutorials.admin.shell.controller.Shell"
  xmlns:mvc="sap.ui.core.mvc"
  xmlns="sap.m"
  xmlns:tnt="sap.tnt"
  displayBlock="true">

  <tnt:ToolPage id="toolPage" sideExpanded="{viewModel>/sideExpanded}">

    <tnt:header>
      <tnt:ToolHeader>
        <Button
          id="sideNavToggleBtn"
          icon="sap-icon://menu2"
          type="Transparent"
          press=".onToggleSideNav" />
        <Title text="Tutorial Platform — Admin Console" level="H5">
          <layoutData>
            <OverflowToolbarLayoutData priority="NeverOverflow" />
          </layoutData>
        </Title>
        <ToolbarSpacer />
        <SegmentedButton
          id="themeSwitch"
          selectedKey="{theme>/themeMode}"
          selectionChange=".onThemeChange">
          <items>
            <SegmentedButtonItem key="auto" icon="sap-icon://circle-task-2" tooltip="Auto (OS)" />
            <SegmentedButtonItem key="light" icon="sap-icon://lightbulb" tooltip="Light" />
            <SegmentedButtonItem key="dark" icon="sap-icon://darkmode" tooltip="Dark" />
          </items>
        </SegmentedButton>
      </tnt:ToolHeader>
    </tnt:header>

    <tnt:sideContent>
      <tnt:SideNavigation id="sideNav" selectedKey="{nav>/selectedNavKey}" itemSelect=".onNavItemSelect">
        <tnt:NavigationList>
          <tnt:NavigationListItem text="Home" icon="sap-icon://home" key="home" />
          <tnt:NavigationListItem text="Content" icon="sap-icon://folder-blank" expanded="true">
            <tnt:NavigationListItem text="Events" icon="sap-icon://calendar" key="events" />
            <tnt:NavigationListItem text="Missions" icon="sap-icon://target-group" key="missions" />
            <tnt:NavigationListItem text="Groups" icon="sap-icon://group" key="groups" />
            <tnt:NavigationListItem text="Tutorials" icon="sap-icon://education" key="tutorials" />
            <tnt:NavigationListItem text="Tags" icon="sap-icon://tags" key="tags" />
          </tnt:NavigationListItem>
          <tnt:NavigationListItem text="Rewards" icon="sap-icon://gift" expanded="true">
            <tnt:NavigationListItem text="Accomplishments" icon="sap-icon://badge" key="accomplishments" />
            <tnt:NavigationListItem text="Prizes" icon="sap-icon://gift" key="prizes" />
          </tnt:NavigationListItem>
          <tnt:NavigationListItem text="System" icon="sap-icon://action-settings" expanded="true">
            <tnt:NavigationListItem text="Operations" icon="sap-icon://action-settings" key="operations" />
            <tnt:NavigationListItem text="Accounts" icon="sap-icon://person-placeholder" key="accounts" />
            <tnt:NavigationListItem text="Change Log" icon="sap-icon://history" key="changelog" />
            <tnt:NavigationListItem text="Board" icon="sap-icon://dashboard" key="board" />
            <tnt:NavigationListItem text="Dashboard" icon="sap-icon://monitor-payments" key="dashboard" />
            <tnt:NavigationListItem text="Statistics" icon="sap-icon://bar-chart" key="statistics" />
            <tnt:NavigationListItem text="Privacy" icon="sap-icon://shield" key="privacy" />
          </tnt:NavigationListItem>
        </tnt:NavigationList>
      </tnt:SideNavigation>
    </tnt:sideContent>

    <tnt:mainContents>
      <App id="contentArea" />
    </tnt:mainContents>

  </tnt:ToolPage>

</mvc:View>
```

- [ ] **Step 2: Create Shell.controller.js**

Create `app/admin-shell/webapp/controller/Shell.controller.js`:

```javascript
sap.ui.define([
  "sap/ui/core/mvc/Controller",
  "sap/ui/core/Theming",
  "sap/ui/model/json/JSONModel"
], function (Controller, Theming, JSONModel) {
  "use strict";

  var NAV_KEY_TO_ROUTE = {
    home: "home",
    events: "events",
    missions: "missions",
    groups: "groups",
    tutorials: "tutorials",
    tags: "tags",
    accomplishments: "accomplishments",
    prizes: "prizes",
    operations: "operations",
    accounts: "accounts",
    changelog: "changelog",
    board: "board",
    dashboard: "dashboard",
    statistics: "statistics",
    privacy: "privacy"
  };

  return Controller.extend("sap.tutorials.admin.shell.controller.Shell", {
    onInit: function () {
      var bExpanded = localStorage.getItem("sap-tutorials-admin-nav-expanded") !== "false";
      this.setModel(new JSONModel({ sideExpanded: bExpanded }), "viewModel");

      this.getOwnerComponent().getRouter().attachRouteMatched(this._onRouteMatched, this);
    },

    setModel: function (oModel, sName) {
      this.getView().setModel(oModel, sName);
    },

    onToggleSideNav: function () {
      var oModel = this.getView().getModel("viewModel");
      var bExpanded = !oModel.getProperty("/sideExpanded");
      oModel.setProperty("/sideExpanded", bExpanded);
      localStorage.setItem("sap-tutorials-admin-nav-expanded", bExpanded);
    },

    onNavItemSelect: function (oEvent) {
      var sKey = oEvent.getParameter("item").getKey();
      if (!sKey) return;

      var sRoute = NAV_KEY_TO_ROUTE[sKey];
      if (sRoute) {
        this.getOwnerComponent().getRouter().navTo(sRoute);
      }
    },

    onThemeChange: function (oEvent) {
      var sKey = oEvent.getParameter("item").getKey();
      var sTheme;

      switch (sKey) {
        case "light":
          sTheme = "sap_horizon";
          localStorage.setItem("sap-tutorials-admin-theme", sTheme);
          break;
        case "dark":
          sTheme = "sap_horizon_dark";
          localStorage.setItem("sap-tutorials-admin-theme", sTheme);
          break;
        default: // auto
          localStorage.removeItem("sap-tutorials-admin-theme");
          sTheme = window.matchMedia("(prefers-color-scheme: dark)").matches
            ? "sap_horizon_dark"
            : "sap_horizon";
          break;
      }

      Theming.setTheme(sTheme);
      this.getOwnerComponent().getModel("theme").setProperty("/themeMode", sKey);
    },

    _onRouteMatched: function (oEvent) {
      var sRouteName = oEvent.getParameter("name");
      var oNavModel = this.getOwnerComponent().getModel("nav");
      if (oNavModel) {
        oNavModel.setProperty("/selectedNavKey", sRouteName);
      }
    }
  });
});
```

- [ ] **Step 3: Commit**

```bash
git add app/admin-shell/webapp/view/Shell.view.xml app/admin-shell/webapp/controller/Shell.controller.js
git commit -m "feat(admin-shell): add Shell view (ToolPage + SideNavigation) and controller"
```

---

### Task 5: Create Home View (Tile Grid)

**Files:**
- Create: `app/admin-shell/webapp/view/Home.view.xml`
- Create: `app/admin-shell/webapp/controller/Home.controller.js`

- [ ] **Step 1: Create Home.view.xml**

Create `app/admin-shell/webapp/view/Home.view.xml`:

```xml
<mvc:View
  controllerName="sap.tutorials.admin.shell.controller.Home"
  xmlns:mvc="sap.ui.core.mvc"
  xmlns="sap.m"
  xmlns:f="sap.f">

  <Page showHeader="false">
    <content>
      <VBox class="sapUiMediumMargin">

        <Title text="Content Management" level="H5" class="sapUiSmallMarginBottom" />
        <f:GridContainer>
          <f:layout>
            <f:GridContainerSettings rowSize="5.5rem" columnSize="5.5rem" gap="0.75rem" />
          </f:layout>
          <GenericTile header="Events" subheader="Create and manage learning events" press=".onTilePress" class="sapUiTinyMarginBegin sapUiTinyMarginTop">
            <TileContent>
              <ImageContent src="sap-icon://calendar" />
            </TileContent>
            <customData>
              <core:CustomData xmlns:core="sap.ui.core" key="navKey" value="events" />
            </customData>
          </GenericTile>
          <GenericTile header="Missions" subheader="Define tutorial missions with completion paths" press=".onTilePress" class="sapUiTinyMarginBegin sapUiTinyMarginTop">
            <TileContent>
              <ImageContent src="sap-icon://target-group" />
            </TileContent>
            <customData>
              <core:CustomData xmlns:core="sap.ui.core" key="navKey" value="missions" />
            </customData>
          </GenericTile>
          <GenericTile header="Groups" subheader="Organize tutorials into logical groups" press=".onTilePress" class="sapUiTinyMarginBegin sapUiTinyMarginTop">
            <TileContent>
              <ImageContent src="sap-icon://group" />
            </TileContent>
            <customData>
              <core:CustomData xmlns:core="sap.ui.core" key="navKey" value="groups" />
            </customData>
          </GenericTile>
          <GenericTile header="Tutorials" subheader="View tutorial catalog and metadata" press=".onTilePress" class="sapUiTinyMarginBegin sapUiTinyMarginTop">
            <TileContent>
              <ImageContent src="sap-icon://education" />
            </TileContent>
            <customData>
              <core:CustomData xmlns:core="sap.ui.core" key="navKey" value="tutorials" />
            </customData>
          </GenericTile>
          <GenericTile header="Tags" subheader="Browse and manage classification tags" press=".onTilePress" class="sapUiTinyMarginBegin sapUiTinyMarginTop">
            <TileContent>
              <ImageContent src="sap-icon://tags" />
            </TileContent>
            <customData>
              <core:CustomData xmlns:core="sap.ui.core" key="navKey" value="tags" />
            </customData>
          </GenericTile>
        </f:GridContainer>

        <Title text="Rewards &amp; Recognition" level="H5" class="sapUiSmallMarginBottom sapUiMediumMarginTop" />
        <f:GridContainer>
          <f:layout>
            <f:GridContainerSettings rowSize="5.5rem" columnSize="5.5rem" gap="0.75rem" />
          </f:layout>
          <GenericTile header="Accomplishments" subheader="Configure badges and achievements" press=".onTilePress" class="sapUiTinyMarginBegin sapUiTinyMarginTop">
            <TileContent>
              <ImageContent src="sap-icon://badge" />
            </TileContent>
            <customData>
              <core:CustomData xmlns:core="sap.ui.core" key="navKey" value="accomplishments" />
            </customData>
          </GenericTile>
          <GenericTile header="Prizes" subheader="Set up event prizes and giveaways" press=".onTilePress" class="sapUiTinyMarginBegin sapUiTinyMarginTop">
            <TileContent>
              <ImageContent src="sap-icon://gift" />
            </TileContent>
            <customData>
              <core:CustomData xmlns:core="sap.ui.core" key="navKey" value="prizes" />
            </customData>
          </GenericTile>
        </f:GridContainer>

        <Title text="System" level="H5" class="sapUiSmallMarginBottom sapUiMediumMarginTop" />
        <f:GridContainer>
          <f:layout>
            <f:GridContainerSettings rowSize="5.5rem" columnSize="5.5rem" gap="0.75rem" />
          </f:layout>
          <GenericTile header="Operations" subheader="Featured tasks, config, and settings" press=".onTilePress" class="sapUiTinyMarginBegin sapUiTinyMarginTop">
            <TileContent>
              <ImageContent src="sap-icon://action-settings" />
            </TileContent>
            <customData>
              <core:CustomData xmlns:core="sap.ui.core" key="navKey" value="operations" />
            </customData>
          </GenericTile>
          <GenericTile header="Accounts" subheader="Primary and secondary account management" press=".onTilePress" class="sapUiTinyMarginBegin sapUiTinyMarginTop">
            <TileContent>
              <ImageContent src="sap-icon://person-placeholder" />
            </TileContent>
            <customData>
              <core:CustomData xmlns:core="sap.ui.core" key="navKey" value="accounts" />
            </customData>
          </GenericTile>
          <GenericTile header="Change Log" subheader="Audit trail of all changes" press=".onTilePress" class="sapUiTinyMarginBegin sapUiTinyMarginTop">
            <TileContent>
              <ImageContent src="sap-icon://history" />
            </TileContent>
            <customData>
              <core:CustomData xmlns:core="sap.ui.core" key="navKey" value="changelog" />
            </customData>
          </GenericTile>
          <GenericTile header="Board" subheader="Tutorial health overview" press=".onTilePress" class="sapUiTinyMarginBegin sapUiTinyMarginTop">
            <TileContent>
              <ImageContent src="sap-icon://dashboard" />
            </TileContent>
            <customData>
              <core:CustomData xmlns:core="sap.ui.core" key="navKey" value="board" />
            </customData>
          </GenericTile>
          <GenericTile header="Dashboard" subheader="Tutorial metadata monitoring" press=".onTilePress" class="sapUiTinyMarginBegin sapUiTinyMarginTop">
            <TileContent>
              <ImageContent src="sap-icon://monitor-payments" />
            </TileContent>
            <customData>
              <core:CustomData xmlns:core="sap.ui.core" key="navKey" value="dashboard" />
            </customData>
          </GenericTile>
          <GenericTile header="Statistics" subheader="Export task records and analytics" press=".onTilePress" class="sapUiTinyMarginBegin sapUiTinyMarginTop">
            <TileContent>
              <ImageContent src="sap-icon://bar-chart" />
            </TileContent>
            <customData>
              <core:CustomData xmlns:core="sap.ui.core" key="navKey" value="statistics" />
            </customData>
          </GenericTile>
          <GenericTile header="Privacy" subheader="DSR requests and anonymization" press=".onTilePress" class="sapUiTinyMarginBegin sapUiTinyMarginTop">
            <TileContent>
              <ImageContent src="sap-icon://shield" />
            </TileContent>
            <customData>
              <core:CustomData xmlns:core="sap.ui.core" key="navKey" value="privacy" />
            </customData>
          </GenericTile>
        </f:GridContainer>

      </VBox>
    </content>
  </Page>

</mvc:View>
```

- [ ] **Step 2: Create Home.controller.js**

Create `app/admin-shell/webapp/controller/Home.controller.js`:

```javascript
sap.ui.define([
  "sap/ui/core/mvc/Controller"
], function (Controller) {
  "use strict";

  return Controller.extend("sap.tutorials.admin.shell.controller.Home", {
    onTilePress: function (oEvent) {
      var sNavKey = oEvent.getSource().data("navKey");
      this.getOwnerComponent().getRouter().navTo(sNavKey);
    }
  });
});
```

- [ ] **Step 3: Commit**

```bash
git add app/admin-shell/webapp/view/Home.view.xml app/admin-shell/webapp/controller/Home.controller.js
git commit -m "feat(admin-shell): add Home view with tile grid replacing admin-flp"
```

---

### Task 6: Move Freestyle Views into Shell

**Files:**
- Create: `app/admin-shell/webapp/view/Board.view.xml` (adapted from `app/admin-custom/webapp/view/Board.view.xml`)
- Create: `app/admin-shell/webapp/view/Statistics.view.xml` (adapted)
- Create: `app/admin-shell/webapp/view/TutorialDashboard.view.xml` (adapted)
- Create: `app/admin-shell/webapp/view/Privacy.view.xml` (adapted)
- Create: `app/admin-shell/webapp/controller/Board.controller.js` (adapted)
- Create: `app/admin-shell/webapp/controller/Statistics.controller.js` (adapted)
- Create: `app/admin-shell/webapp/controller/TutorialDashboard.controller.js` (adapted)
- Create: `app/admin-shell/webapp/controller/Privacy.controller.js` (adapted)
- Reference: `app/admin-custom/webapp/view/Board.view.xml`
- Reference: `app/admin-custom/webapp/controller/Board.controller.js`
- Reference: `app/admin-custom/webapp/view/Statistics.view.xml`
- Reference: `app/admin-custom/webapp/controller/Statistics.controller.js`
- Reference: `app/admin-custom/webapp/view/TutorialDashboard.view.xml`
- Reference: `app/admin-custom/webapp/controller/TutorialDashboard.controller.js`
- Reference: `app/admin-custom/webapp/view/Privacy.view.xml`
- Reference: `app/admin-custom/webapp/controller/Privacy.controller.js`

- [ ] **Step 1: Copy and adapt Board view**

Copy `app/admin-custom/webapp/view/Board.view.xml` to `app/admin-shell/webapp/view/Board.view.xml`.

Change the `controllerName` from `sap.tutorials.admin.custom.controller.Board` to `sap.tutorials.admin.shell.controller.Board`.

Keep all bindings using `{admin>...}` model — this matches the shell's model name.

- [ ] **Step 2: Copy and adapt Board controller**

Copy `app/admin-custom/webapp/controller/Board.controller.js` to `app/admin-shell/webapp/controller/Board.controller.js`.

Change the controller extend name from `sap.tutorials.admin.custom.controller.Board` to `sap.tutorials.admin.shell.controller.Board`.

All `this.getOwnerComponent().getModel("admin")` calls remain unchanged since the shell declares an `"admin"` model.

- [ ] **Step 3: Copy and adapt TutorialDashboard view**

Copy `app/admin-custom/webapp/view/TutorialDashboard.view.xml` to `app/admin-shell/webapp/view/TutorialDashboard.view.xml`.

Change `controllerName` to `sap.tutorials.admin.shell.controller.TutorialDashboard`.

- [ ] **Step 4: Copy and adapt TutorialDashboard controller**

Copy `app/admin-custom/webapp/controller/TutorialDashboard.controller.js` to `app/admin-shell/webapp/controller/TutorialDashboard.controller.js`.

Change extend name to `sap.tutorials.admin.shell.controller.TutorialDashboard`.

- [ ] **Step 5: Copy and adapt Statistics view**

Copy `app/admin-custom/webapp/view/Statistics.view.xml` to `app/admin-shell/webapp/view/Statistics.view.xml`.

Change `controllerName` to `sap.tutorials.admin.shell.controller.Statistics`.

- [ ] **Step 6: Copy and adapt Statistics controller**

Copy `app/admin-custom/webapp/controller/Statistics.controller.js` to `app/admin-shell/webapp/controller/Statistics.controller.js`.

Change extend name to `sap.tutorials.admin.shell.controller.Statistics`.

- [ ] **Step 7: Copy and adapt Privacy view**

Copy `app/admin-custom/webapp/view/Privacy.view.xml` to `app/admin-shell/webapp/view/Privacy.view.xml`.

Change `controllerName` to `sap.tutorials.admin.shell.controller.Privacy`.

- [ ] **Step 8: Copy and adapt Privacy controller**

Copy `app/admin-custom/webapp/controller/Privacy.controller.js` to `app/admin-shell/webapp/controller/Privacy.controller.js`.

Change extend name to `sap.tutorials.admin.shell.controller.Privacy`.

- [ ] **Step 9: Commit**

```bash
git add app/admin-shell/webapp/view/Board.view.xml app/admin-shell/webapp/controller/Board.controller.js \
  app/admin-shell/webapp/view/TutorialDashboard.view.xml app/admin-shell/webapp/controller/TutorialDashboard.controller.js \
  app/admin-shell/webapp/view/Statistics.view.xml app/admin-shell/webapp/controller/Statistics.controller.js \
  app/admin-shell/webapp/view/Privacy.view.xml app/admin-shell/webapp/controller/Privacy.controller.js
git commit -m "feat(admin-shell): move freestyle views from admin-custom into shell (namespace adapted)"
```

---

### Task 7: Create manifest.json with Full Routing Configuration

**Files:**
- Create: `app/admin-shell/webapp/manifest.json`

- [ ] **Step 1: Create manifest.json**

Create `app/admin-shell/webapp/manifest.json`:

```json
{
  "_version": "1.65.0",
  "sap.app": {
    "id": "sap.tutorials.admin.shell",
    "type": "application",
    "title": "Admin Console",
    "description": "Unified admin shell for tutorial platform management",
    "applicationVersion": { "version": "0.0.1" },
    "dataSources": {
      "adminService": {
        "uri": "/admin/",
        "type": "OData",
        "settings": { "odataVersion": "4.0" }
      }
    }
  },
  "sap.ui": {
    "technology": "UI5",
    "deviceTypes": { "desktop": true, "tablet": true, "phone": true }
  },
  "sap.ui5": {
    "dependencies": {
      "minUI5Version": "1.136.0",
      "libs": {
        "sap.m": {},
        "sap.f": {},
        "sap.tnt": {},
        "sap.ui.core": {},
        "sap.ui.layout": {},
        "sap.ui.table": {}
      }
    },
    "resourceRoots": {
      "sap.tutorials.admin.events": "./components/events",
      "sap.tutorials.admin.missions": "./components/missions",
      "sap.tutorials.admin.groups": "./components/groups",
      "sap.tutorials.admin.tutorials": "./components/tutorials",
      "sap.tutorials.admin.tags": "./components/tags",
      "sap.tutorials.admin.accomplishments": "./components/accomplishments",
      "sap.tutorials.admin.prizes": "./components/prizes",
      "sap.tutorials.admin.operations": "./components/operations",
      "sap.tutorials.admin.accounts": "./components/accounts",
      "sap.tutorials.admin.changelog": "./components/changelog"
    },
    "models": {
      "admin": {
        "dataSource": "adminService",
        "settings": {
          "synchronizationMode": "None",
          "operationMode": "Server",
          "autoExpandSelect": true,
          "earlyRequests": false
        }
      }
    },
    "componentUsages": {
      "eventsComponent": {
        "name": "sap.tutorials.admin.events",
        "settings": {},
        "componentData": {},
        "lazy": true
      },
      "missionsComponent": {
        "name": "sap.tutorials.admin.missions",
        "settings": {},
        "componentData": {},
        "lazy": true
      },
      "groupsComponent": {
        "name": "sap.tutorials.admin.groups",
        "settings": {},
        "componentData": {},
        "lazy": true
      },
      "tutorialsComponent": {
        "name": "sap.tutorials.admin.tutorials",
        "settings": {},
        "componentData": {},
        "lazy": true
      },
      "tagsComponent": {
        "name": "sap.tutorials.admin.tags",
        "settings": {},
        "componentData": {},
        "lazy": true
      },
      "accomplishmentsComponent": {
        "name": "sap.tutorials.admin.accomplishments",
        "settings": {},
        "componentData": {},
        "lazy": true
      },
      "prizesComponent": {
        "name": "sap.tutorials.admin.prizes",
        "settings": {},
        "componentData": {},
        "lazy": true
      },
      "operationsComponent": {
        "name": "sap.tutorials.admin.operations",
        "settings": {},
        "componentData": {},
        "lazy": true
      },
      "accountsComponent": {
        "name": "sap.tutorials.admin.accounts",
        "settings": {},
        "componentData": {},
        "lazy": true
      },
      "changelogComponent": {
        "name": "sap.tutorials.admin.changelog",
        "settings": {},
        "componentData": {},
        "lazy": true
      }
    },
    "rootView": {
      "viewName": "sap.tutorials.admin.shell.view.Shell",
      "type": "XML",
      "id": "shell"
    },
    "routing": {
      "config": {
        "routerClass": "sap.m.routing.Router",
        "viewType": "XML",
        "viewPath": "sap.tutorials.admin.shell.view",
        "controlId": "contentArea",
        "controlAggregation": "pages",
        "clearControlAggregation": false
      },
      "routes": [
        { "name": "home", "pattern": "", "target": "homeTarget" },
        { "name": "events", "pattern": "events/{*path}", "target": "eventsTarget" },
        { "name": "missions", "pattern": "missions/{*path}", "target": "missionsTarget" },
        { "name": "groups", "pattern": "groups/{*path}", "target": "groupsTarget" },
        { "name": "tutorials", "pattern": "tutorials/{*path}", "target": "tutorialsTarget" },
        { "name": "tags", "pattern": "tags/{*path}", "target": "tagsTarget" },
        { "name": "accomplishments", "pattern": "accomplishments/{*path}", "target": "accomplishmentsTarget" },
        { "name": "prizes", "pattern": "prizes/{*path}", "target": "prizesTarget" },
        { "name": "operations", "pattern": "operations/{*path}", "target": "operationsTarget" },
        { "name": "accounts", "pattern": "accounts/{*path}", "target": "accountsTarget" },
        { "name": "changelog", "pattern": "changelog/{*path}", "target": "changelogTarget" },
        { "name": "board", "pattern": "board", "target": "boardTarget" },
        { "name": "dashboard", "pattern": "dashboard", "target": "dashboardTarget" },
        { "name": "statistics", "pattern": "statistics", "target": "statisticsTarget" },
        { "name": "privacy", "pattern": "privacy", "target": "privacyTarget" }
      ],
      "targets": {
        "homeTarget": {
          "type": "View",
          "name": "Home",
          "viewLevel": 0
        },
        "eventsTarget": {
          "type": "Component",
          "usage": "eventsComponent",
          "options": { "manifest": true }
        },
        "missionsTarget": {
          "type": "Component",
          "usage": "missionsComponent",
          "options": { "manifest": true }
        },
        "groupsTarget": {
          "type": "Component",
          "usage": "groupsComponent",
          "options": { "manifest": true }
        },
        "tutorialsTarget": {
          "type": "Component",
          "usage": "tutorialsComponent",
          "options": { "manifest": true }
        },
        "tagsTarget": {
          "type": "Component",
          "usage": "tagsComponent",
          "options": { "manifest": true }
        },
        "accomplishmentsTarget": {
          "type": "Component",
          "usage": "accomplishmentsComponent",
          "options": { "manifest": true }
        },
        "prizesTarget": {
          "type": "Component",
          "usage": "prizesComponent",
          "options": { "manifest": true }
        },
        "operationsTarget": {
          "type": "Component",
          "usage": "operationsComponent",
          "options": { "manifest": true }
        },
        "accountsTarget": {
          "type": "Component",
          "usage": "accountsComponent",
          "options": { "manifest": true }
        },
        "changelogTarget": {
          "type": "Component",
          "usage": "changelogComponent",
          "options": { "manifest": true }
        },
        "boardTarget": {
          "type": "View",
          "name": "Board",
          "viewLevel": 1
        },
        "dashboardTarget": {
          "type": "View",
          "name": "TutorialDashboard",
          "viewLevel": 1
        },
        "statisticsTarget": {
          "type": "View",
          "name": "Statistics",
          "viewLevel": 1
        },
        "privacyTarget": {
          "type": "View",
          "name": "Privacy",
          "viewLevel": 1
        }
      },
      "bypassed": {
        "target": "homeTarget"
      }
    }
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add app/admin-shell/webapp/manifest.json
git commit -m "feat(admin-shell): add manifest.json with full routing, componentUsages, and resourceRoots"
```

---

### Task 8: Update Approuter to Serve Shell App

**Files:**
- Modify: `approuter/server.js` (replace `APP_MOUNTS` object)

- [ ] **Step 1: Replace APP_MOUNTS in approuter/server.js**

Replace the `APP_MOUNTS` object (lines 25-38) with the following. Note: the order matters — more-specific paths (`/admin-ui/components/*`) must appear before the base `/admin-ui` path because the existing `adminAppsHandler` iterates in order, matching the first prefix:

```javascript
const APP_MOUNTS = {
  '/admin-ui/components/events': join(__dirname, '..', 'app', 'admin', 'events', 'webapp'),
  '/admin-ui/components/missions': join(__dirname, '..', 'app', 'admin', 'missions', 'webapp'),
  '/admin-ui/components/groups': join(__dirname, '..', 'app', 'admin', 'groups', 'webapp'),
  '/admin-ui/components/tutorials': join(__dirname, '..', 'app', 'admin', 'tutorials', 'webapp'),
  '/admin-ui/components/tags': join(__dirname, '..', 'app', 'admin', 'tags', 'webapp'),
  '/admin-ui/components/accomplishments': join(__dirname, '..', 'app', 'admin', 'accomplishments', 'webapp'),
  '/admin-ui/components/prizes': join(__dirname, '..', 'app', 'admin', 'prizes', 'webapp'),
  '/admin-ui/components/operations': join(__dirname, '..', 'app', 'admin', 'operations', 'webapp'),
  '/admin-ui/components/accounts': join(__dirname, '..', 'app', 'admin', 'accounts', 'webapp'),
  '/admin-ui/components/changelog': join(__dirname, '..', 'app', 'admin', 'changelog', 'webapp'),
  '/admin-ui': join(__dirname, '..', 'app', 'admin-shell', 'webapp')
}
```

- [ ] **Step 2: Verify approuter still starts**

Run: `cd approuter && node -e "require('./server.js')" 2>&1 | head -5` (expect no module errors; it may fail on port bind which is fine)

Actually a better check — just verify the syntax parses:

Run: `node -c approuter/server.js`
Expected: `approuter/server.js: no syntax errors`

- [ ] **Step 3: Commit**

```bash
git add approuter/server.js
git commit -m "feat(approuter): replace 12 legacy APP_MOUNTS with admin-shell + component paths"
```

---

### Task 9: Delete Retired Files

**Files:**
- Delete: `app/admin-flp/` (entire directory)
- Delete: `app/admin-custom/` (entire directory)
- Delete: `app/admin/events/webapp/index.html`
- Delete: `app/admin/missions/webapp/index.html`
- Delete: `app/admin/groups/webapp/index.html`
- Delete: `app/admin/tutorials/webapp/index.html`
- Delete: `app/admin/tags/webapp/index.html`
- Delete: `app/admin/accomplishments/webapp/index.html`
- Delete: `app/admin/prizes/webapp/index.html`
- Delete: `app/admin/operations/webapp/index.html`
- Delete: `app/admin/accounts/webapp/index.html`
- Delete: `app/admin/changelog/webapp/index.html`

- [ ] **Step 1: Delete admin-flp directory**

Run: `rm -rf app/admin-flp`

- [ ] **Step 2: Delete admin-custom directory**

Run: `rm -rf app/admin-custom`

- [ ] **Step 3: Delete all Fiori Elements index.html files**

Run: `rm app/admin/events/webapp/index.html app/admin/missions/webapp/index.html app/admin/groups/webapp/index.html app/admin/tutorials/webapp/index.html app/admin/tags/webapp/index.html app/admin/accomplishments/webapp/index.html app/admin/prizes/webapp/index.html app/admin/operations/webapp/index.html app/admin/accounts/webapp/index.html app/admin/changelog/webapp/index.html`

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "chore: delete retired admin-flp, admin-custom, and standalone index.html files"
```

---

### Task 10: Create Build Script (copy-components.js)

**Files:**
- Create: `app/admin-shell/scripts/copy-components.js`

- [ ] **Step 1: Create copy-components.js**

Create `app/admin-shell/scripts/copy-components.js`:

```javascript
const { cpSync, mkdirSync } = require('fs')
const { join } = require('path')

const DIST = join(__dirname, '..', 'dist')
const COMPONENTS_DIR = join(DIST, 'components')
const ADMIN_DIR = join(__dirname, '..', '..', 'admin')

const COMPONENTS = [
  'events',
  'missions',
  'groups',
  'tutorials',
  'tags',
  'accomplishments',
  'prizes',
  'operations',
  'accounts',
  'changelog'
]

mkdirSync(COMPONENTS_DIR, { recursive: true })

for (const name of COMPONENTS) {
  const src = join(ADMIN_DIR, name, 'webapp')
  const dest = join(COMPONENTS_DIR, name)
  cpSync(src, dest, { recursive: true })
  console.log(`  Copied ${name}`)
}

console.log(`\nAll ${COMPONENTS.length} components copied to dist/components/`)
```

- [ ] **Step 2: Commit**

```bash
git add app/admin-shell/scripts/copy-components.js
git commit -m "feat(admin-shell): add copy-components.js build script for production deployment"
```

---

### Task 11: Update mta.yaml and Root Build Script

**Files:**
- Modify: `mta.yaml` (lines 73-93 — `tutorials-admin-ui-deployer` module)
- Modify: `package.json` (root — `build:admin` script)

- [ ] **Step 1: Replace the tutorials-admin-ui-deployer module in mta.yaml**

Replace lines 73-93 of `mta.yaml` (the `tutorials-admin-ui-deployer` module) with:

```yaml
  - name: tutorials-admin-ui-deployer
    type: com.sap.html5.application-content
    path: app/admin-shell
    build-parameters:
      builder: custom
      commands:
        - npm install && npm run build
      build-result: dist
      supported-platforms: []
    requires:
      - name: tutorials-html5-repo-host
        parameters:
          content-target: true
```

- [ ] **Step 2: Update root package.json build:admin script**

Replace the `build:admin` script in the root `package.json`:

Old: `"build:admin": "npm --prefix app/admin run build && npm --prefix app/admin-custom run build"`

New: `"build:admin": "npm --prefix app/admin-shell run build"`

- [ ] **Step 3: Verify YAML syntax**

Run: `node -e "const yaml = require('js-yaml'); const fs = require('fs'); yaml.load(fs.readFileSync('mta.yaml', 'utf8')); console.log('mta.yaml: valid')"`

If `js-yaml` is not installed, run: `npx js-yaml mta.yaml > /dev/null && echo "valid"`

- [ ] **Step 4: Commit**

```bash
git add mta.yaml package.json
git commit -m "feat(deploy): simplify admin UI deployer to single shell build"
```

---

### Task 12: Local Smoke Test

**Files:** (no new files — verification only)

- [ ] **Step 1: Start CAP backend**

Run in a terminal: `cds watch` (wait for "server listening on http://localhost:4004")

- [ ] **Step 2: Start approuter**

Run in a second terminal: `cd approuter && node server.js` (wait for port binding, default 5000)

- [ ] **Step 3: Open shell in browser**

Navigate to: `http://localhost:5000/admin-ui/index.html`

Expected:
- ToolPage renders with side navigation on the left
- Header shows "Tutorial Platform — Admin Console" with theme toggle
- Home tile grid is visible in the content area
- Side nav shows Home, Content (5 items), Rewards (2 items), System (7 items)

- [ ] **Step 4: Test navigation to a Fiori Elements app**

Click "Events" in the side nav (or the Events tile).

Expected:
- URL hash changes to `#/events/`
- Events ListReport appears in the content area
- Side nav highlights "Events"

- [ ] **Step 5: Test navigation to a freestyle view**

Click "Board" in the side nav.

Expected:
- URL hash changes to `#/board`
- Board view renders with tutorial health tiles
- Side nav highlights "Board"

- [ ] **Step 6: Test theme toggle**

Click the dark mode button in the header toolbar.

Expected:
- Theme switches to `sap_horizon_dark`
- All controls render in dark mode
- `localStorage` contains `sap-tutorials-admin-theme: sap_horizon_dark`

- [ ] **Step 7: Test nav collapse**

Click the hamburger menu icon.

Expected:
- Side nav collapses to icon-only mode (~48px)
- Content area expands to fill available space
- `localStorage` contains `sap-tutorials-admin-nav-expanded: false`

- [ ] **Step 8: Test deep linking to child route**

Navigate directly to: `http://localhost:5000/admin-ui/index.html#/events/Events(1)`

Expected:
- Events ObjectPage renders for ID 1 (or shows "not found" if ID doesn't exist — either confirms child routing works)

---

### Task 13: Update CLAUDE.md

**Files:**
- Modify: `CLAUDE.md` (Admin UI section)

- [ ] **Step 1: Update the Admin UI section in CLAUDE.md**

Replace the "Admin UI (app/)" section with:

```markdown
### Admin UI (app/)

- **`app/admin-shell/`** — Unified admin shell using `sap.tnt.ToolPage` with collapsible side navigation, theme switching (light/dark/auto), and Router-managed content area
- **`app/admin/`** — 10 Fiori Elements apps (events, missions, groups, accomplishments, prizes, tutorials, tags, operations, accounts, changelog) — loaded as headless components by the shell via `componentUsages`
- **`app/admin-annotations.cds`** — All @UI/@Common CDS annotations for admin screens
- Deployed via HTML5 Application Repository (`tutorials-admin-ui-deployer` module in mta.yaml)
- **Production access**: `/admin-ui/` route (XSUAA-protected, served from HTML5 App Repository)
- **Local dev access**: `/admin-ui/` — served by `adminAppsHandler` middleware in `approuter/server.js`; component sub-resources at `/admin-ui/components/<name>/`
- **Theme**: `sap_horizon` (light) / `sap_horizon_dark` (dark), auto-detects OS preference, persisted to `localStorage` key `sap-tutorials-admin-theme`
```

- [ ] **Step 2: Update the Gotchas section**

Replace the `/admin/` gotcha entry:

```markdown
- **`/admin/` is OData only** — The AdminService OData endpoint lives at `/admin/`. The admin shell UI is served at `/admin-ui/` to avoid path collisions.
```

Remove the reference to `/apps/*` mount paths.

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: update CLAUDE.md for admin-shell architecture"
```

---

## Summary

| Task | Description | Commits |
|------|-------------|---------|
| 1 | Shell app scaffold | 1 |
| 2 | Component.js with theme detection | 1 |
| 3 | Navigation model | 1 |
| 4 | Shell view and controller | 1 |
| 5 | Home view (tile grid) | 1 |
| 6 | Move freestyle views | 1 |
| 7 | manifest.json with routing | 1 |
| 8 | Update approuter | 1 |
| 9 | Delete retired files | 1 |
| 10 | Build script | 1 |
| 11 | Update mta.yaml + root build script | 1 |
| 12 | Local smoke test | 0 |
| 13 | Update CLAUDE.md | 1 |
| **Total** | | **11 commits** |
