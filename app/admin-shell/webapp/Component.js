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
      // When the XSUAA session expires, backend calls fail in two distinct ways:
      //   1. The request returns 401/403 directly (approuter detected the AJAX call).
      //   2. The approuter sends a 302 to the IDP login page; the browser silently
      //      follows the redirect chain and the eventual response is 200 OK with an
      //      HTML login document. The OData parser then fails silently and the
      //      Fiori app just shows empty data — exactly what users perceive as
      //      "missing data".
      // Detect both cases and force a page reload so the approuter restarts the
      // OAuth flow and the user lands back on the same admin-shell route.
      var BACKEND_PREFIXES = ["/admin/", "/admin-ui/", "/api/", "/scanner/", "/display/", "/build/", "/content/"];
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

      function looksLikeLoginHtml(sContentType, sFinalUrl, bRedirected) {
        // 200 + text/html on a backend URL means the approuter swapped the JSON
        // payload for the IDP login page. response.redirected is true when fetch
        // followed the 302 chain. Either is a reliable session-expiry signal.
        if (sContentType && sContentType.toLowerCase().indexOf("text/html") === 0) return true;
        if (bRedirected) return true;
        if (sFinalUrl && /\/(saml2|oauth2|login)\b/i.test(sFinalUrl)) return true;
        return false;
      }

      function handleUnauthorized() {
        if (bRedirecting) return;
        bRedirecting = true;
        // Reloading the current URL (incl. hash) makes the approuter restart the OAuth flow
        // and return the user to the same admin-shell route after re-authentication.
        try { window.location.reload(); } catch (e) { window.location.href = window.location.href; }
      }

      function isCsrfRejection(oHeaders, sUrl) {
        // Recognize an AppRouter CSRF 403 so the interceptor does NOT reload
        // (the OData v4 client re-fetches the token on its own; reload strips
        // the fresh token from memory and reproduces the failure — #895).
        //
        // Two signals, either sufficient:
        //   1. Response carries `x-csrf-token: required` (AppRouter's native
        //      contract when errorPage[403] is not rewriting the response).
        //   2. The URL is an OData batch/action endpoint — those are the ONLY
        //      places UI5 OData v4 sends POST/PUT/DELETE, so a 403 there is
        //      overwhelmingly CSRF, not permissions. Belt-and-suspenders in
        //      case a future errorPage[403] rewrite masks the header.
        if (oHeaders && oHeaders.get) {
          var sHdr = "";
          try { sHdr = oHeaders.get("x-csrf-token") || ""; } catch (e) { /* swallow */ }
          if (sHdr.toLowerCase() === "required") return true;
        }
        if (sUrl && /\/\$batch(\?|$)/.test(sUrl)) return true;
        return false;
      }

      var fnOriginalFetch = window.fetch;
      window.fetch = function (input, init) {
        var sUrl = (typeof input === "string") ? input : (input && input.url);
        var sMethod = ((init && init.method) || (input && input.method) || "GET").toUpperCase();
        return fnOriginalFetch.apply(this, arguments).then(function (response) {
          if (!isBackendUrl(sUrl)) return response;
          var bMutating = sMethod !== "GET" && sMethod !== "HEAD" && sMethod !== "OPTIONS";
          if (response.status === 401 || (response.status === 403 && !(bMutating && isCsrfRejection(response.headers, sUrl)))) {
            handleUnauthorized();
          } else if (response.status === 200 && looksLikeLoginHtml(
            response.headers && response.headers.get && response.headers.get("content-type"),
            response.url,
            response.redirected
          )) {
            handleUnauthorized();
          }
          return response;
        });
      };

      var fnOriginalOpen = XMLHttpRequest.prototype.open;
      var fnOriginalSend = XMLHttpRequest.prototype.send;
      XMLHttpRequest.prototype.open = function (method, url) {
        this.__authUrl = url;
        this.__authMethod = (method || "GET").toUpperCase();
        return fnOriginalOpen.apply(this, arguments);
      };
      XMLHttpRequest.prototype.send = function () {
        var that = this;
        this.addEventListener("load", function () {
          if (!isBackendUrl(that.__authUrl)) return;
          if (that.status === 401 || that.status === 403) {
            // XHR: emulate the fetch-side headers.get() so isCsrfRejection() works.
            var oHdrs = { get: function (n) {
              try { return that.getResponseHeader(n); } catch (e) { return null; }
            }};
            var bMutating = that.__authMethod !== "GET" && that.__authMethod !== "HEAD" && that.__authMethod !== "OPTIONS";
            if (that.status === 403 && bMutating && isCsrfRejection(oHdrs, that.__authUrl)) return;
            handleUnauthorized();
            return;
          }
          if (that.status === 200) {
            var sContentType = "";
            try { sContentType = that.getResponseHeader("content-type") || ""; } catch (e) { /* swallow */ }
            // responseURL reflects the final URL after any redirects the browser followed.
            var sFinalUrl = that.responseURL || "";
            var bRedirected = !!sFinalUrl && sFinalUrl !== new URL(that.__authUrl, window.location.origin).href;
            if (looksLikeLoginHtml(sContentType, sFinalUrl, bRedirected)) {
              handleUnauthorized();
            }
          }
        });
        return fnOriginalSend.apply(this, arguments);
      };

      // UI5's async loader fetches lazy components (e.g. components/groups/Component.js)
      // via injected <script> tags, which bypass both the fetch and XHR hooks above.
      // When the XSUAA session expires mid-session, AppRouter kicks the OAuth flow on
      // those script requests and the browser surfaces only a generic resource-load
      // error event with no auth context — UI5 then logs "ModuleError: ... script
      // load error" and the UI silently breaks. Catch that error here, then probe
      // /auth/user with redirect:'manual' to distinguish a session-expiry redirect
      // (response.type === 'opaqueredirect') from a genuine 404 / syntax error.
      window.addEventListener("error", function (oEvt) {
        var el = oEvt && oEvt.target;
        if (!el || el.tagName !== "SCRIPT" || !el.src) return;
        if (el.src.indexOf("/admin-ui/") === -1) return;
        if (bRedirecting) return;
        fnOriginalFetch("/auth/user", { credentials: "include", redirect: "manual" })
          .then(function (r) {
            if (r.type === "opaqueredirect") return handleUnauthorized();
            if (r.status === 401 || r.status === 403) return handleUnauthorized();
            var sContentType = "";
            try { sContentType = (r.headers && r.headers.get && r.headers.get("content-type")) || ""; } catch (e) { /* swallow */ }
            if (sContentType.toLowerCase().indexOf("text/html") === 0) handleUnauthorized();
          })
          .catch(function () { /* network glitch — don't reload */ });
      }, true);
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
      // #829 — restore each group's expanded state from localStorage as soon as
      // the JSON is in. Groups without an items[] (top-level leaves like
      // dashboard) keep the property undefined; UI5 NavigationListItem treats
      // missing `expanded` as the default (open), which is the right behavior
      // for leaf items that have no expand chevron.
      oNavModel.attachRequestCompleted(function () {
        var groups = oNavModel.getProperty("/groups") || [];
        groups.forEach(function (g) {
          if (!g.items || !g.items.length) return;
          var sStored = localStorage.getItem("sap-tutorials-admin-nav-group-" + g.key);
          // Default to open (true) when no preference is stored; only set to
          // false when explicitly remembered as collapsed.
          g.expanded = (sStored === null) ? true : (sStored !== "false");
        });
        oNavModel.setProperty("/groups", groups);
      });
      // Persist any user-driven change to `expanded` via two-way binding.
      // The NavigationListItem writes through `nav>expanded` on chevron
      // click; the resulting propertyChange fires here. Restoring the same
      // value from localStorage on init also produces a propertyChange, but
      // writing the same value back is a no-op so the loop is self-stable.
      //
      // UI5 fires propertyChange with the RELATIVE binding path (`expanded`)
      // plus a `context` parameter for the row (`/groups/N`) — NOT a
      // pre-resolved absolute path. The original #832 fix assumed absolute
      // paths, so its regex never matched and localStorage was never
      // written. Match on the relative path + a `/groups/\d+` context
      // instead. (#829 regression, spotted post-#832 in DEV.)
      oNavModel.attachPropertyChange(function (oEvent) {
        var sPath = oEvent.getParameter("path");
        var oContext = oEvent.getParameter("context");
        if (sPath !== "expanded" || !oContext) return;
        var sCtxPath = oContext.getPath();
        if (!/^\/groups\/\d+$/.test(sCtxPath)) return;
        var oGroup = oNavModel.getProperty(sCtxPath);
        if (!oGroup || !oGroup.key) return;
        var bValue = oEvent.getParameter("value");
        localStorage.setItem("sap-tutorials-admin-nav-group-" + oGroup.key, String(!!bValue));
      });
      this.setModel(oNavModel, "nav");
    }
  });
});
