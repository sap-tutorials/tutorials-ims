sap.ui.define([], function () {
  "use strict";

  // FE V4 manifest-declared press handlers are invoked with
  // (oBindingContext, aSelectedContexts) — the binding context is the
  // first argument, NOT a UI event. The same shape resolver is used in
  // sap.tutorials.admin.groups.ext.MarkdownEditor; kept inline here to
  // avoid a cross-app dependency.
  function _resolveBindingContext(arg) {
    if (arg && typeof arg.getProperty === "function") {
      return arg;
    }
    var oControl = arg && typeof arg.getSource === "function" && arg.getSource();
    var oBC = oControl && oControl.getBindingContext && oControl.getBindingContext();
    while (!oBC && oControl) {
      oControl = oControl.getParent && oControl.getParent();
      oBC = oControl && oControl.getBindingContext && oControl.getBindingContext();
    }
    return oBC || null;
  }

  return {
    // Triggered by the "Ask Joule for tutorial improvement suggestions"
    // header action (manifest: header.actions.AskJouleAction). Opens the
    // host shell's Joule chat seeded with a tutorial-specific prompt.
    onAskJoule: function (arg) {
      var oBindingContext = _resolveBindingContext(arg);
      if (!oBindingContext) {
        // eslint-disable-next-line no-console
        console.warn("AskJoule: unable to resolve binding context from press argument");
        return;
      }
      var sTitle = oBindingContext.getProperty("title") || "";
      var sSlug  = oBindingContext.getProperty("slug")  || "";
      if (!sSlug) {
        // eslint-disable-next-line no-console
        console.warn("AskJoule: tutorial has no slug — cannot ask Joule for suggestions");
        return;
      }

      var sText = 'Please suggest improvements for the tutorial "' + sTitle +
                  '" (slug: ' + sSlug + '). Consider feedback comments, NPS score, ' +
                  'step structure, and clarity.';

      // Admin shell hosts the apps in iframes; the Joule API lives on the
      // outer window. Fall back to the current window when running standalone.
      var oWin = window.parent || window;
      if (oWin.joule && typeof oWin.joule.openWithMessage === "function") {
        oWin.joule.openWithMessage({ text: sText });
        return;
      }
      // eslint-disable-next-line no-console
      console.warn("AskJoule: window.joule.openWithMessage is unavailable — is the host shell loaded?");
    }
  };
});
