sap.ui.define([
  "sap/ui/core/mvc/Controller",
  "sap/ui/core/Fragment",
  "sap/ui/model/json/JSONModel",
  "sap/m/MessageToast",
  "sap/m/MessageBox",
  "sap/m/Dialog",
  "sap/m/Button",
  "sap/m/Input",
  "sap/m/Label",
  "sap/m/VBox",
  "sap/m/Text",
  "sap/m/Link"
], function (Controller, Fragment, JSONModel, MessageToast, MessageBox, Dialog, Button, Input, Label, VBox, Text, Link) {
  "use strict";

  function deriveExpiryState(expiresAt) {
    if (!expiresAt) return "None";
    var today = new Date();
    var expiry = new Date(expiresAt);
    var todayUTC = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
    var days = Math.floor((expiry.getTime() - todayUTC) / 86400000);
    if (days <= 0) return "Error";
    if (days <= 7) return "Warning";
    if (days <= 14) return "Information";
    return "None";
  }

  return Controller.extend("sap.tutorials.admin.secrets.controller.Secrets", {
    onInit: function () {
      this.getView().setModel(new JSONModel({ items: [] }), "secrets");
      this.getView().setModel(new JSONModel({}), "dialog");
      this._loadSecrets();
    },

    _loadSecrets: function () {
      var oModel = this.getView().getModel("secrets");
      fetch("/admin/Secrets", {
        credentials: "include",
        headers: { "Accept": "application/json" }
      })
        .then(function (res) {
          if (!res.ok) { throw new Error("HTTP " + res.status); }
          return res.json();
        })
        .then(function (body) {
          var items = (body.value || []).map(function (row) {
            row.expiryState = deriveExpiryState(row.expiresAt);
            return row;
          });
          oModel.setData({ items: items });
        })
        .catch(function (err) {
          MessageToast.show("Failed to load secrets: " + err.message);
        });
    },

    onRefresh: function () { this._loadSecrets(); },

    onAdd: function () {
      this.getView().getModel("dialog").setData({
        title: this.getView().getModel("i18n").getResourceBundle().getText("dialogTitleAdd"),
        isNew: true,
        ID: null,
        key: "",
        description: "",
        kind: "other",
        rotationOwner: "",
        rotationDocsUrl: "",
        expiresAt: null,
        lastRotatedAt: null
      });
      this._openDialog();
    },

    onEdit: function (oEvent) {
      var oCtx = oEvent.getSource().getBindingContext("secrets");
      var row = oCtx.getObject();
      this.getView().getModel("dialog").setData({
        title: this.getView().getModel("i18n").getResourceBundle().getText("dialogTitleEdit"),
        isNew: false,
        ID: row.ID,
        key: row.key,
        description: row.description || "",
        kind: row.kind || "other",
        rotationOwner: row.rotationOwner || "",
        rotationDocsUrl: row.rotationDocsUrl || "",
        expiresAt: row.expiresAt || null,
        lastRotatedAt: row.lastRotatedAt || null
      });
      this._openDialog();
    },

    onDelete: function (oEvent) {
      var self = this;
      var oCtx = oEvent.getSource().getBindingContext("secrets");
      var row = oCtx.getObject();
      var bundle = this.getView().getModel("i18n").getResourceBundle();
      MessageBox.confirm(bundle.getText("confirmDelete"), {
        onClose: function (sAction) {
          if (sAction !== MessageBox.Action.OK) { return; }
          self._withCsrf(function (token) {
            return fetch("/admin/Secrets(" + row.ID + ")", {
              method: "DELETE",
              credentials: "include",
              headers: { "x-csrf-token": token }
            });
          }).then(function () {
            MessageToast.show("Deleted");
            self._loadSecrets();
          }).catch(function (err) {
            MessageBox.error("Delete failed: " + err.message);
          });
        }
      });
    },

    _openDialog: function () {
      var self = this;
      if (!this._oDialog) {
        Fragment.load({
          id: this.getView().getId(),
          name: "sap.tutorials.admin.secrets.view.SecretDialog",
          controller: this
        }).then(function (oDialog) {
          self._oDialog = oDialog;
          self.getView().addDependent(oDialog);
          oDialog.open();
        });
      } else {
        this._oDialog.open();
      }
    },

    onDialogSave: function () {
      this._cancelRevealCountdown();
      var self = this;
      var data = this.getView().getModel("dialog").getData();
      var body = {
        key: data.key,
        description: data.description || null,
        kind: data.kind || null,
        rotationOwner: data.rotationOwner || null,
        rotationDocsUrl: data.rotationDocsUrl || null,
        expiresAt: data.expiresAt || null,
        lastRotatedAt: data.lastRotatedAt || null
      };

      this._withCsrf(function (token) {
        if (data.isNew) {
          return fetch("/admin/Secrets", {
            method: "POST",
            credentials: "include",
            headers: {
              "Content-Type": "application/json",
              "Accept": "application/json",
              "x-csrf-token": token
            },
            body: JSON.stringify(body)
          });
        }
        return fetch("/admin/Secrets(" + data.ID + ")", {
          method: "PATCH",
          credentials: "include",
          headers: {
            "Content-Type": "application/json",
            "Accept": "application/json",
            "x-csrf-token": token
          },
          body: JSON.stringify(body)
        });
      }).then(function (res) {
        if (!res.ok) { throw new Error("HTTP " + res.status); }
        MessageToast.show("Saved");
        self._oDialog.close();
        self._loadSecrets();
      }).catch(function (err) {
        MessageBox.error("Save failed: " + err.message);
      });
    },

    onDialogCancel: function () {
      this._cancelRevealCountdown();
      this._oDialog.close();
    },

    _withCsrf: function (fnAfterToken) {
      return fetch("/admin/$metadata", {
        method: "HEAD",
        credentials: "include",
        headers: { "x-csrf-token": "fetch" }
      }).then(function (res) {
        return res.headers.get("x-csrf-token") || "";
      }).then(fnAfterToken);
    },

    // Phase 2-C (#465): Invoke a bound action via OData V4 + CSRF.
    // Wraps the existing _withCsrf(callback) helper.
    _invokeBoundAction: function (secretId, actionName, body) {
      var url = "/admin/Secrets(" + secretId + ")/AdminService." + actionName;
      return this._withCsrf(function (token) {
        return fetch(url, {
          method: "POST",
          credentials: "include",
          headers: {
            "Content-Type": "application/json",
            "Accept": "application/json",
            "x-csrf-token": token
          },
          body: JSON.stringify(body || {})
        });
      }).then(function (res) {
        if (!res.ok) {
          return res.text().then(function (t) {
            throw new Error("HTTP " + res.status + ": " + t);
          });
        }
        return res.json();
      });
    },

    // ──────────────────────────────────────────────────────────────────
    // Phase 2-C (#465): Secret value handlers + reveal countdown.
    // ──────────────────────────────────────────────────────────────────

    onRevealValue: function () {
      var self = this;
      var data = this.getView().getModel("dialog").getData();
      // Reveal is a function (GET) not action — no CSRF, no body.
      fetch("/admin/Secrets(" + data.ID + ")/AdminService.revealSecretValue()", {
        credentials: "include",
        headers: { "Accept": "application/json" }
      }).then(function (res) {
        if (!res.ok) return res.text().then(function (t) {
          MessageBox.error("Reveal failed: " + (t || res.status));
          throw new Error("reveal failed");
        });
        return res.json();
      }).then(function (result) {
        self._startRevealCountdown(result.value, new Date(result.expiresAt));
      }).catch(function () { /* error already surfaced */ });
    },

    onSetValue: function () {
      var self = this;
      var data = this.getView().getModel("dialog").getData();
      this._openSetValueDialog(function (value) {
        return self._invokeBoundAction(data.ID, "setSecretValue", { value: value })
          .then(function (result) {
            self.getView().getModel("dialog").setProperty("/lastRotatedAt", result.lastRotatedAt);
            MessageToast.show("Value saved.");
          });
      });
    },

    onRotate: function () {
      var self = this;
      var data = this.getView().getModel("dialog").getData();
      this._invokeBoundAction(data.ID, "rotateSecretValue", {})
        .then(function (result) {
          if (result.rotated === true) {
            self.getView().getModel("dialog").setProperty("/lastRotatedAt", result.lastRotatedAt);
            self._showRotatedValueDialog(result.newValue, new Date(result.revealExpiresAt));
          } else {
            self._showVendorRotationGuidance(result.rotationDocsUrl, data.ID);
          }
        })
        .catch(function (e) {
          MessageBox.error("Rotate failed: " + e.message);
        });
    },

    onClearValue: function () {
      var self = this;
      var data = this.getView().getModel("dialog").getData();
      MessageBox.confirm(
        "Delete the credstore value for '" + data.key + "'? Metadata stays in HANA.",
        {
          onClose: function (action) {
            if (action !== MessageBox.Action.OK) return;
            self._invokeBoundAction(data.ID, "clearSecretValue", {})
              .then(function () { MessageToast.show("Value cleared."); })
              .catch(function (e) { MessageBox.error("Clear failed: " + e.message); });
          }
        }
      );
    },

    // Reveal countdown — server-supplied expiry; clamped against negative drift.
    // Tracks the active timer so a 2nd Show click cancels the 1st ticker (race fix).
    _startRevealCountdown: function (value, expiresAt) {
      if (this._revealTickerId) {
        clearTimeout(this._revealTickerId);
        this._revealTickerId = null;
      }
      var model = this.getView().getModel("dialog");
      model.setProperty("/revealedValue", value);
      this._tickReveal(model, expiresAt);
    },

    _tickReveal: function (model, expiresAt) {
      var self = this;
      var now = Date.now();
      var remaining = Math.max(0, expiresAt.getTime() - now);
      model.setProperty("/revealSecondsLeft", Math.ceil(remaining / 1000));
      if (remaining <= 0) {
        model.setProperty("/revealedValue", "");
        model.setProperty("/revealSecondsLeft", 0);
        this._revealTickerId = null;
        return;
      }
      // Recursive setTimeout (vs setInterval) — recalculates remaining each
      // tick from wall-clock, so display stays in sync with server-supplied
      // expiresAt even when the tab is backgrounded (browsers throttle
      // setInterval aggressively but re-bias each setTimeout).
      this._revealTickerId = setTimeout(function () {
        self._tickReveal(model, expiresAt);
      }, 1000);
    },

    // ──────────────────────────────────────────────────────────────────
    // Sub-dialogs: SetValue (masked input), RotatedValue (auto-hide
    // reveal of the new value), VendorRotation (guidance + paste bridge).
    // All use imported Dialog/Button/Input/Label/VBox/Text/Link identifiers
    // (Strategy B; matches existing MessageBox / MessageToast style).
    // ──────────────────────────────────────────────────────────────────

    // Phase 2-C (#465): clear any active reveal countdown + zero the model
    // property. Called from dialog cancel/save paths so the plaintext value
    // doesn't linger in the JSONModel after the admin closes the dialog.
    _cancelRevealCountdown: function () {
      if (this._revealTickerId) {
        clearTimeout(this._revealTickerId);
        this._revealTickerId = null;
      }
      var model = this.getView().getModel("dialog");
      if (model) {
        model.setProperty("/revealedValue", "");
        model.setProperty("/revealSecondsLeft", 0);
      }
    },

    _openSetValueDialog: function (onSave) {
      var oInput = new Input({ type: "Password", placeholder: "New secret value" });
      var oDialog = new Dialog({
        title: "Set Secret Value",
        contentWidth: "30rem",
        content: [
          new VBox({
            items: [
              new Label({ text: "Type or paste the new value:" }),
              oInput
            ]
          }).addStyleClass("sapUiSmallMargin")
        ],
        beginButton: new Button({ text: "Save", type: "Emphasized", press: function () {
          var value = oInput.getValue();
          if (!value) { MessageBox.error("Value cannot be empty."); return; }
          onSave(value)
            .then(function () { oDialog.close(); oDialog.destroy(); })
            .catch(function (e) { MessageBox.error("Save failed: " + (e && e.message ? e.message : e)); });
        }}),
        endButton: new Button({ text: "Cancel", press: function () {
          oDialog.close(); oDialog.destroy();
        }})
      });
      oDialog.open();
    },

    _showRotatedValueDialog: function (newValue, expiresAt) {
      // Pop a modal showing the rotated value + auto-hide countdown.
      // Reuses the same _startRevealCountdown ticker; revealedValue model
      // is also bound here. Admin copies the value before auto-hide.
      this._startRevealCountdown(newValue, expiresAt);
      MessageBox.information(
        "New value generated. Visible for ~30s in the dialog field above.",
        { title: "Rotated" }
      );
    },

    _showVendorRotationGuidance: function (rotationDocsUrl, secretId) {
      var self = this;
      var oVBox = new VBox({ items: [
        new Text({ text: "This kind of secret can't be self-rotated. Mint a new value at the vendor's UI, then click 'Paste new value' below." }),
        new Link({
          text: "Rotation docs",
          href: rotationDocsUrl || "",
          target: "_blank",
          visible: !!rotationDocsUrl
        })
      ]}).addStyleClass("sapUiSmallMargin");
      var oDialog = new Dialog({
        title: "Vendor-side Rotation",
        contentWidth: "32rem",
        content: [oVBox],
        beginButton: new Button({ text: "Paste new value", type: "Emphasized", press: function () {
          oDialog.close(); oDialog.destroy();
          // Bridge to the Set Value flow — admin pastes the just-rotated value.
          var data = self.getView().getModel("dialog").getData();
          self._openSetValueDialog(function (value) {
            return self._invokeBoundAction(data.ID, "setSecretValue", { value: value })
              .then(function (result) {
                self.getView().getModel("dialog").setProperty("/lastRotatedAt", result.lastRotatedAt);
                MessageToast.show("Rotation complete.");
              });
          });
        }}),
        endButton: new Button({ text: "Cancel", press: function () {
          oDialog.close(); oDialog.destroy();
        }})
      });
      oDialog.open();
    }
  });
});
