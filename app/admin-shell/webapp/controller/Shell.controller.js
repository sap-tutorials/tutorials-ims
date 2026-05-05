sap.ui.define([
  "sap/ui/core/mvc/Controller",
  "sap/ui/core/Theming",
  "sap/ui/model/json/JSONModel"
], function (Controller, Theming, JSONModel) {
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
    accounts: "Accounts",
    changelog: "Change Log",
    board: "Board",
    statistics: "Statistics",
    privacy: "Privacy"
  };

  return Controller.extend("sap.tutorials.admin.shell.controller.Shell", {
    onInit: function () {
      var bExpanded = localStorage.getItem("sap-tutorials-admin-nav-expanded") !== "false";
      this.setModel(new JSONModel({ sideExpanded: bExpanded, headerTitle: "Admin Console", showBackButton: false }), "viewModel");

      this.getOwnerComponent().getRouter().attachRouteMatched(this._onRouteMatched, this);
    },

    setModel: function (oModel, sName) {
      this.getView().setModel(oModel, sName);
    },

    onNavBack: function () {
      var oShellService = this.getOwnerComponent()._oShellUIService;
      if (oShellService) {
        var fnBack = oShellService.getBackNavigation();
        if (fnBack) {
          fnBack();
          return;
        }
      }
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

    _onRouteMatched: function (oEvent) {
      var sRouteName = oEvent.getParameter("name");
      var oNavModel = this.getOwnerComponent().getModel("nav");
      if (oNavModel) {
        oNavModel.setProperty("/selectedNavKey", sRouteName);
      }

      var sPageTitle = NAV_KEY_TO_TITLE[sRouteName] || "";
      var sHeader = sPageTitle ? "Admin Console — " + sPageTitle : "Admin Console";
      this.getView().getModel("viewModel").setProperty("/headerTitle", sHeader);
    }
  });
});
