sap.ui.define([
  "sap/ui/core/Fragment"
], function (Fragment) {
  "use strict";

  var FRAGMENT_ID = "mdEditorMissions";
  var _pDialog = null;
  var _oCurrentContext = null;

  function _byId(sId) {
    return Fragment.byId(FRAGMENT_ID, sId);
  }

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

  // Populate editor + preview from the current binding context.
  // Run on dialog `afterOpen` so the underlying Ace editor has its DOM
  // before setValue — without this, the first open shows an empty editor
  // even though the value was set programmatically.
  function _applyContent() {
    if (!_oCurrentContext) return;
    var sDescription = _oCurrentContext.getProperty("description") || "";
    var oEditor = _byId("markdownCodeEditor");
    var oPreview = _byId("markdownPreview");
    oEditor.setValue(sDescription);
    var vIsActive = _oCurrentContext.getProperty("IsActiveEntity");
    var bEditable = vIsActive === false || vIsActive === "false";
    oEditor.setEditable(bEditable);
    _byId("markdownSaveBtn").setVisible(bEditable);
    oPreview.setHtmlText(convertMarkdown(sDescription));

    // Ace mounts into a Splitter pane that may resolve to 0px on the first
    // paint inside a stretched Dialog; without an explicit resize the gutter
    // and text layer never get drawn (the dialog appears blank on the left).
    // Defer to next frame so the Dialog's real size is in the DOM, then poke
    // the underlying Ace instance.
    setTimeout(function () {
      var oAce = oEditor._oEditor;
      if (oAce && typeof oAce.resize === "function") {
        oAce.resize(true);
        oAce.renderer.updateFull();
      }
    }, 0);
  }

  // FE V4 manifest-declared press handlers are invoked with
  // (oBindingContext, aSelectedContexts) — a binding context as the first
  // argument, NOT an event. (See sap.fe docs: "Adding Custom Actions Using
  // Extension Points", OData V4 section.) An earlier version of this file
  // assumed an event arg and called .getSource() on the binding context,
  // which silently no-op'd because BCs don't have that method. Detect the
  // shape of the argument and fall back to an event-style walk only if a
  // future framework path passes us an event.
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
    onEditMarkdown: function (arg) {
      var oBindingContext = _resolveBindingContext(arg);
      if (!oBindingContext) {
        // eslint-disable-next-line no-console
        console.warn("MarkdownEditor: unable to resolve binding context from press argument");
        return;
      }
      _oCurrentContext = oBindingContext;

      if (!_pDialog) {
        _pDialog = Fragment.load({
          id: FRAGMENT_ID,
          name: "sap.tutorials.admin.missions.ext.MarkdownEditorDialog",
          controller: {
            onEditorChange: function () {
              var oEditor = _byId("markdownCodeEditor");
              var oPreview = _byId("markdownPreview");
              oPreview.setHtmlText(convertMarkdown(oEditor.getValue()));
            },
            onSaveMarkdown: function () {
              var oEditor = _byId("markdownCodeEditor");
              _oCurrentContext.setProperty("description", oEditor.getValue());
              _byId("markdownEditorDialog").close();
            },
            onCancelMarkdown: function () {
              _byId("markdownEditorDialog").close();
            }
          }
        }).then(function (oDialog) {
          oDialog.attachAfterOpen(_applyContent);
          return oDialog;
        });
      }

      _pDialog.then(function (oDialog) {
        oDialog.open();
      });
    }
  };
});
