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
      this._initMockShellContainer();

      UIComponent.prototype.init.apply(this, arguments);

      this._initTheme();
      this._initNavModel();
      this.getRouter().initialize();
    },

    _initMockShellContainer: function () {
      if (sap.ushell && sap.ushell.Container) {
        return;
      }

      var that = this;
      sap.ushell = sap.ushell || {};
      sap.ushell.Container = {
        getServiceAsync: function (sServiceName) {
          if (sServiceName === "ShellUIService") {
            return Promise.resolve(that._getShellUIServiceInstance());
          }
          if (sServiceName === "Navigation" || sServiceName === "CrossApplicationNavigation") {
            return Promise.resolve({
              toExternal: function () {},
              backToPreviousApp: function () { window.history.back(); },
              hrefForExternal: function () { return "#"; },
              getDistinctSemanticObjects: function () { return Promise.resolve([]); },
              getLinks: function () { return Promise.resolve([]); },
              isNavigationSupported: function () { return Promise.resolve([{ supported: false }]); },
              isInitialNavigation: function () { return false; },
              expandCompactHash: function (sHash) { return Promise.resolve(sHash); }
            });
          }
          if (sServiceName === "URLParsing") {
            return Promise.resolve({
              parseShellHash: function () { return {}; },
              splitHash: function () { return {}; },
              constructShellHash: function () { return ""; }
            });
          }
          return Promise.resolve({});
        },
        getService: function (sServiceName) {
          return sap.ushell.Container.getServiceAsync(sServiceName);
        },
        getDirtyFlag: function () { return false; },
        setDirtyFlag: function () {},
        registerDirtyStateProvider: function () {},
        deregisterDirtyStateProvider: function () {},
        getLogonSystem: function () { return { getName: function () { return ""; } }; },
        getFLPUrl: function () { return ""; },
        getRenderer: function () {
          return Promise.resolve({
            getShellConfig: function () { return {}; }
          });
        }
      };
    },

    _getShellUIServiceInstance: function () {
      if (!this._oShellUIService) {
        this._oShellUIService = {
          _fnBackNavigation: null,
          _aHierarchy: [],
          _sTitle: "",
          _oComponent: this,
          setBackNavigation: function (fnCallback) {
            this._fnBackNavigation = fnCallback || null;
            var oShell = this._oComponent.getRootControl();
            if (oShell) {
              var oController = oShell.getController();
              if (oController) {
                oController.getView().getModel("viewModel").setProperty("/showBackButton", !!fnCallback);
              }
            }
          },
          getBackNavigation: function () {
            return this._fnBackNavigation;
          },
          setHierarchy: function (aHierarchy) {
            this._aHierarchy = aHierarchy || [];
          },
          setTitle: function (sTitle) {
            this._sTitle = sTitle || "";
          },
          getTitle: function () {
            return this._sTitle;
          },
          getContentDensity: function () {
            return "compact";
          }
        };
      }
      return this._oShellUIService;
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
