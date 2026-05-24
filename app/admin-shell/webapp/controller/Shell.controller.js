sap.ui.define([
  "sap/ui/core/mvc/Controller",
  "sap/ui/core/Theming",
  "sap/ui/core/routing/HashChanger"
], function (Controller, Theming, HashChanger) {
  "use strict";

  var NAV_KEY_TO_ROUTE = {
    dashboard: "dashboard",
    events: "events",
    missions: "missions",
    groups: "groups",
    tutorials: "tutorials",
    tags: "tags",
    accomplishments: "accomplishments",
    prizes: "prizes",
    operations: "operations",
    pipelinelog: "pipelinelog",
    joblog: "joblog",
    accounts: "accounts",
    changelog: "changelog",
    board: "board",
    analytics: "analytics",
    statistics: "statistics",
    joule: "joule",
    privacy: "privacy",
    feedbackList: "feedbackList",
    feedbackDashboard: "feedbackDashboard",
    dataExport: "dataExport"
  };

  var NAV_KEY_TO_TITLE = {
    dashboard: "Tutorial Health",
    events: "Events",
    missions: "Missions",
    groups: "Groups",
    tutorials: "Tutorials",
    tags: "Tags",
    accomplishments: "Accomplishments",
    prizes: "Prizes",
    operations: "Operations",
    pipelinelog: "Pipeline Log",
    joblog: "Job Log",
    accounts: "Account Merges",
    changelog: "Change Log",
    board: "Board",
    analytics: "Analytics",
    statistics: "Statistics",
    joule: "Joule Settings",
    privacy: "Privacy",
    feedbackList: "Tutorial Feedback",
    feedbackDashboard: "Feedback Dashboard",
    dataExport: "Data Export"
  };

  var NAV_GROUPS_STORAGE_KEY = "sap-tutorials-admin-nav-groups";
  var NAV_GROUP_KEYS = ["content", "rewards", "feedback", "reporting", "system"];

  return Controller.extend("sap.tutorials.admin.shell.controller.Shell", {
    onInit: function () {
      var oComponent = this.getOwnerComponent();
      var oViewModel = oComponent.getShellViewModel();
      var bExpanded = localStorage.getItem("sap-tutorials-admin-nav-expanded") !== "false";
      oViewModel.setProperty("/sideExpanded", bExpanded);
      oViewModel.setProperty("/groupExpanded", this._loadGroupExpanded());
      oViewModel.setProperty("/userInitials", "");
      oViewModel.setProperty("/userName", "");
      oViewModel.setProperty("/userEmail", "");
      this.getView().setModel(oViewModel, "viewModel");

      oViewModel.attachPropertyChange(this._onViewModelPropertyChange, this);

      oComponent.getRouter().attachRouteMatched(this._onRouteMatched, this);
      this._attachHashChangeDetection();
      this._loadUserProfile();
    },

    _loadGroupExpanded: function () {
      var oDefault = {};
      NAV_GROUP_KEYS.forEach(function (sKey) { oDefault[sKey] = true; });
      try {
        var sRaw = localStorage.getItem(NAV_GROUPS_STORAGE_KEY);
        if (!sRaw) return oDefault;
        var oStored = JSON.parse(sRaw);
        NAV_GROUP_KEYS.forEach(function (sKey) {
          if (typeof oStored[sKey] === "boolean") oDefault[sKey] = oStored[sKey];
        });
      } catch (e) { /* fall through to defaults */ }
      return oDefault;
    },

    _onViewModelPropertyChange: function (oEvent) {
      var sPath = oEvent.getParameter("path");
      var sContextPath = oEvent.getParameter("context") ? oEvent.getParameter("context").getPath() : "";
      var sFullPath = (sContextPath || "") + (sPath || "");
      if (sFullPath.indexOf("/groupExpanded/") !== 0) return;
      var oModel = this.getView().getModel("viewModel");
      var oGroups = oModel.getProperty("/groupExpanded") || {};
      try {
        localStorage.setItem(NAV_GROUPS_STORAGE_KEY, JSON.stringify(oGroups));
      } catch (e) { /* ignore quota errors */ }
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
      this.byId("notificationsPopover").openBy(oEvent.getSource());
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
      fetch("/auth/user", { credentials: "include" })
        .then(function (res) {
          if (!res.ok) return null;
          return res.json();
        })
        .then(function (user) {
          if (!user || !user.authenticated) return;
          var sName = ((user.givenName || "") + " " + (user.familyName || "")).trim() || user.id || "";
          var sInitials = ((user.givenName || "")[0] || "") + ((user.familyName || "")[0] || "");
          if (!sInitials && user.id) sInitials = user.id[0];
          oViewModel.setProperty("/userName", sName);
          oViewModel.setProperty("/userEmail", user.email || "");
          oViewModel.setProperty("/userInitials", sInitials.toUpperCase());
        })
        .catch(function () {});
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
      var sHeader = sPageTitle ? "Admin Console — " + sPageTitle : "Admin Console";
      oViewModel.setProperty("/headerTitle", sHeader);
      this._wireAdminContextToHtml(sNavKey, sPageTitle);
    }
  });
});
