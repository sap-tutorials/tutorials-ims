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
    accounts: "accounts",
    changelog: "changelog",
    board: "board",
    statistics: "statistics",
    privacy: "privacy"
  };

  var NAV_KEY_TO_TITLE = {
    dashboard: "Dashboard",
    events: "Events",
    missions: "Missions",
    groups: "Groups",
    tutorials: "Tutorials",
    tags: "Tags",
    accomplishments: "Accomplishments",
    prizes: "Prizes",
    operations: "Operations",
    pipelinelog: "Pipeline Log",
    accounts: "Accounts",
    changelog: "Change Log",
    board: "Board",
    statistics: "Statistics",
    privacy: "Privacy"
  };

  return Controller.extend("sap.tutorials.admin.shell.controller.Shell", {
    onInit: function () {
      var oComponent = this.getOwnerComponent();
      var oViewModel = oComponent.getShellViewModel();
      var bExpanded = localStorage.getItem("sap-tutorials-admin-nav-expanded") !== "false";
      oViewModel.setProperty("/sideExpanded", bExpanded);
      this.getView().setModel(oViewModel, "viewModel");

      oComponent.getRouter().attachRouteMatched(this._onRouteMatched, this);
      this._attachHashChangeDetection();
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

    _attachHashChangeDetection: function () {
      var oHashChanger = HashChanger.getInstance();
      oHashChanger.attachEvent("hashChanged", this._onHashChanged, this);
    },

    _onHashChanged: function (oEvent) {
      var sNewHash = oEvent.getParameter("newHash") || "";
      var oViewModel = this.getView().getModel("viewModel");
      var bHasNestedRoute = sNewHash.indexOf("&/") !== -1;
      oViewModel.setProperty("/showBackButton", bHasNestedRoute);
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
      }

      if (oNavModel) {
        oNavModel.setProperty("/selectedNavKey", sNavKey);
      }

      var oViewModel = this.getView().getModel("viewModel");
      var sPageTitle = NAV_KEY_TO_TITLE[sNavKey] || "";
      var sHeader = sPageTitle ? "Admin Console — " + sPageTitle : "Admin Console";
      oViewModel.setProperty("/headerTitle", sHeader);
    }
  });
});
