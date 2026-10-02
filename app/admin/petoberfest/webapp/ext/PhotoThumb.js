sap.ui.define([
	"sap/m/Dialog",
	"sap/m/Image",
	"sap/m/Button"
], function (Dialog, Image, Button) {
	"use strict";

	// Issue #2597: moderators asked to "see the pictures larger before
	// approving" and for a centered large version — the old "Open in New Tab"
	// did nothing. sap.m.Image exposes no hover event, so we enlarge on press
	// (click / Enter / Space), which is also keyboard- and touch-accessible.
	// The full-size (1280px) image is the same auth-gated express route as the
	// thumbnail, just without ?size=thumb.
	return {
		/**
		 * Open a centered modal dialog showing the full-size submission photo.
		 * Bound from PhotoThumb.fragment.xml via core:require.
		 * @param {sap.ui.base.Event} oEvent press event from the thumbnail Image
		 */
		onEnlarge: function (oEvent) {
			var oImageCtrl = oEvent.getSource();
			var oContext = oImageCtrl.getBindingContext();
			if (!oContext) {
				return;
			}
			var sId = oContext.getProperty("ID");
			var sPetName = oContext.getProperty("petName") || "Submission";
			if (!sId) {
				return;
			}

			var oDialog = new Dialog({
				title: sPetName,
				// Cap the dialog to the viewport so very large photos stay
				// centered and fully visible; the image scales within.
				contentWidth: "90vw",
				contentHeight: "90vh",
				horizontalScrolling: true,
				verticalScrolling: true,
				resizable: true,
				draggable: true,
				content: [
					new Image({
						// Omit ?size=thumb to fetch the 1280px display render.
						src: "/admin/petoberfest/photo/" + encodeURIComponent(sId),
						densityAware: false,
						alt: "Full-size photo of " + sPetName,
						// Fit the width of the dialog content; height follows
						// the image aspect ratio.
						width: "100%"
					})
				],
				endButton: new Button({
					text: "Close",
					press: function () {
						oDialog.close();
					}
				}),
				afterClose: function () {
					oDialog.destroy();
				}
			});

			oDialog.addStyleClass("sapUiContentPadding");
			oDialog.open();
		}
	};
});
