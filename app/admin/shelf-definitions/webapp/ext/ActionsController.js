sap.ui.define([
  "sap/m/MessageBox",
  "sap/m/MessageToast"
], function (MessageBox, MessageToast) {
  "use strict";

  return {
    onGenerateForBlanks: function (oEvent) {
      MessageToast.show("Generate for blanks — handler stub (Task 5 wires the real call)");
    },
    onRegenerateSelected: function (oEvent) {
      MessageToast.show("Regenerate selected — handler stub (Task 5)");
    },
    onRegenerateOne: function (oEvent) {
      MessageToast.show("Regenerate one — handler stub (Task 5)");
    },
    onMarkReviewed: function (oEvent) {
      MessageToast.show("Mark reviewed — handler stub (Task 5)");
    }
  };
});
