sap.ui.define([
  'sap/m/MessageBox',
  'sap/m/MessageToast',
], (MessageBox, MessageToast) => {
  'use strict';
  return {
    /**
     * Press handler for the "Rebuild this tutorial" header action.
     * Wired via the action's DataFieldForAction → AdminService.rebuildContent
     * binding in the CDS annotations. Fiori Elements invokes this when the
     * user clicks the button (after our manifest's controllerExtensions
     * override redirects the press here).
     *
     * Flow:
     *  1. Resolve the bound Tutorial row from the view's binding context.
     *  2. Confirm via MessageBox with the tutorial title interpolated.
     *  3. On confirm, execute the bound action.
     *  4. Show a toast on success / message-box on error.
     */
    onRebuildTutorial: function () {
      const oContext = this.getView().getBindingContext();
      if (!oContext) {
        MessageBox.error('No tutorial bound to this view.');
        return;
      }
      const oData = oContext.getObject() || {};
      const sTitle = oData.title || oData.slug || '(this tutorial)';

      const oResourceBundle = this.getView().getModel('i18n').getResourceBundle();
      const sDialogTitle   = oResourceBundle.getText('RebuildTutorialDialogTitle');
      const sDialogMessage = oResourceBundle.getText('RebuildTutorialDialogMessage', [sTitle]);
      const sToastSuccess  = oResourceBundle.getText('RebuildTutorialToastSuccess',  [sTitle]);
      const sToastError    = oResourceBundle.getText('RebuildTutorialToastError', ['']);

      MessageBox.confirm(sDialogMessage, {
        title: sDialogTitle,
        actions: [MessageBox.Action.OK, MessageBox.Action.CANCEL],
        emphasizedAction: MessageBox.Action.OK,
        onClose: (sResult) => {
          if (sResult !== MessageBox.Action.OK) return;

          const oModel = this.getView().getModel();
          const oAction = oModel.bindContext(
            'AdminService.rebuildContent(...)',
            oContext,
            { $$inheritExpandSelect: true }
          );

          oAction.execute()
            .then(() => {
              MessageToast.show(sToastSuccess, { duration: 5000 });
            })
            .catch((err) => {
              const msg = err?.message ?? String(err);
              MessageBox.error(sToastError + msg);
            });
        },
      });
    },
  };
});
