// Plain UI5 module for the Advocates Object Page header actions.
//
// Why NOT a ControllerExtension: Fiori Elements v4 resolves `press`
// references in manifest action config as plain modules (loader path
// `<dotted-name>.js`), not as controller extensions (loader path
// `<dotted-name>.controller.js`). Mismatching the suffix produces:
//
//   failed to load 'sap/tutorials/admin/advocates/ext/AdvocatePhotoController.js'
//
// Press handlers don't need lifecycle hooks — they get the binding
// context(s) directly. A bare `sap.ui.define` module returning an
// object literal is the right shape.
//
// FE V4 manifest-action handler signature (single argument):
//   - For OP header actions: an array of length 1 — [<page context>]
//   - For List Report toolbar actions: an array of selected rows
//   - For some FE variants: a single Context (no array wrapper)
//   - Legacy / direct UI5 wiring: a UI5 Event (use getSource().getBindingContext())
// resolveCtx() handles all four shapes — Tom's "ctx.getModel is not a
// function" report on 2026-06-18 proved FE V4 was passing the array form.
sap.ui.define([
  "sap/m/MessageToast",
  "sap/m/MessageBox"
], function (MessageToast, MessageBox) {
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

  // Resolve the binding context regardless of how FE V4 invoked the handler.
  function resolveCtx(arg) {
    if (!arg) return null;
    // FE V4 default for manifest actions: contexts array (single-element for OP).
    if (Array.isArray(arg)) return arg[0] || null;
    // Already a Context (has getModel/getObject).
    if (typeof arg.getModel === "function") return arg;
    // UI5 Event — pull source's binding context.
    if (typeof arg.getSource === "function") {
      const src = arg.getSource();
      if (src && typeof src.getBindingContext === "function") {
        return src.getBindingContext();
      }
    }
    return null;
  }

  return {

    /**
     * Header action: prompt for a file, base64-encode, call the
     * Advocates.uploadPhoto bound action. The server runs sharp →
     * 256/64 WebP, upserts AdvocatePhotos, flips hasPhoto.
     */
    onUploadPhotoPress: function (arg) {
      const ctx = resolveCtx(arg);
      if (!ctx) {
        MessageToast.show("Open an advocate first");
        return;
      }
      // Build a transient <input type=file> so we don't need a fragment.
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
          const model = ctx.getModel();
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
          // Refresh the OP so hasPhoto / photoUpdatedAt re-resolve.
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
     * AdvocatePhotos row, flips hasPhoto=false.
     */
    onClearPhotoPress: function (arg) {
      const ctx = resolveCtx(arg);
      if (!ctx) {
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
              const model = ctx.getModel();
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

  };
});
