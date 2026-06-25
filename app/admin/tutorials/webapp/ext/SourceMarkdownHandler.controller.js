sap.ui.define([
  "sap/ui/core/mvc/ControllerExtension",
  "sap/ui/model/json/JSONModel",
  "sap/m/MessageBox",
  "sap/m/MessageToast"
], function (ControllerExtension, JSONModel, MessageBox, MessageToast) {
  "use strict";

  // Hand-rolled markdown → HTML converter for the rendered preview tab.
  // Copied from app/admin/groups/webapp/ext/MarkdownEditor.js convertMarkdown()
  // to avoid an npm dep and to keep the existing precedent intact.
  //
  // Why not factor into a shared util: today only Groups + Tutorials use it,
  // and Groups' version is tightly coupled to the in-place editor dialog.
  // Factor when a third caller appears. For now copy is the pragmatic path.
  function convertMarkdown(src) {
    if (!src) return "";
    var html = src;

    html = html.replace(/```[\s\S]*?```/g, function (block) {
      var content = block.replace(/^```\w*\n?/, "").replace(/\n?```$/, "");
      return "<pre><code>" + content.replace(/</g, "&lt;").replace(/>/g, "&gt;") + "</code></pre>";
    });

    var lines = html.split("\n");
    var result = [];
    var inList = false;

    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];

      if (/^### (.+)/.test(line)) {
        if (inList) { result.push("</ul>"); inList = false; }
        result.push("<h3>" + RegExp.$1 + "</h3>");
      } else if (/^## (.+)/.test(line)) {
        if (inList) { result.push("</ul>"); inList = false; }
        result.push("<h2>" + RegExp.$1 + "</h2>");
      } else if (/^# (.+)/.test(line)) {
        if (inList) { result.push("</ul>"); inList = false; }
        result.push("<h1>" + RegExp.$1 + "</h1>");
      } else if (/^[\-\*] (.+)/.test(line)) {
        if (!inList) { result.push("<ul>"); inList = true; }
        result.push("<li>" + RegExp.$1 + "</li>");
      } else if (line.indexOf("<pre>") === 0 || line.indexOf("</pre>") === 0) {
        if (inList) { result.push("</ul>"); inList = false; }
        result.push(line);
      } else if (line.trim() === "") {
        if (inList) { result.push("</ul>"); inList = false; }
        result.push("<br/>");
      } else {
        if (inList) { result.push("</ul>"); inList = false; }
        result.push("<p>" + line + "</p>");
      }
    }
    if (inList) { result.push("</ul>"); }

    html = result.join("\n");
    html = html.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
    html = html.replace(/\*(.+?)\*/g, "<em>$1</em>");
    html = html.replace(/`([^`]+)`/g, "<code>$1</code>");
    html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');

    return html;
  }

  return ControllerExtension.extend("sap.tutorials.admin.tutorials.ext.SourceMarkdownHandler", {
    override: {
      onInit: function () {
        // Empty model up front so the visibility bindings don't crash on
        // first paint before the action call resolves. `loading` starts
        // FALSE — we only flip it true while a fetch is actually in
        // flight (see _loadSource). The fragment's "Republish to
        // populate" empty-state is gated on `!loading && !sourceHash`
        // so that nothing prematurely flashes before onAfterBinding
        // fires the first fetch.
        this.base.getView().setModel(new JSONModel({
          markdown: null,
          renderedHtml: "",
          sourceHash: null,
          contentHash: null,
          loading: false
        }), "sourceMd");
      },
      routing: {
        // Fiori Elements V4 canonical lifecycle hook — fires every time the
        // OP rebinds to a new context (initial nav, cross-tutorial nav,
        // refresh). Same pattern as BranchAnalyticsHandler in missions/.
        onAfterBinding: function (oContext) {
          if (!oContext) return;
          var that = this;
          oContext.requestObject("slug").then(function (sSlug) {
            if (!sSlug) return;
            that._loadSource(sSlug);
          });
        }
      }
    },

    _loadSource: function (sSlug) {
      var oModel = this.base.getView().getModel("sourceMd");
      // Reset to loading state — clears any stale data from the previous
      // tutorial before the new request resolves. `loading: true`
      // suppresses the "Republish to populate" empty-state during the
      // round-trip; the fragment's badge swaps to a small "Loading
      // source…" hint instead.
      oModel.setData({
        markdown: null,
        renderedHtml: "",
        sourceHash: null,
        contentHash: null,
        loading: true
      });

      // Call the unbound AdminService action. POST body per OData V4 spec.
      fetch("/admin/getTutorialSource", {
        method: "POST",
        credentials: "include",
        headers: {
          "Content-Type": "application/json",
          "Accept": "application/json"
        },
        body: JSON.stringify({ slug: sSlug })
      }).then(function (res) {
        if (!res.ok) throw new Error("HTTP " + res.status);
        return res.json();
      }).then(function (data) {
        // OData V4 actions return the function-call shape (varies between
        // CAP versions); strip the outer wrapper if present.
        var result = data && data.value !== undefined ? data.value : data;
        if (!result) {
          oModel.setProperty("/loading", false);
          return;
        }
        oModel.setData({
          markdown:    result.markdown    || null,
          renderedHtml: convertMarkdown(result.markdown),
          sourceHash:  result.sourceHash  || null,
          contentHash: result.contentHash || null,
          loading: false
        });
      }).catch(function (err) {
        // Failure path: clear `loading` so the "Republish to populate"
        // empty-state can surface — sourceHash will stay null and the
        // user gets a truthful "no source visible" UI rather than a
        // hung spinner. Log so operators can investigate from devtools.
        oModel.setProperty("/loading", false);
        // eslint-disable-next-line no-console
        console.warn("SourceMarkdownHandler: failed to load source for", sSlug, err);
      });
    },

    /**
     * Press handler for the "Rebuild this tutorial" header action (issue:
     * rebuild-button, spec: 2026-06-24-admin-tutorial-rebuild-button-design).
     *
     * Wired via the action's DataFieldForAction → AdminService.rebuildContent
     * binding in the CDS annotations. Fiori Elements invokes this method
     * (named after the action) on the controller extension when the user
     * clicks the button.
     *
     * Flow:
     *  1. Resolve the bound Tutorial row from the host view's binding context.
     *  2. Confirm via MessageBox with the tutorial title interpolated.
     *  3. On confirm, execute the bound action.
     *  4. Show a toast on success / message-box on error.
     *
     * Co-located with _loadSource on this ControllerExtension because Fiori
     * Elements V4 allows only one controller extension per parent
     * ObjectPageController; consolidating both handlers here avoids the
     * duplicate-extends-key trap in manifest.json.
     */
    onRebuildTutorial: function () {
      var oView = this.base.getView();
      var oContext = oView.getBindingContext();
      if (!oContext) {
        MessageBox.error("No tutorial bound to this view.");
        return;
      }
      var oData = oContext.getObject() || {};
      var sTitle = oData.title || oData.slug || "(this tutorial)";

      var oResourceBundle = oView.getModel("i18n").getResourceBundle();
      var sDialogTitle   = oResourceBundle.getText("RebuildTutorialDialogTitle");
      var sDialogMessage = oResourceBundle.getText("RebuildTutorialDialogMessage", [sTitle]);
      var sToastSuccess  = oResourceBundle.getText("RebuildTutorialToastSuccess",  [sTitle]);
      var sToastError    = oResourceBundle.getText("RebuildTutorialToastError", [""]);

      MessageBox.confirm(sDialogMessage, {
        title: sDialogTitle,
        actions: [MessageBox.Action.OK, MessageBox.Action.CANCEL],
        emphasizedAction: MessageBox.Action.OK,
        onClose: function (sResult) {
          if (sResult !== MessageBox.Action.OK) return;

          var oModel = oView.getModel();
          var oAction = oModel.bindContext(
            "AdminService.rebuildContent(...)",
            oContext,
            { $$inheritExpandSelect: true }
          );

          oAction.execute().then(function () {
            MessageToast.show(sToastSuccess, { duration: 5000 });
          }).catch(function (err) {
            var msg = (err && err.message) ? err.message : String(err);
            MessageBox.error(sToastError + msg);
          });
        }
      });
    }
  });
});
