sap.ui.define([
  "sap/ui/core/mvc/Controller",
  "sap/ui/model/json/JSONModel",
  "sap/m/MessageToast",
  "sap/m/MessageBox"
], function (Controller, JSONModel, MessageToast, MessageBox) {
  "use strict";

  // Admin maintenance form for the PROD-only NGDS auto-send feed. Edits two
  // ImsConfig knobs via unbound AdminService actions:
  //   - ngds.autosend.enabled  → toggleNgdsAutoSend(enabled)
  //   - ngds.autosend.epoch    → setNgdsAutoSendEpoch(epoch)  (ISO UTC or "")
  // and reads live status via getNgdsAutoSendConfig(). The epoch is a cutover
  // watermark: completions earned before it (and any createdBy='migration'
  // rows) are never sent — legacy IMS already credited those. See
  // srv/lib/ngds-autosend.js.
  //
  // The DateTimePicker is driven by dateValue (a JS Date in the browser's
  // local zone) rather than a formatted-string binding, so we convert
  // explicitly: stored ISO (UTC) → local Date on load, local Date → UTC ISO on
  // save. A live UTC echo under the field shows exactly what will be stored.
  return Controller.extend("sap.tutorials.admin.ngds.controller.Settings", {
    onInit: function () {
      var oJSON = new JSONModel({
        enabled: false,
        environment: "",
        effective: false,
        epoch: "",            // stored ISO UTC string (or "")
        epochUtcDisplay: ""   // live echo of what Save will persist
      });
      this.getView().setModel(oJSON, "settings");
      this._loadSettings();
    },

    _getPicker: function () {
      return this.byId("epochPicker");
    },

    _loadSettings: function () {
      var self = this;
      var oModel = this.getView().getModel("settings");
      fetch("/admin/getNgdsAutoSendConfig()", {
        credentials: "include",
        headers: { "Accept": "application/json" }
      })
        .then(function (res) {
          if (!res.ok) { throw new Error("HTTP " + res.status); }
          return res.json();
        })
        .then(function (payload) {
          // OData wraps unbound-function results under `value` on some stacks
          // and returns the flat object on others. Accept both shapes.
          var data = payload && payload.value ? payload.value : payload;
          var epoch = data.epoch || "";
          oModel.setData({
            enabled: !!data.enabled,
            environment: data.environment || "",
            effective: !!data.effective,
            epoch: epoch,
            epochUtcDisplay: self._utcEcho(epoch)
          });
          // Sync the picker: parse the stored UTC ISO into a JS Date (rendered
          // in the operator's local zone). Empty → clear the field.
          var oPicker = self._getPicker();
          if (oPicker) {
            oPicker.setDateValue(epoch ? new Date(epoch) : null);
          }
        })
        .catch(function (err) {
          MessageToast.show("Failed to load NGDS config: " + err.message);
        });
    },

    // Build the "will store … / not set" echo line from a stored ISO string.
    _utcEcho: function (isoOrEmpty) {
      var bundle = this.getView().getModel("i18n").getResourceBundle();
      if (!isoOrEmpty) { return bundle.getText("epochEchoNone"); }
      return bundle.getText("epochEchoSet", [isoOrEmpty]);
    },

    // Recompute the echo from the picker's current local Date (called on change
    // and before save) → UTC ISO with millis stripped, matching the server's
    // setNgdsAutoSendEpoch normalization.
    _pickerToIso: function () {
      var oPicker = this._getPicker();
      var oDate = oPicker && oPicker.getDateValue();
      if (!oDate) { return ""; }
      return new Date(oDate.getTime()).toISOString().replace(/\.\d{3}Z$/, "Z");
    },

    onEpochChange: function () {
      var iso = this._pickerToIso();
      this.getView().getModel("settings").setProperty("/epochUtcDisplay", this._utcEcho(iso));
    },

    onReload: function () {
      this._loadSettings();
    },

    onSave: function () {
      var self = this;
      var data = this.getView().getModel("settings").getData();
      var enabled = !!data.enabled;
      var epochIso = this._pickerToIso();

      this._csrfToken()
        .then(function (token) {
          // Persist the enable flag first, then the epoch. Both are unbound
          // actions POSTed to /admin/<action>. Sequential so a failure on
          // either surfaces a precise message.
          return self._postAction(token, "toggleNgdsAutoSend", { enabled: enabled })
            .then(function () {
              return self._postAction(token, "setNgdsAutoSendEpoch", { epoch: epochIso });
            });
        })
        .then(function () {
          MessageToast.show(self.getView().getModel("i18n").getResourceBundle().getText("saved"));
          self._loadSettings();
        })
        .catch(function (err) {
          MessageBox.error("Save failed: " + err.message);
        });
    },

    _csrfToken: function () {
      return fetch("/admin/$metadata", {
        method: "HEAD",
        credentials: "include",
        headers: { "x-csrf-token": "fetch" }
      }).then(function (res) {
        return res.headers.get("x-csrf-token") || "";
      });
    },

    _postAction: function (token, action, body) {
      return fetch("/admin/" + action, {
        method: "POST",
        credentials: "include",
        headers: {
          "Content-Type": "application/json",
          "Accept": "application/json",
          "x-csrf-token": token
        },
        body: JSON.stringify(body)
      }).then(function (res) {
        if (!res.ok) {
          return res.text().then(function (txt) {
            throw new Error(action + ": " + (txt || "HTTP " + res.status));
          });
        }
        return res;
      });
    }
  });
});
