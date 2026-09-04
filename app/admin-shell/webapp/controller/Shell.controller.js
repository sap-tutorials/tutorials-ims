sap.ui.define([
  "sap/ui/core/mvc/Controller",
  "sap/ui/core/Theming",
  "sap/ui/core/routing/HashChanger",
  "sap/ui/model/json/JSONModel"
], function (Controller, Theming, HashChanger, JSONModel) {
  "use strict";

  var NAV_KEY_TO_ROUTE = {
    dashboard: "dashboard",
    events: "events",
    missions: "missions",
    groups: "groups",
    puzzles: "puzzles",
    tutorials: "tutorials",
    tags: "tags",
    categories: "categories",
    concepts: "concepts",
    advocates: "advocates",
    alerts: "alerts",
    homepageShelves: "homepageShelves",
    homepageRedirects: "homepageRedirects",
    homepageConfig: "homepageConfig",
    accomplishments: "accomplishments",
    prizes: "prizes",
    operations: "operations",
    pipelinelog: "pipelinelog",
    joblog: "joblog",
    accounts: "accounts",
    changelog: "changelog",
    privacyAudit: "privacyAudit",
    devtoberfest: "devtoberfest",
    devtoberfestSignups: "devtoberfestSignups",
    board: "board",
    analytics: "analytics",
    tutorialEngagement: "tutorialEngagement",
    tutorialCompletions: "tutorialCompletions",
    statistics: "statistics",
    metrics: "metrics",
    joule: "joule",
    knowledgeGraph: "knowledgeGraph",
    kgCommunities: "kgCommunities",
    kgOnDemand: "kgOnDemand",
    secrets: "secrets",
    privacy: "privacy",
    feedbackList: "feedbackList",
    feedbackDashboard: "feedbackDashboard",
    dataExport: "dataExport",
    uiEvents: "uiEvents",
    search: "search",
    navigator: "navigator",
    display: "display",
    tenant: "tenant",
    featureFlags: "featureFlags",
    ngds: "ngds",
    verbDefinitions: "verbDefinitions",
    shelfDefinitions: "shelfDefinitions",
    forYou: "forYou",
    featuredTopics: "featuredTopics",
    videos: "videos",
    videoRotation: "videoRotation",
    pats: "pats",
    petoberfest: "petoberfest",
    petoberfestContests: "petoberfestContests",
    topicClusters: "topicClusters"
  };

  var NAV_KEY_TO_TITLE = {
    dashboard: "Tutorial Health",
    events: "Events",
    missions: "Missions",
    groups: "Groups",
    puzzles: "Puzzles",
    tutorials: "Tutorials",
    tags: "Tags",
    categories: "Categories",
    concepts: "Concepts",
    advocates: "Advocates",
    alerts: "Alerts",
    homepageShelves: "Homepage Shelves",
    homepageRedirects: "Homepage Redirects",
    homepageConfig: "Homepage Config",
    accomplishments: "Accomplishments",
    prizes: "Prizes",
    operations: "Operations",
    pipelinelog: "Pipeline Log",
    joblog: "Job Log",
    accounts: "Account Merges",
    changelog: "Change Log",
    privacyAudit: "Privacy Audit",
    devtoberfest: "Devtoberfest Event Edit",
    devtoberfestSignups: "Devtoberfest Signups",
    board: "Board",
    analytics: "Completion analytics",
    tutorialEngagement: "Tutorial Engagement",
    tutorialCompletions: "Tutorial Completions",
    statistics: "Statistics",
    metrics: "Observability",
    joule: "Joule Settings",
    knowledgeGraph: "Knowledge Graph",
    kgCommunities: "KG Communities",
    kgOnDemand: "KG On-Demand",
    secrets: "Secrets",
    privacy: "Privacy",
    feedbackList: "Tutorial Feedback",
    feedbackDashboard: "Feedback Dashboard",
    dataExport: "Data Export",
    uiEvents: "UI Events",
    search: "Search",
    navigator: "Navigator",
    display: "Display",
    tenant: "Tenant",
    featureFlags: "Feature Flags",
    ngds: "NGDS Auto-Send",
    verbDefinitions: "Verb definitions",
    shelfDefinitions: "Shelf definitions",
    forYou: "For-you Candidates",
    featuredTopics: "Featured Topics",
    videos: "Videos",
    videoRotation: "Video Rotation",
    pats: "Personal Access Tokens",
    petoberfest: "Pet Photo Moderation",
    petoberfestContests: "Petoberfest Contests",
    topicClusters: "Topic Clusters"
  };

  return Controller.extend("sap.tutorials.admin.shell.controller.Shell", {
    onInit: function () {
      var oComponent = this.getOwnerComponent();
      var oViewModel = oComponent.getShellViewModel();
      var bExpanded = localStorage.getItem("sap-tutorials-admin-nav-expanded") !== "false";
      oViewModel.setProperty("/sideExpanded", bExpanded);
      oViewModel.setProperty("/userInitials", "");
      oViewModel.setProperty("/userName", "");
      oViewModel.setProperty("/userEmail", "");
      this.getView().setModel(oViewModel, "viewModel");

      oComponent.getRouter().attachRouteMatched(this._onRouteMatched, this);
      this._attachHashChangeDetection();
      this._loadUserProfile();
      this._loadVersion();

      // #2041 — Ctrl+K / Cmd+K opens the page-search palette globally.
      this._fnGlobalKeydown = this._onGlobalKeydown.bind(this);
      document.addEventListener("keydown", this._fnGlobalKeydown);
    },

    onExit: function () {
      if (this._fnGlobalKeydown) {
        document.removeEventListener("keydown", this._fnGlobalKeydown);
        this._fnGlobalKeydown = null;
      }
    },

    onNavBack: function () {
      window.history.back();
    },

    onToggleSideNav: function () {
      var oModel = this.getView().getModel("viewModel");
      var bExpanded = !oModel.getProperty("/sideExpanded");
      oModel.setProperty("/sideExpanded", bExpanded);
      localStorage.setItem("sap-tutorials-admin-nav-expanded", bExpanded);
    },

    onNavItemSelect: function (oEvent) {
      var oItem = oEvent.getParameter("item");
      // Items carrying an href navigate natively via the rendered anchor; do
      // NOT also dispatch in JS or external target="_blank" links open twice.
      // (The search palette has no anchors, so it routes href items itself.)
      if (oItem.getHref()) return;
      this._navigateToNavItem({ key: oItem.getKey() });
    },

    // Shared navigation dispatch used by both the side navigation
    // (onNavItemSelect) and the page-search palette (onSearchResultSelect),
    // so external links, keyed routes, and the special deep-link hashes stay
    // in exactly one place. `oItem`: { key, href, target }.
    _navigateToNavItem: function (oItem) {
      if (!oItem) return;

      // External links (Analytics, Data Inspector, BAIP, Devtoberfest Planner)
      // carry an href but no route — navigate the browser directly. The side
      // nav renders these as native anchors; the palette has to do it by hand.
      if (oItem.href) {
        if (oItem.target === "_blank") {
          window.open(oItem.href, "_blank", "noopener");
        } else {
          window.location.assign(oItem.href);
        }
        return;
      }

      var sKey = oItem.key;
      if (!sKey) return;

      var sRoute = NAV_KEY_TO_ROUTE[sKey];
      if (!sRoute) return;

      this.getOwnerComponent().getRouter().navTo(sRoute);
      if (sKey === "pipelinelog") {
        HashChanger.getInstance().setHash("pipelinelog&/op/PipelineLog");
      }
      if (sKey === "joblog") {
        HashChanger.getInstance().setHash("joblog&/op/JobExecutionLog");
      }
      if (sKey === "homepageRedirects") {
        HashChanger.getInstance().setHash("homepageRedirects&/hp/Redirects");
      }
      if (sKey === "homepageConfig") {
        // Fixed singleton UUID; matches auto-init handler at
        // srv/admin-service.js:601 (HOMEPAGE_CONFIG_SINGLETON_ID).
        // HomepageConfig used to be @odata.singleton but that combo is
        // incompatible with @odata.draft.enabled (draftActivate requires
        // the ID key), so it was demoted to a keyed collection with a
        // single well-known row. See srv/admin-service.cds header comment.
        HashChanger.getInstance().setHash("homepageConfig&/hp/HomepageConfig(00000000-0000-0000-0000-00000000c8ae)");
      }
      if (sKey === "petoberfestContests") {
        // Deep-link into the petoberfest componentUsage's inner "Petoberfests"
        // List Report route (contest maintenance). The bare "petoberfest" route
        // lands on the PetSubmissions moderation queue; this second outer route
        // shares the same componentUsage target (prefix "pb") and drives the
        // inner hash to the contest LR — mirrors the pipelinelog/joblog pattern
        // above that reuses the operations target. (#1449)
        HashChanger.getInstance().setHash("petoberfestContests&/pb/Petoberfests");
      }
    },

    // ---- Page search palette (#2041) -------------------------------------
    // A command-palette style popover for jumping to any admin page. Flattens
    // the (already role-filtered) nav model into a searchable flat list, so an
    // author never sees admin-only pages in results.

    onOpenPageSearch: function (oEvent) {
      this._openPageSearch(oEvent.getSource());
    },

    _openPageSearch: function (oOpenerControl) {
      var oPopover = this.byId("pageSearchPopover");
      if (!oPopover) return;
      // Rebuild the flat catalog every open — role filtering may have applied
      // after the previous open, and it is cheap (~55 rows).
      var oSearchModel = this._getSearchModel();
      oSearchModel.setProperty("/all", this._flattenNav());
      oSearchModel.setProperty("/query", "");
      this._applySearchFilter("");
      if (oPopover.isOpen()) return;
      oPopover.openBy(oOpenerControl || this.byId("pageSearchBtn"));
    },

    onPageSearchAfterOpen: function () {
      var oField = this.byId("pageSearchField");
      if (oField) oField.focus();
    },

    onPageSearchLiveChange: function (oEvent) {
      this._applySearchFilter(oEvent.getParameter("newValue") || "");
    },

    // Enter in the SearchField activates the first (top) result.
    onPageSearchGo: function () {
      var aResults = this._getSearchModel().getProperty("/results") || [];
      if (aResults.length) {
        this._selectSearchResult(aResults[0]);
      }
    },

    onSearchResultSelect: function (oEvent) {
      var oCtx = oEvent.getSource().getBindingContext("search");
      if (!oCtx) return;
      this._selectSearchResult(oCtx.getObject());
    },

    _selectSearchResult: function (oResult) {
      var oPopover = this.byId("pageSearchPopover");
      if (oPopover && oPopover.isOpen()) oPopover.close();
      this._navigateToNavItem(oResult);
    },

    _getSearchModel: function () {
      var oModel = this.getView().getModel("search");
      if (!oModel) {
        oModel = new JSONModel({ query: "", all: [], results: [] });
        this.getView().setModel(oModel, "search");
      }
      return oModel;
    },

    // Flatten the role-filtered nav tree into { key, title, groupTitle, icon,
    // href, target }. Container groups contribute their leaves; a top-level
    // leaf (e.g. Dashboard) contributes itself.
    _flattenNav: function () {
      var oNavModel = this.getOwnerComponent().getModel("nav");
      var aGroups = (oNavModel && oNavModel.getData().groups) || [];
      var aFlat = [];
      aGroups.forEach(function (g) {
        if (g.items && g.items.length) {
          g.items.forEach(function (leaf) {
            aFlat.push({
              key: leaf.key,
              title: leaf.title,
              groupTitle: g.title,
              icon: g.icon,
              href: leaf.href,
              target: leaf.target
            });
          });
        } else {
          aFlat.push({
            key: g.key,
            title: g.title,
            groupTitle: g.title,
            icon: g.icon,
            href: g.href,
            target: g.target
          });
        }
      });
      return aFlat;
    },

    _applySearchFilter: function (sQuery) {
      var oModel = this._getSearchModel();
      var aAll = oModel.getProperty("/all") || [];
      var q = (sQuery || "").trim().toLowerCase();
      var aResults = !q ? aAll : aAll.filter(function (item) {
        return (item.title || "").toLowerCase().indexOf(q) !== -1
            || (item.groupTitle || "").toLowerCase().indexOf(q) !== -1;
      });
      oModel.setProperty("/query", sQuery);
      oModel.setProperty("/results", aResults);
    },

    _onGlobalKeydown: function (e) {
      // Ctrl+K / Cmd+K opens the page search from anywhere in the shell.
      if ((e.ctrlKey || e.metaKey) && !e.altKey && (e.key === "k" || e.key === "K")) {
        e.preventDefault();
        this._openPageSearch(this.byId("pageSearchBtn"));
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
        default:
          localStorage.removeItem("sap-tutorials-admin-theme");
          sTheme = window.matchMedia("(prefers-color-scheme: dark)").matches
            ? "sap_horizon_dark"
            : "sap_horizon";
          break;
      }

      Theming.setTheme(sTheme);
      this.getOwnerComponent().getModel("theme").setProperty("/themeMode", sKey);
    },

    onJoulePress: function () {
      if (window.joule && window.joule.open) window.joule.open();
    },

    onHelpPress: function () {
      window.open("https://community.sap.com", "_blank");
    },

    onNotificationsPress: function (oEvent) {
      var oButton = oEvent.getSource();
      var oPopover = this.byId("notificationsPopover");
      var oNotifModel = this.getView().getModel("notifications") ||
        new JSONModel({ items: [] });
      this.getView().setModel(oNotifModel, "notifications");

      fetch("/admin/secretWarnings()", {
        credentials: "include",
        headers: { "Accept": "application/json" }
      })
        .then(function (res) {
          if (!res.ok) { throw new Error("HTTP " + res.status); }
          return res.json();
        })
        .then(function (body) {
          var aWarnings = (body.value || []).map(function (w) {
            var sUiState = w.severity === "CRITICAL" ? "Error"
                         : w.severity === "WARNING"  ? "Warning"
                         : "Information";
            var sUiIcon = w.severity === "CRITICAL" ? "sap-icon://alert"
                         : w.severity === "WARNING"  ? "sap-icon://warning"
                         : "sap-icon://information";
            var sSummary = w.daysRemaining < 0
              ? "Expired " + Math.abs(w.daysRemaining) + " day(s) ago"
              : w.daysRemaining === 0
              ? "Expires today"
              : "Expires in " + w.daysRemaining + " day(s)";
            return {
              key: w.key,
              summary: sSummary,
              uiState: sUiState,
              uiIcon: sUiIcon,
              rotationOwner: w.rotationOwner,
              rotationDocsUrl: w.rotationDocsUrl,
            };
          });
          oNotifModel.setData({ items: aWarnings });
        })
        .catch(function () {
          oNotifModel.setData({ items: [] });
        });

      oPopover.openBy(oButton);
    },

    onAvatarPress: function (oEvent) {
      var oViewModel = this.getView().getModel("viewModel");
      if (!oViewModel.getProperty("/userName")) {
        window.location.href = "/login?returnTo=" + encodeURIComponent(window.location.pathname + window.location.hash);
        return;
      }
      this.byId("userPopover").openBy(oEvent.getSource());
    },

    onLogout: function () {
      window.location.href = "/logout";
    },

    _loadUserProfile: function () {
      var oViewModel = this.getView().getModel("viewModel");
      var that = this;
      fetch("/auth/user", { credentials: "include" })
        // #1268: the environment badge must render even for anonymous callers
        // (NoAccess page), so parse the JSON body on BOTH the 200 and 401
        // paths — /auth/user returns `environment` in either case.
        .then(function (res) { return res.json().catch(function () { return null; }); })
        .then(function (user) {
          that._applyEnvironment(user && user.environment);
          if (!user || !user.authenticated) {
            oViewModel.setProperty("/userRole", "anonymous");
            that._applyRole("anonymous");
            return;
          }
          var sName = ((user.givenName || "") + " " + (user.familyName || "")).trim() || user.id || "";
          var sInitials = ((user.givenName || "")[0] || "") + ((user.familyName || "")[0] || "");
          if (!sInitials && user.id) sInitials = user.id[0];
          oViewModel.setProperty("/userName", sName);
          oViewModel.setProperty("/userEmail", user.email || "");
          oViewModel.setProperty("/userInitials", sInitials.toUpperCase());
          // #617 — derive role from auth claims
          var role = user.isAdmin  ? "admin"
                   : user.isAuthor ? "author"
                   : "anonymous";
          oViewModel.setProperty("/userRole", role);
          that._applyRole(role);
        })
        .catch(function () { that._applyRole("anonymous"); });
    },

    // Surface the deployed MTA version next to the environment badge. The
    // unauthenticated GET /version endpoint (srv/lib/version-handler.js) returns
    // the `version` from srv/version.json, written per-deploy from the same
    // .deploy/mta.yaml version cf deploys (see scripts/deploy-mta.cjs Step 1.5 and
    // docs/superpowers/specs/2026-07-25-mta-versioning-design.md). Rendered as the
    // env-badge tooltip so the header stays uncluttered and DEV vs PROD versions
    // are comparable at a glance.
    //
    // Skip ONLY on true local `cds watch` — keyed off `environment`, not the
    // version string. `environment:"local"` means no CF binding (nothing is
    // deployed). Every deployed target (dev/qa/prod/other) always shows a tooltip,
    // even if version is somehow "dev" — a visibly wrong "Version dev" on a
    // deployed badge signals a broken deploy, which is more useful than a silently
    // hidden badge. (An empty version string returned "dev" here before, so
    // deployed-but-missing-version.json used to be indistinguishable from local.)
    _loadVersion: function () {
      var oViewModel = this.getView().getModel("viewModel");
      fetch("/version", { credentials: "include", headers: { "Accept": "application/json" } })
        .then(function (res) { return res.ok ? res.json() : null; })
        .then(function (info) {
          if (!info || info.environment === "local" || !info.version) { return; }
          var aParts = ["Version " + info.version];
          if (info.gitSha) { aParts.push("commit " + info.gitSha); }
          if (info.builtAt) { aParts.push("built " + info.builtAt); }
          oViewModel.setProperty("/versionTooltip", aParts.join(" · "));
        })
        .catch(function () { /* build metadata is best-effort; no tooltip on failure */ });
    },

    // #1268 — map the coarse deploy environment reported by /auth/user onto a
    // badge label + semantic ObjectStatus state. PROD is red (Error) so it is
    // impossible to mistake for DEV during a destructive admin action; DEV is
    // green (Success), QA/other amber (Warning), LOCAL neutral (Information).
    _applyEnvironment: function (env) {
      var oViewModel = this.getView().getModel("viewModel");
      // Feed the authoritative deploy environment (CF space_name, via
      // /auth/user) into the Component so env-specific external links
      // (hrefDev/hrefProd, e.g. the Devtoberfest Planner) resolve correctly
      // even on the vanity host developers.sap.com, where the hostname sniff
      // in Component._resolveEnvLinks carries no "-prod" and would otherwise
      // fall back to DEV. Only assert prod when the server says so; any other
      // label (dev/qa/local/other) resolves to the non-prod href.
      var oComponent = this.getOwnerComponent();
      if (oComponent && oComponent.setDeployEnvironment) {
        oComponent.setDeployEnvironment(env && env.id === "prod");
      }
      if (!env || !env.label) {
        oViewModel.setProperty("/envLabel", "");
        oViewModel.setProperty("/envState", "None");
        return;
      }
      var mState = {
        prod: "Error",
        dev: "Success",
        qa: "Warning",
        local: "Information"
      };
      oViewModel.setProperty("/envLabel", env.label);
      oViewModel.setProperty("/envState", mState[env.id] || "Warning");
    },

    _applyRole: function (role) {
      var oI18n = this.getView().getModel("i18n").getResourceBundle();
      var oViewModel = this.getView().getModel("viewModel");
      oViewModel.setProperty("/consoleTitle", oI18n.getText("consoleTitle." + role));
      document.title = oI18n.getText("documentTitle." + role);

      // #617 Task 14 — Publish role + per-tile service-path lookup so that tile
      // components (Fiori Elements V4 AppComponents created lazily by the UI5
      // router from declarative componentUsages) can rewrite their
      // `mainService.uri` from /admin/ to /author/ at init time. We can't pass
      // componentData through the router for declarative componentUsages, so
      // we expose a small global resolver instead.
      this._publishRoleGlobals(role);

      if (role === "anonymous") {
        // NoAccess route — added in Task 13. Until then, navigate may no-op silently.
        var oRouter = this.getOwnerComponent().getRouter();
        if (oRouter.getRoute("noAccess")) {
          oRouter.navTo("noAccess");
        }
        return;
      }
      this._filterNavigationByRole(role);
    },

    _publishRoleGlobals: function (role) {
      // Build a navKey -> servicePath map from navigation.json. For each entry
      // with adminPath/authorPath, role=author resolves to authorPath, anything
      // else resolves to adminPath. Entries without these fields are omitted
      // and the tile falls back to its manifest default.
      var oNavModel = this.getOwnerComponent().getModel("nav");
      var data = oNavModel ? oNavModel.getData() : { groups: [] };
      var oPathByNavKey = {};
      var walk = function (entry) {
        if (entry && entry.key && (entry.adminPath || entry.authorPath)) {
          var sPath = (role === "author" && entry.authorPath)
            ? entry.authorPath
            : (entry.adminPath || "/admin/");
          oPathByNavKey[entry.key] = sPath;
        }
        if (entry && entry.items) {
          entry.items.forEach(walk);
        }
      };
      (data.groups || []).forEach(walk);

      window.__tutorialPlatform = {
        userRole: role,
        servicePathByNavKey: oPathByNavKey,
        getServicePath: function (sNavKey) {
          return oPathByNavKey[sNavKey] || null;
        }
      };
    },

    _filterNavigationByRole: function (role) {
      var oNavModel = this.getOwnerComponent().getModel("nav");
      var data = oNavModel.getData();

      // Predicate for a leaf entry (or for testing a group's own scope).
      var keepLeaf = function (entry) {
        return !entry.requiredScope
            || role === "admin"
            || (role === "author" && entry.requiredScope === "Tutorial.Author");
      };

      // Walk groups: top-level leaves use keepLeaf; container groups are kept
      // if the group itself satisfies the role (children inherit) OR if at
      // least one child survives the leaf filter.
      var filtered = (data.groups || []).map(function (g) {
        if (!g.items) {
          // top-level leaf (e.g. dashboard) — apply keepLeaf
          return keepLeaf(g) ? g : null;
        }
        // If the group itself has requiredScope that satisfies the role, keep ALL children.
        if (keepLeaf(g) && g.requiredScope) {
          return g; // children inherit visibility from the matching group
        }
        // Otherwise, filter children; keep the group only if any child survives.
        var keptChildren = g.items.filter(keepLeaf);
        if (keptChildren.length === 0) return null;
        return Object.assign({}, g, { items: keptChildren });
      }).filter(function (g) { return g !== null; });

      oNavModel.setData({ selectedNavKey: data.selectedNavKey, groups: filtered });
    },

    _attachHashChangeDetection: function () {
      var oHashChanger = HashChanger.getInstance();
      oHashChanger.attachEvent("hashChanged", this._onHashChanged, this);
    },

    _parseODataKey: function (sHash) {
      const m = sHash && sHash.match(/([A-Za-z0-9]+)\(([^)]+)\)/);
      if (!m) return null;
      const props = {};
      const re = /([A-Za-z0-9_]+)\s*=\s*('([^']*)'|"([^"]*)"|([^,)]+))/g;
      let pair;
      while ((pair = re.exec(m[2])) !== null) {
        const key = pair[1];
        const val = pair[3] != null ? pair[3] : pair[4] != null ? pair[4] : pair[5];
        if (key) props[key] = (val == null ? '' : String(val).trim());
      }
      return { entity: m[1], props };
    },

    _wireAdminContextToHtml: function (sNavKey, sNavTitle) {
      const html = document.documentElement;
      html.dataset.adminTool = sNavKey || '';
      html.dataset.adminToolTitle = sNavTitle || '';
      const sHash = HashChanger.getInstance().getHash() || '';
      const parsed = this._parseODataKey(sHash);
      if (parsed?.props?.ID) {
        html.dataset.adminEntityId = parsed.props.ID;
        html.dataset.adminEntityType = parsed.entity;
      } else {
        delete html.dataset.adminEntityId;
        delete html.dataset.adminEntityType;
        delete html.dataset.adminEntityTitle;
        delete html.dataset.adminEntitySlug;
      }
    },

    _onHashChanged: function (oEvent) {
      var sNewHash = oEvent.getParameter("newHash") || "";
      var oViewModel = this.getView().getModel("viewModel");
      var bHasNestedRoute = sNewHash.indexOf("&/") !== -1;
      oViewModel.setProperty("/showBackButton", bHasNestedRoute);
      var oNavModel = this.getOwnerComponent().getModel("nav");
      var sNavKey = oNavModel ? oNavModel.getProperty("/selectedNavKey") : "";
      var sPageTitle = NAV_KEY_TO_TITLE[sNavKey] || "";
      this._wireAdminContextToHtml(sNavKey, sPageTitle);
    },

    _onRouteMatched: function (oEvent) {
      var sRouteName = oEvent.getParameter("name");
      var oNavModel = this.getOwnerComponent().getModel("nav");

      var sNavKey = sRouteName;
      if (sRouteName === "operations") {
        var sHash = HashChanger.getInstance().getHash();
        if (sHash.indexOf("PipelineLog") !== -1) {
          sNavKey = "pipelinelog";
        }
        if (sHash.indexOf("JobExecutionLog") !== -1) {
          sNavKey = "joblog";
        }
      }

      if (oNavModel) {
        oNavModel.setProperty("/selectedNavKey", sNavKey);
      }

      var oViewModel = this.getView().getModel("viewModel");
      var sPageTitle = NAV_KEY_TO_TITLE[sNavKey] || "";
      var sConsoleTitle = oViewModel.getProperty("/consoleTitle") || "Admin Console";
      var sHeader = sPageTitle ? sConsoleTitle + " — " + sPageTitle : sConsoleTitle;
      oViewModel.setProperty("/headerTitle", sHeader);
      this._wireAdminContextToHtml(sNavKey, sPageTitle);
    }
  });
});
