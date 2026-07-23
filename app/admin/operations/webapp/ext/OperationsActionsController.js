// app/admin/operations/webapp/ext/OperationsActionsController.js
//
// Plain UI5 module for the Featured Tasks (Operations) List Report toolbar
// action `onTestNotificationEmail`.
//
// Why NOT a ControllerExtension: Fiori Elements v4 resolves `press`
// references in manifest action config as PLAIN modules (loader path
// `<dotted-name>.js`), NOT as controller extensions (loader path
// `<dotted-name>.controller.js`). The `.controller.js` sibling stays
// registered via controllerExtensions[ListReportController].controllerName
// so its no-op onInit runs at view bootstrap (UI5 requires the registered
// file to exist), but ALL dialog logic lives here. Same bug class + fix as
// PatActionsController (#1132) and ConceptActionsController (#537). Guarded
// by scripts/check-ui5-controller-extensions.ts.
//
// === Flow ===
//   "Send test notification email" toolbar button → onTestNotificationEmail
//   → programmatic Dialog (recipient + level 0-3) → POST /admin/
//   testNotificationEmail (manual x-csrf-token: fetch two-step; the operations
//   app has no OData draft context to piggyback a bound-operation on, and the
//   action is UNBOUND with params). The action renders the real cron template
//   (0=first, 1=second, 2=third, 3=final) with placeholder data and sends via
//   the credstore-fronted SMTP transport. See srv/admin-service.js
//   (testNotificationEmail handler) + docs/developers/operations/
//   smtp-credentials-rotation.md.
//
// The dialog is built programmatically (no fragment) so it needs no view
// resolution — a global toolbar action on a frequently-empty table has no
// stable row/view anchor to lean on, and the pats-style ElementRegistry walk
// is overkill for a self-contained prompt.
sap.ui.define([
  "sap/m/Dialog",
  "sap/m/Button",
  "sap/m/Label",
  "sap/m/Input",
  "sap/m/Select",
  "sap/ui/core/Item",
  "sap/m/VBox",
  "sap/m/MessageBox",
  "sap/m/MessageToast",
  "sap/m/BusyDialog"
], function (Dialog, Button, Label, Input, Select, Item, VBox, MessageBox, MessageToast, BusyDialog) {
  "use strict";

  // Level → template label, mirrored from srv/lib/mail-client.js TEMPLATE_NAMES.
  const LEVELS = [
    { key: "0", text: "Level 0 — first reminder (first.html)" },
    { key: "1", text: "Level 1 — second reminder (second.html)" },
    { key: "2", text: "Level 2 — third reminder (third.html)" },
    { key: "3", text: "Level 3 — final notice (final.html)" }
  ];

  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  let _dialog = null;
  let _recipientInput = null;
  let _levelSelect = null;

  async function _postTestEmail(to, level) {
    const csrfResp = await fetch("/admin/", { headers: { "x-csrf-token": "fetch" } });
    const csrf = csrfResp.headers.get("x-csrf-token");
    const res = await fetch("/admin/testNotificationEmail", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-csrf-token": csrf || "fetch"
      },
      body: JSON.stringify({ to: to, level: level })
    });
    if (!res.ok) {
      const txt = await res.text();
      throw new Error(res.status + " " + txt);
    }
    return res.json();
  }

  function _reportResult(to, body) {
    // The action returns { success: Boolean, error: String }. OData wraps
    // primitive-returning unbound actions under `value` in some stacks; tolerate
    // both shapes.
    const r = (body && body.value) || body || {};
    if (r.success) {
      MessageToast.show("Test email sent to " + to + ". Check the inbox.");
    } else {
      MessageBox.warning(
        "The server did not send the email:\n\n" + (r.error || "unknown error") +
        "\n\nIf this says \"No mail transport configured\", the SMTP_* secrets are " +
        "not set for this environment. The message was queued to FailedEmails."
      );
    }
  }

  const handlers = {

    // Toolbar button press. FE V4 calls a plain-module toolbar handler with a
    // context array (not a UI5 Event), but this handler needs neither — the
    // dialog is fully self-contained.
    onTestNotificationEmail: function () {
      if (_dialog) {
        _dialog.open();
        return;
      }

      _recipientInput = new Input({
        value: "",
        type: "Email",
        placeholder: "name@sap.com"
      });

      _levelSelect = new Select({
        items: LEVELS.map(function (l) {
          return new Item({ key: l.key, text: l.text });
        }),
        selectedKey: "0"
      });
      _levelSelect.setWidth("100%");

      _dialog = new Dialog({
        title: "Send test notification email",
        contentWidth: "480px",
        content: [
          new VBox({
            renderType: "Bare",
            items: [
              new Label({ text: "Recipient", labelFor: _recipientInput }).addStyleClass("sapUiTinyMarginTop"),
              _recipientInput,
              new Label({ text: "Template level", labelFor: _levelSelect }).addStyleClass("sapUiSmallMarginTop"),
              _levelSelect
            ]
          }).addStyleClass("sapUiContentPadding")
        ],
        beginButton: new Button({
          text: "Send",
          type: "Emphasized",
          icon: "sap-icon://email",
          press: function () { handlers.onTestEmailConfirm(); }
        }),
        endButton: new Button({
          text: "Cancel",
          press: function () { _dialog.close(); }
        })
      });

      _dialog.open();
    },

    onTestEmailConfirm: async function () {
      const to = (_recipientInput.getValue() || "").trim();
      if (!EMAIL_RE.test(to)) {
        MessageBox.error("Please enter a valid email address.");
        return;
      }
      const level = parseInt(_levelSelect.getSelectedKey(), 10) || 0;

      const busy = new BusyDialog({ text: "Sending test email…" });
      busy.open();
      try {
        const body = await _postTestEmail(to, level);
        busy.close();
        _dialog.close();
        _reportResult(to, body);
      } catch (e) {
        busy.close();
        MessageBox.error("Request failed: " + e.message);
      } finally {
        busy.destroy();
      }
    }

  };

  return handlers;
});
