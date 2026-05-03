# Admin Shell Navigation Design

## Summary

Replace the current 11 separate UI5 admin apps (10 Fiori Elements + 1 freestyle, each with their own `index.html` and independent bootstrap) with a single unified shell app using `sap.tnt.ToolPage`. The shell provides a BTP Cockpit-style collapsible side navigation, a tile-grid home view, and light/dark mode with OS auto-detection.

## Goals

- Single-page app experience with seamless navigation between admin features
- Collapsible tree-style side navigation (expand/collapse groups, minimize to icon-only)
- Keep the FLP-style tile grid as a Home view inside the shell
- Light/dark mode using `sap_horizon` / `sap_horizon_dark` with OS preference detection
- Single deployable unit to HTML5 Application Repository
- No migration concerns — project is not yet live

## Architecture

### New App: `app/admin-shell/`

A single UI5 application using `sap.tnt.ToolPage` as the root layout control.

```
app/admin-shell/
├── webapp/
│   ├── index.html              ← sole UI5 bootstrap for all admin
│   ├── Component.js            ← root component, theme init, nav model
│   ├── manifest.json           ← routes + componentUsages for all features
│   ├── controller/
│   │   ├── Shell.controller.js ← nav toggle, theme switch, component loading
│   │   ├── Home.controller.js  ← tile grid interactions
│   │   ├── Board.controller.js
│   │   ├── Statistics.controller.js
│   │   ├── TutorialDashboard.controller.js
│   │   └── Privacy.controller.js
│   ├── view/
│   │   ├── Shell.view.xml      ← ToolPage + SideNavigation + NavContainer
│   │   ├── Home.view.xml       ← tile grid (replaces admin-flp)
│   │   ├── Board.view.xml      ← moved from admin-custom
│   │   ├── Statistics.view.xml
│   │   ├── TutorialDashboard.view.xml
│   │   └── Privacy.view.xml
│   └── model/
│       └── navigation.json     ← nav tree structure
```

### Key UI5 Controls

| Control | Purpose |
|---------|---------|
| `sap.tnt.ToolPage` | Shell layout (side nav + content area) |
| `sap.tnt.SideNavigation` | Collapsible tree navigation |
| `sap.tnt.NavigationList` | Groups within the side nav |
| `sap.tnt.NavigationListItem` | Individual nav items (nested = collapsible groups) |
| `sap.m.ToolHeader` | Shell header bar |
| `sap.m.NavContainer` | Content area — Router places View/Component targets here |

### Shell OData Model

The shell's `manifest.json` declares the shared OData V4 model that the inline views (Board, Statistics, Dashboard, Privacy) consume:

```json
{
  "sap.app": {
    "dataSources": {
      "adminService": {
        "uri": "/admin/",
        "type": "OData",
        "settings": { "odataVersion": "4.0" }
      }
    }
  },
  "sap.ui5": {
    "models": {
      "admin": {
        "dataSource": "adminService",
        "settings": { "synchronizationMode": "None", "operationMode": "Server" }
      }
    }
  }
}
```

The Fiori Elements child components declare their own default ("") model internally — they do not inherit the shell's model.

### Existing Apps as Headless Components

Each Fiori Elements app (`app/admin/events/`, etc.) retains its `Component.js`, `manifest.json`, and internal routing. The `index.html` files are deleted — apps no longer bootstrap independently.

The shell declares each as a `componentUsage` in its `manifest.json` and loads them into a `ComponentContainer` when the user navigates to that feature.

#### componentUsages Declaration

In the shell's `manifest.json` under `sap.ui5`:

```json
{
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
    }
  }
}
```

One entry per feature component (events, missions, groups, tutorials, tags, accomplishments, prizes, operations, accounts, changelog — 10 total).

#### Component Loading via Router Targets

The shell does NOT use a single shared `<ComponentContainer>` with bindable `usage`. Instead, the UI5 Router manages component creation and placement using `type: "Component"` targets. The shell view provides a `NavContainer` as the content area:

```xml
<!-- In Shell.view.xml, inside ToolPage mainContents -->
<NavContainer id="contentArea" />
```

The Router places both View targets and Component targets into this container's `pages` aggregation. The Router creates `ComponentContainer` instances automatically for Component targets — no explicit `<ComponentContainer>` in the view XML.

Routing configuration (full example in shell `manifest.json`):

```json
{
  "routing": {
    "config": {
      "routerClass": "sap.m.routing.Router",
      "controlId": "contentArea",
      "controlAggregation": "pages",
      "clearControlAggregation": false
    },
    "routes": [
      { "name": "home", "pattern": "", "target": "homeTarget" },
      { "name": "events", "pattern": "events/{*path}", "target": "eventsTarget" },
      { "name": "missions", "pattern": "missions/{*path}", "target": "missionsTarget" },
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
```

Key points:

- `clearControlAggregation: false` preserves previously loaded components in the NavContainer (they're hidden, not destroyed) — this enables session-state preservation
- `type: "View"` targets handle shell-internal views (Board, Statistics, etc.)
- `type: "Component"` targets handle Fiori Elements apps via `componentUsages`
- `bypassed` configuration redirects invalid hashes back to Home
- `{*path}` is the "greedy parameter" syntax available since UI5 1.90+ for nested component routing, confirmed compatible with the project's 1.136.0 baseline

### Retirement

| Directory | Action |
|-----------|--------|
| `app/admin-flp/` | Delete entirely (replaced by Home view) |
| `app/admin-custom/` | Delete entirely (views moved into shell) |
| `app/admin/*/webapp/index.html` | Delete (10 files — one per Fiori Elements app) |

## Routing

### Shell-Level Routes

```
Route Pattern                → Target
────────────────────────────────────────────────
""                           → Home view (tile grid)
"events/{*path}"             → sap.tutorials.admin.events component
"missions/{*path}"           → sap.tutorials.admin.missions component
"groups/{*path}"             → sap.tutorials.admin.groups component
"tutorials/{*path}"          → sap.tutorials.admin.tutorials component
"tags/{*path}"               → sap.tutorials.admin.tags component
"accomplishments/{*path}"    → sap.tutorials.admin.accomplishments component
"prizes/{*path}"             → sap.tutorials.admin.prizes component
"operations/{*path}"         → sap.tutorials.admin.operations component
"accounts/{*path}"           → sap.tutorials.admin.accounts component
"changelog/{*path}"          → sap.tutorials.admin.changelog component
"board"                      → Board view (shell-internal)
"dashboard"                  → TutorialDashboard view (shell-internal)
"statistics"                 → Statistics view (shell-internal)
"privacy"                    → Privacy view (shell-internal)
```

### Component Routing (Child Routers)

The `{*path}` suffix passes through to each feature's internal router. For example:
- `#/events/` → Events ListReport
- `#/events/Events(123)` → Event ObjectPage for ID 123

When the shell router matches `events/{*path}`, the `{*path}` remainder (e.g., `Events(123)`) is passed to the child component's router as its hash. The child component's `manifest.json` already declares its own routes (e.g., `"pattern": ":?query:"` for ListReport, `"pattern": "Events({key}):?query:"` for ObjectPage) — these continue to work unchanged.

The shell does NOT need to know the child's internal routes. It only captures the prefix (`events/`) and delegates everything after it. See the full routing config in "Component Loading via Router Targets" above for the manifest structure.

#### Multi-View Feature Apps

Some feature components (notably `operations` and `accounts`) have multiple internal views beyond the standard ListReport + ObjectPage pattern. Their internal routing handles this transparently — the shell treats them identically to simpler features. The `{*path}` wildcard passes through any internal route structure without modification.

### Component Lifecycle

- Components are loaded lazily on first access (Router creates the ComponentContainer on first route match)
- Once loaded, they remain in the `NavContainer`'s `pages` aggregation for the session duration (`clearControlAggregation: false`)
- Navigation between features shows the target page and hides others — no destroy/recreate
- This preserves in-progress state (e.g., unsaved draft edits, scroll position) within a session
- Memory is bounded by the number of features (max 14 pages) — acceptable for an admin tool

## Side Navigation

### Structure

Three collapsible groups matching the current tile categories:

```json
{
  "groups": [
    {
      "key": "content",
      "title": "Content",
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
      "expanded": true,
      "items": [
        { "key": "accomplishments", "title": "Accomplishments", "icon": "sap-icon://badge" },
        { "key": "prizes", "title": "Prizes", "icon": "sap-icon://gift" }
      ]
    },
    {
      "key": "system",
      "title": "System",
      "expanded": true,
      "items": [
        { "key": "operations", "title": "Operations", "icon": "sap-icon://action-settings" },
        { "key": "accounts", "title": "Accounts", "icon": "sap-icon://person-placeholder" },
        { "key": "changelog", "title": "Change Log", "icon": "sap-icon://history" },
        { "key": "board", "title": "Board", "icon": "sap-icon://dashboard" },
        { "key": "dashboard", "title": "Dashboard", "icon": "sap-icon://monitor-payments", "viewName": "TutorialDashboard" },
        { "key": "statistics", "title": "Statistics", "icon": "sap-icon://bar-chart" },
        { "key": "privacy", "title": "Privacy", "icon": "sap-icon://shield" }
      ]
    }
  ]
}
```

### Behavior

- **Hamburger button** toggles between expanded (220px) and collapsed (icon-only, ~48px)
- **Group headers** expand/collapse their children (this is `NavigationListItem` with nested `items` aggregation — the parent item acts as the group toggle, child items are the actual nav links)
- **Collapsed state** shows only icons; hovering shows tooltip with the item name
- **Active item** highlighted with left border accent (like BTP Cockpit)
- **Home** is a fixed item at the top of the nav (above groups), always visible
- Collapse/expand state persisted to `localStorage`

#### XML Structure for Grouped Navigation

```xml
<tnt:SideNavigation id="sideNav" selectedKey="{viewModel>/selectedNavKey}">
  <tnt:NavigationList>
    <tnt:NavigationListItem text="Home" icon="sap-icon://home" key="home" />
    <tnt:NavigationListItem text="Content" icon="sap-icon://folder-blank" expanded="true">
      <tnt:NavigationListItem text="Events" icon="sap-icon://calendar" key="events" />
      <tnt:NavigationListItem text="Missions" icon="sap-icon://target-group" key="missions" />
      <!-- ... -->
    </tnt:NavigationListItem>
    <tnt:NavigationListItem text="Rewards" icon="sap-icon://gift" expanded="true">
      <tnt:NavigationListItem text="Accomplishments" icon="sap-icon://badge" key="accomplishments" />
      <tnt:NavigationListItem text="Prizes" icon="sap-icon://gift" key="prizes" />
    </tnt:NavigationListItem>
    <tnt:NavigationListItem text="System" icon="sap-icon://action-settings" expanded="true">
      <!-- ... -->
    </tnt:NavigationListItem>
  </tnt:NavigationList>
</tnt:SideNavigation>
```

Parent `NavigationListItem` elements with nested children serve as collapsible group headers. The `expanded` property controls initial state. When the side nav is collapsed to icon-only mode, only the group-level icons show.

## Theme Switching (Dark/Light Mode)

### Detection Logic

On app initialization (`Component.js` `init`):

1. Check `localStorage` for key `sap-tutorials-admin-theme`
2. If not set, check `window.matchMedia("(prefers-color-scheme: dark)")`
3. Apply `sap_horizon_dark` or `sap_horizon` accordingly

### Manual Toggle

A segmented button or menu in the header toolbar with three states:
- **Auto** — follows OS (removes localStorage key)
- **Light** — forces `sap_horizon` (saves to localStorage)
- **Dark** — forces `sap_horizon_dark` (saves to localStorage)

### Live OS Tracking

When in "Auto" mode, a `matchMedia` change listener updates the theme in real-time if the user changes their OS preference while the app is open.

### Implementation

```javascript
// In Component.js init()
const stored = localStorage.getItem("sap-tutorials-admin-theme");
const osDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
const theme = stored || (osDark ? "sap_horizon_dark" : "sap_horizon");
Theming.setTheme(theme);

// OS preference listener (active when mode is "auto")
window.matchMedia("(prefers-color-scheme: dark)")
  .addEventListener("change", (e) => {
    if (!localStorage.getItem("sap-tutorials-admin-theme")) {
      Theming.setTheme(e.matches ? "sap_horizon_dark" : "sap_horizon");
    }
  });
```

No custom dark-mode CSS is needed — `sap_horizon_dark` provides complete styling for all UI5 controls including `sap.tnt.*` and `sap.fe.*`.

## Deployment

### MTA Changes

The `tutorials-admin-ui-deployer` module simplifies from 10 build commands to 1:

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

The `build-result: dist` tells the MTA builder to deploy the contents of `app/admin-shell/dist/` (the output of the build script) to the HTML5 Application Repository.

### Build Step

The shell app's `package.json` includes a build script (`npm run build`) that uses `ui5 build` to produce the deployable artifact:

```json
{
  "scripts": {
    "build": "ui5 build --clean-dest --dest dist && node scripts/copy-components.js"
  }
}
```

`scripts/copy-components.js` copies each feature component's `webapp/` contents into `dist/components/<name>/`. This is a simple file-copy, not a UI5 build of each component — Fiori Elements apps don't need a build step (they use framework libraries loaded from CDN/UI5 resources at runtime). Custom extensions (e.g., `ext/ItemReorder` in groups/missions) are included in the file copy and work without compilation.

Output structure:
```
dist/
├── index.html
├── Component.js
├── manifest.json
├── controller/
├── view/
├── model/
└── components/
    ├── events/         ← copied from app/admin/events/webapp/
    ├── missions/
    ├── groups/
    ├── tutorials/
    ├── tags/
    ├── accomplishments/
    ├── prizes/
    ├── operations/
    ├── accounts/
    └── changelog/
```

The `manifest.json` resourceRoots must resolve component paths relative to the shell:

```json
{
  "sap.ui5": {
    "resourceRoots": {
      "sap.tutorials.admin.events": "./components/events",
      "sap.tutorials.admin.missions": "./components/missions"
    }
  }
}
```

### Local Development (No Build Required)

During local development, no build step is needed. The approuter's middleware serves the shell and component directories directly:

```javascript
const APP_MOUNTS = {
  '/admin-ui': join(__dirname, '..', 'app', 'admin-shell', 'webapp'),
  '/admin-ui/components/events': join(__dirname, '..', 'app', 'admin', 'events', 'webapp'),
  '/admin-ui/components/missions': join(__dirname, '..', 'app', 'admin', 'missions', 'webapp'),
  // ... one per feature component
}
```

The shell's `manifest.json` uses relative `resourceRoots` (`"./components/events"`) which resolve correctly both locally (where the approuter maps the path) and in production (where the files exist in `dist/components/`). No manifest overrides or environment branching needed.

In production, the HTML5 Application Repository serves the entire built artifact at the configured route.

### xs-app.json Route

```json
{ "source": "^/admin-ui/(.*)$", "target": "/admin-ui/$1", "service": "html5-apps-repo-rt" }
```

## Home View

The tile grid from the current `admin-flp/webapp/index.html` becomes a proper UI5 XML view (`Home.view.xml`) using `sap.m.GenericTile` or `sap.f.GridContainer` for the tile layout. Tiles navigate to the same routes as the side nav items.

Grouped into sections:
- **Content Management** — Events, Missions, Groups, Tutorials, Tags
- **Rewards & Recognition** — Accomplishments, Prizes
- **System** — Operations, Accounts, Change Log, Board, Dashboard, Statistics, Privacy

## CLAUDE.md Updates

After implementation:
- Document `/admin-ui/` as the single admin entry point
- Remove references to `/apps/*` mount paths and `admin-flp`
- Document the shell component architecture
- Update the "Admin UI" section describing `sap.tnt.ToolPage` pattern
- Note theme switching behavior and localStorage key
