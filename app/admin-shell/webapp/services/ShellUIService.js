sap.ui.define([
  "sap/ui/core/service/ServiceFactory",
  "sap/ui/core/service/Service"
], function (ServiceFactory, Service) {
  "use strict";

  var oShellUIService = Service.extend("sap.tutorials.admin.shell.services.ShellUIService", {
    init: function () {
      Service.prototype.init.apply(this, arguments);
      this._fnBackNavigation = null;
      this._aHierarchy = [];
      this._sTitle = "";

      var oComponent = this.getContext().scopeObject;
      if (oComponent && oComponent.getShellViewModel) {
        this._oShellViewModel = oComponent.getShellViewModel();
        oComponent._oFormalShellUIService = this;
      }
    },

    getInterface: function () {
      return this;
    },

    setBackNavigation: function (fnCallback) {
      this._fnBackNavigation = fnCallback || null;
      if (this._oShellViewModel) {
        this._oShellViewModel.setProperty("/showBackButton", !!fnCallback);
      }
      this.fireEvent("backNavigationChange", { callback: this._fnBackNavigation });
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
  });

  return ServiceFactory.extend("sap.tutorials.admin.shell.services.ShellUIServiceFactory", {
    createInstance: function (oServiceContext) {
      return Promise.resolve(new oShellUIService(oServiceContext));
    }
  });
});
