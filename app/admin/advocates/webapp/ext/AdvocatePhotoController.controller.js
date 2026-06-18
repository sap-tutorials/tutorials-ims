sap.ui.define([
  "sap/ui/core/mvc/ControllerExtension",
  "sap/m/MessageToast",
  "sap/m/MessageBox"
], function (ControllerExtension, MessageToast, MessageBox) {
  "use strict";

  // Read a File as a base64-encoded string (without the data: prefix).
  function readFileAsBase64(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error("Failed to read file"));
      reader.onload = () => {
        const result = reader.result || "";
        // FileReader's data URL: "data:image/jpeg;base64,..." — strip prefix.
        const idx = result.indexOf(",");
        resolve(idx >= 0 ? result.slice(idx + 1) : result);
      };
      reader.readAsDataURL(file);
    });
  }

  // Pull the current Advocate's ID from the Object Page's binding context.
  // Works for both active and draft modes; we always invoke the action on
  // the active row by stripping IsActiveEntity if present.
  function advocateContextId(view) {
    const ctx = view && view.getBindingContext && view.getBindingContext();
    if (!ctx) return null;
    return ctx.getObject && ctx.getObject().ID;
  }

  return ControllerExtension.extend("sap.tutorials.admin.advocates.ext.AdvocatePhotoController", {

    /**
     * Header action: prompt for a file, base64-encode, call the
     * Advocates.uploadPhoto bound action. The server runs sharp ->
     * 256/64 WebP, upserts AdvocatePhotos, flips hasPhoto. The Object
     * Page's HeaderInfo.ImageUrl re-renders on the next refresh.
     */
    onUploadPhotoPress: function () {
      const ctrl = this;
      const view = this.base.getView();
      const advId = advocateContextId(view);
      if (!advId) {
        MessageToast.show("Open an advocate first");
        return;
      }
      // Build a transient <input type=file> so we don't have to ship a
      // dialog fragment. The element is removed after the picker resolves.
      const input = document.createElement("input");
      input.type = "file";
      input.accept = "image/jpeg,image/png,image/webp,image/gif";
      input.style.display = "none";
      document.body.appendChild(input);
      input.addEventListener("change", async function () {
        try {
          const file = input.files && input.files[0];
          if (!file) return;
          if (file.size > 5 * 1024 * 1024) {
            MessageBox.error("Photo too large (max 5 MB).");
            return;
          }
          MessageToast.show("Uploading…");
          const photoBase64 = await readFileAsBase64(file);
          const model = view.getModel();
          const ctx = view.getBindingContext();
          // OData v4 bound-action invocation. The action lives on
          // AdminService.Advocates as 'AdminService.uploadPhoto'.
          const op = model.bindContext(
            "AdminService.uploadPhoto(...)",
            ctx
          );
          op.setParameter("photoBase64", photoBase64);
          op.setParameter("mimeType", file.type || "image/jpeg");
          await op.execute();
          MessageToast.show("Photo uploaded.");
          // Refresh the Object Page so HeaderInfo.ImageUrl re-resolves.
          if (ctx.refresh) ctx.refresh();
        } catch (err) {
          MessageBox.error("Upload failed: " + (err && err.message ? err.message : err));
        } finally {
          input.remove();
        }
      });
      input.click();
    },

    /**
     * Header action: confirm + call Advocates.clearPhoto. Drops the
     * AdvocatePhotos row, flips hasPhoto=false. Header avatar disappears.
     */
    onClearPhotoPress: function () {
      const view = this.base.getView();
      const advId = advocateContextId(view);
      if (!advId) {
        MessageToast.show("Open an advocate first");
        return;
      }
      MessageBox.confirm(
        "Remove this advocate's photo? The image will be deleted from the server.",
        {
          title: "Clear photo",
          onClose: async function (action) {
            if (action !== MessageBox.Action.OK) return;
            try {
              const model = view.getModel();
              const ctx = view.getBindingContext();
              const op = model.bindContext(
                "AdminService.clearPhoto(...)",
                ctx
              );
              await op.execute();
              MessageToast.show("Photo cleared.");
              if (ctx.refresh) ctx.refresh();
            } catch (err) {
              MessageBox.error("Clear failed: " + (err && err.message ? err.message : err));
            }
          }
        }
      );
    }

  });
});
