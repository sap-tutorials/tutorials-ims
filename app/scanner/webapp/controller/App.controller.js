sap.ui.define([
    "sap/ui/core/mvc/Controller",
    "sap/m/MessageToast",
    "sap/m/MessageBox",
    "sap/ui/model/json/JSONModel",
    "sap/ndc/BarcodeScanner"
], function (BaseController, MessageToast, MessageBox, JSONModel, BarcodeScanner) {
    "use strict";

    var CONTESTANT_DEFAULTS = {
        uid: null,
        eventId: null,
        lastName: "",
        firstInitial: "",
        claimedCount: 0,
        tutorialsCompleted: "",
        groupsCompleted: "",
        missionsCompleted: "",
        prizeRecords: "",
        scanTime: "",
        loaded: false,
        loading: false
    };

    return BaseController.extend("sap.tutorials.scanner.controller.App", {

        onInit: function () {
            this._oContestantModel = new JSONModel(Object.assign({}, CONTESTANT_DEFAULTS));
            this.getView().setModel(this._oContestantModel, "contestant");
            this.oStatusModel = BarcodeScanner.getStatusModel();
            this.getView().setModel(this.oStatusModel, "status");
        },

        _resetContestantModel: function () {
            this._oContestantModel.setData(Object.assign({}, CONTESTANT_DEFAULTS));
        },

        _getContestant: async function (uid, eventId) {
            this._oContestantModel.setProperty("/loading", true);
            try {
                var oModel = this.getView().getModel();
                var oContext = oModel.bindContext("/getContestant(...)");
                oContext.setParameter("accountNumber", uid);
                oContext.setParameter("eventId", eventId);
                await oContext.execute();
                var result = oContext.getBoundContext().getObject();
                this._oContestantModel.setProperty("/lastName", result.lastName || "");
                this._oContestantModel.setProperty("/firstInitial", result.firstInitial || "");
                this._oContestantModel.setProperty("/tutorialsCompleted", result.tutorialsCompleted || "");
                this._oContestantModel.setProperty("/groupsCompleted", result.groupsCompleted || "");
                this._oContestantModel.setProperty("/missionsCompleted", result.missionsCompleted || "");
                this._oContestantModel.setProperty("/prizeRecords", result.prizeRecords || "");
                this._oContestantModel.setProperty("/claimedCount", result.claimedCount || 0);
                this._oContestantModel.setProperty("/loaded", true);
                this._oContestantModel.setProperty("/loading", false);
            } catch (e) {
                this._oContestantModel.setProperty("/loading", false);
                throw e;
            }
        },

        _processScanResult: async function (text, cancelled) {
            if (cancelled) {
                MessageToast.show("Scan cancelled", { duration: 1000 });
                return;
            }

            if (!text) {
                this._resetContestantModel();
                return;
            }

            var scanResult;
            try {
                scanResult = JSON.parse(text);
            } catch (e) {
                MessageBox.error("Invalid barcode format");
                return;
            }

            var payload = scanResult.payload || {};
            this._oContestantModel.setProperty("/uid", scanResult.uid || null);
            this._oContestantModel.setProperty("/eventId", payload.eventId ? Number(payload.eventId) : null);
            this._oContestantModel.setProperty("/loaded", false);

            try {
                await this._getContestant(
                    this._oContestantModel.getProperty("/uid"),
                    this._oContestantModel.getProperty("/eventId")
                );
            } catch (e) {
                MessageBox.error("Could not load contestant: " + (e.message || "Unknown error"));
                this._resetContestantModel();
            }
        },

        onScanPress: function () {
            BarcodeScanner.scan(
                function (mResult) {
                    this._processScanResult(mResult.text, mResult.cancelled);
                }.bind(this),
                function (oError) {
                    this.onScanError(oError);
                }.bind(this)
            );
        },

        onScanAgainPress: function () {
            this._resetContestantModel();
            BarcodeScanner.scan(
                function (mResult) {
                    this._processScanResult(mResult.text, mResult.cancelled);
                }.bind(this),
                function (oError) {
                    this.onScanError(oError);
                }.bind(this)
            );
        },

        onScanError: function (oEvent) {
            var msg = typeof oEvent === "string"
                ? oEvent
                : (oEvent && oEvent.message) || "Unknown error";
            MessageBox.error("Scanner error: " + msg);
        },

        onClaimPrize: async function () {
            var oContestantModel = this._oContestantModel;
            var uid = oContestantModel.getProperty("/uid");
            var eventId = oContestantModel.getProperty("/eventId");
            var claimedCount = oContestantModel.getProperty("/claimedCount");

            if (claimedCount >= 2) {
                MessageBox.warning("Cap reached (2 of 2). No further prizes can be recorded.");
                return;
            }

            oContestantModel.setProperty("/loaded", false);
            oContestantModel.setProperty("/loading", true);

            try {
                var oModel = this.getView().getModel();
                var oContext = oModel.bindContext("/claimPrizeForContestant(...)");
                oContext.setParameter("accountNumber", uid);
                oContext.setParameter("eventId", eventId);
                await oContext.execute();
                var result = oContext.getBoundContext().getObject();
                MessageToast.show(result.message || "Prize recorded!", { duration: 2000 });

                try {
                    await this._getContestant(uid, eventId);
                } catch (e) {
                    MessageBox.error("Could not refresh contestant: " + (e.message || "Unknown error"));
                    oContestantModel.setProperty("/loading", false);
                    oContestantModel.setProperty("/loaded", true);
                }
            } catch (e) {
                MessageBox.error("Could not claim prize: " + (e.message || "Unknown error"));
                oContestantModel.setProperty("/loading", false);
                oContestantModel.setProperty("/loaded", true);
            }
        }
    });
});
