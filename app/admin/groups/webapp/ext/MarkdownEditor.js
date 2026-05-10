sap.ui.define([
  "sap/ui/core/Fragment"
], function (Fragment) {
  "use strict";

  var FRAGMENT_ID = "mdEditorGroups";
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

  return {
    onEditMarkdown: function (oBindingContext) {
      if (!oBindingContext) return;
      _oCurrentContext = oBindingContext;

      if (!_pDialog) {
        _pDialog = Fragment.load({
          id: FRAGMENT_ID,
          name: "sap.tutorials.admin.groups.ext.MarkdownEditorDialog",
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
        });
      }

      _pDialog.then(function (oDialog) {
        var sDescription = _oCurrentContext.getProperty("description") || "";
        var oEditor = _byId("markdownCodeEditor");
        oEditor.setValue(sDescription);

        var vIsActive = _oCurrentContext.getProperty("IsActiveEntity");
        var bEditable = vIsActive === false || vIsActive === "false";
        oEditor.setEditable(bEditable);
        _byId("markdownSaveBtn").setVisible(bEditable);

        var oPreview = _byId("markdownPreview");
        oPreview.setHtmlText(convertMarkdown(sDescription));
        oDialog.open();
      });
    }
  };
});
