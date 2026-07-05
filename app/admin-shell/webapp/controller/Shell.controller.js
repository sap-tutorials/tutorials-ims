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
    board: "board",
    analytics: "analytics",
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
    verbDefinitions: "verbDefinitions",
    shelfDefinitions: "shelfDefinitions"
  };

  var NAV_KEY_TO_TITLE = {
    dashboard: "Tutorial Health",
    events: "Events",
    missions: "Missions",
    groups: "Groups",
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
    board: "Board",
    analytics: "Completion analytics",
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
    verbDefinitions: "Verb definitions",
    shelfDefinitions: "Shelf definitions"
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
      var sKey = oEvent.getParameter("item").getKey();
      if (!sKey) return;

      var sRoute = NAV_KEY_TO_ROUTE[sKey];
      if (sRoute) {
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
          HashChanger.getInstance().setHash("homepageConfig&/hp/Config");
        }
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
        .then(function (res) { return res.ok ? res.json() : null; })
        .then(function (user) {
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
