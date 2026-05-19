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
      this._oShellViewModel = new JSONModel({ sideExpanded: true, headerTitle: "Admin Console", showBackButton: false });
      this._initMockShellContainer();
      this._installAuthInterceptor();

      UIComponent.prototype.init.apply(this, arguments);

      this._initTheme();
      this._initNavModel();
      this.getRouter().initialize();
    },

    _installAuthInterceptor: function () {
      // When the XSUAA session expires, backend OData calls return 401 and the UI silently breaks.
      // Detect that and force a page reload so the approuter triggers the OAuth flow.
      var BACKEND_PREFIXES = ["/admin/", "/api/", "/scanner/", "/display/", "/build/", "/content/"];
      var bRedirecting = false;

      function isBackendUrl(sUrl) {
        if (!sUrl) return false;
        try {
          var oUrl = new URL(sUrl, window.location.origin);
          if (oUrl.origin !== window.location.origin) return false;
          return BACKEND_PREFIXES.some(function (p) { return oUrl.pathname.indexOf(p) === 0; });
        } catch (e) {
          return false;
        }
      }

      function handleUnauthorized() {
        if (bRedirecting) return;
        bRedirecting = true;
        // Reloading the current URL (incl. hash) makes the approuter restart the OAuth flow
        // and return the user to the same admin-shell route after re-authentication.
        try { window.location.reload(); } catch (e) { window.location.href = window.location.href; }
      }

      var fnOriginalFetch = window.fetch;
      window.fetch = function (input, init) {
        var sUrl = (typeof input === "string") ? input : (input && input.url);
        return fnOriginalFetch.apply(this, arguments).then(function (response) {
          if ((response.status === 401 || response.status === 403) && isBackendUrl(sUrl)) {
            handleUnauthorized();
          }
          return response;
        });
      };

      var fnOriginalOpen = XMLHttpRequest.prototype.open;
      var fnOriginalSend = XMLHttpRequest.prototype.send;
      XMLHttpRequest.prototype.open = function (method, url) {
        this.__authUrl = url;
        return fnOriginalOpen.apply(this, arguments);
      };
      XMLHttpRequest.prototype.send = function () {
        var that = this;
        this.addEventListener("load", function () {
          if ((that.status === 401 || that.status === 403) && isBackendUrl(that.__authUrl)) {
            handleUnauthorized();
          }
        });
        return fnOriginalSend.apply(this, arguments);
      };
    },

    getShellViewModel: function () {
      return this._oShellViewModel;
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
              backToPreviousApp: function () {
                that._navigateBackToList();
              },
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

    _navigateBackToList: function () {
      var oRouter = this.getRouter();
      var oHashChanger = oRouter.getHashChanger();
      var sCurrentHash = oHashChanger.getHash();
      var sShellRoute = sCurrentHash.split("&")[0];
      oHashChanger.setHash(sShellRoute);
    },

    _getShellUIServiceInstance: function () {
      if (!this._oShellUIService) {
        var oViewModel = this._oShellViewModel;
        this._oShellUIService = {
          _fnBackNavigation: null,
          _aHierarchy: [],
          _sTitle: "",
          setBackNavigation: function (fnCallback) {
            this._fnBackNavigation = fnCallback || null;
            oViewModel.setProperty("/showBackButton", !!fnCallback);
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
