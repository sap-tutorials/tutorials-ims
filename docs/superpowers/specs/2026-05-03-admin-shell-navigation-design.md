# Admin Shell Navigation Design

## Summary

Replace the current 11 separate UI5 admin apps (each with their own `index.html` and independent bootstrap) with a single unified shell app using `sap.tnt.ToolPage`. The shell provides a BTP Cockpit-style collapsible side navigation, a tile-grid home view, and light/dark mode with OS auto-detection.

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
│   │   ├── Shell.view.xml      ← ToolPage + SideNavigation + ComponentContainer
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
| `sap.tnt.NavigationListItem` | Individual nav items |
| `sap.m.ToolHeader` | Shell header bar |
| `sap.ui.core.ComponentContainer` | Dynamic loading of feature components |

### Existing Apps as Headless Components

Each Fiori Elements app (`app/admin/events/`, etc.) retains its `Component.js`, `manifest.json`, and internal routing. The `index.html` files are deleted — apps no longer bootstrap independently.

The shell declares each as a `componentUsage` in its `manifest.json` and loads them into a `ComponentContainer` when the user navigates to that feature.

### Retirement

| Directory | Action |
|-----------|--------|
| `app/admin-flp/` | Delete entirely (replaced by Home view) |
| `app/admin-custom/` | Delete entirely (views moved into shell) |
| `app/admin/*/webapp/index.html` | Delete (11 files) |

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

This uses UI5's nested component routing — the shell router delegates to the child component's router for the path suffix.

### Component Lifecycle

- Components are loaded lazily on first access
- Once loaded, they remain in memory for the session duration
- Navigation between features hides/shows components (no destroy/recreate)
- This preserves in-progress state within a session

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
        { "key": "dashboard", "title": "Dashboard", "icon": "sap-icon://monitor-payments" },
        { "key": "statistics", "title": "Statistics", "icon": "sap-icon://bar-chart" },
        { "key": "privacy", "title": "Privacy", "icon": "sap-icon://shield" }
      ]
    }
  ]
}
```

### Behavior

- **Hamburger button** toggles between expanded (220px) and collapsed (icon-only, ~48px)
- **Group headers** expand/collapse their children
- **Collapsed state** shows only icons; hovering shows tooltip with the item name
- **Active item** highlighted with left border accent (like BTP Cockpit)
- **Home** is a fixed item at the top of the nav (above groups), always visible
- Collapse/expand state persisted to `localStorage`

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
    supported-platforms: []
  requires:
    - name: tutorials-html5-repo-host
      parameters:
        content-target: true
```

### Build Step

The shell app's build script:
1. Builds the shell (views, controllers, model)
2. Copies each feature component's `webapp/` into the output at `components/<name>/`
3. Produces a single deployable artifact for the HTML5 repo

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

### Approuter Changes

Local development (`approuter/server.js`):

```javascript
// Replace 12 mount points with structured paths
const APP_MOUNTS = {
  '/admin-ui': join(__dirname, '..', 'app', 'admin-shell', 'webapp'),
  '/admin-ui/components/events': join(__dirname, '..', 'app', 'admin', 'events', 'webapp'),
  '/admin-ui/components/missions': join(__dirname, '..', 'app', 'admin', 'missions', 'webapp'),
  // ... one per feature
}
```

Production: The HTML5 Application Repository serves the entire built artifact at the configured route.

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
