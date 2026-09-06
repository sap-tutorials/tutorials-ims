// Plain UI5 module for the Events Object Page header actions (#2133).
//
// Mirrors app/admin/devtoberfest/webapp/ext/BannerController.js — see that file
// for the full rationale on why this is a bare `sap.ui.define` module (NOT a
// ControllerExtension): FE V4 resolves manifest `press` references as plain
// modules (loader path `<dotted-name>.js`), and press handlers get the binding
// context(s) directly.
//
// The logo is written via the `uploadEventLogo` BOUND ACTION on
// AdminService.Events, which takes base64 (`imageBase64`, `mimeType`) and runs
// the sharp → WebP → BLOB pipeline server-side. We do NOT use a Fiori UploadSet:
// the logo is a 1:1 composition whose key IS the parent association, and FE's
// UploadSet "Create" POSTs a new composition row, which OData rejects.
sap.ui.define([
  "sap/m/MessageToast",
  "sap/m/MessageBox"
], function (MessageToast, MessageBox) {
  "use strict";

  // Resolve the binding context regardless of how FE V4 invoked the handler.
  function resolveCtx(arg) {
    if (!arg) return null;
    if (Array.isArray(arg)) return arg[0] || null;
    if (typeof arg.getModel === "function") return arg;
    if (typeof arg.getSource === "function") {
      const src = arg.getSource();
      if (src && typeof src.getBindingContext === "function") {
        return src.getBindingContext();
      }
    }
    return null;
  }

  // Read a File into a base64 string (no data: prefix — the server strips it
  // defensively anyway, but we send the bare payload).
  function fileToBase64(file) {
    return new Promise(function (resolve, reject) {
      const reader = new FileReader();
      reader.onload = function () {
        const comma = String(reader.result).indexOf(",");
        resolve(comma >= 0 ? String(reader.result).slice(comma + 1) : String(reader.result));
      };
      reader.onerror = function () { reject(reader.error || new Error("read failed")); };
      reader.readAsDataURL(file);
    });
  }

  return {

    /**
     * Header action: prompt for an image file, base64-encode it client-side,
     * and invoke the AdminService.uploadEventLogo bound action on the current
     * event. The server runs the sharp pipeline (resize → WebP), upserts the
     * EventLogo row, and flips hasLogo + logoUpdatedAt.
     */
    onUploadEventLogoPress: function (arg) {
      const ctx = resolveCtx(arg);
      if (!ctx) {
        MessageToast.show("Open an event first");
        return;
      }
      const ev = ctx.getObject ? ctx.getObject() : null;
      if (ev && ev.IsActiveEntity === false) {
        MessageBox.warning(
          "Save or cancel your current edits before uploading a logo. " +
          "The logo applies to the saved record, not to the draft."
        );
        return;
      }
      const input = document.createElement("input");
      input.type = "file";
      input.accept = "image/jpeg,image/png,image/webp";
      input.style.display = "none";
      document.body.appendChild(input);
      input.addEventListener("change", async function () {
        try {
          const file = input.files && input.files[0];
          if (!file) return;
          if (file.size > 8 * 1024 * 1024) {
            MessageBox.error("Logo too large (max 8 MB).");
            return;
          }
          MessageToast.show("Uploading logo…");
          const imageBase64 = await fileToBase64(file);
          const model = ctx.getModel();
          const op = model.bindContext("AdminService.uploadEventLogo(...)", ctx);
          op.setParameter("imageBase64", imageBase64);
          op.setParameter("mimeType", file.type || "image/png");
          await op.execute();
          MessageToast.show("Logo uploaded.");
          if (ctx.refresh) ctx.refresh();
        } catch (err) {
          MessageBox.error("Logo upload failed: " + (err && err.message ? err.message : err));
        } finally {
          input.remove();
        }
      });
      input.click();
    },

    /**
     * Header action: confirm + call AdminService.clearEventLogo. Drops the
     * EventLogo row and flips hasLogo=false.
     */
    onClearEventLogoPress: function (arg) {
      const ctx = resolveCtx(arg);
      if (!ctx) {
        MessageToast.show("Open an event first");
        return;
      }
      const ev = ctx.getObject ? ctx.getObject() : null;
      if (ev && ev.IsActiveEntity === false) {
        MessageBox.warning("Save or cancel your current edits before clearing the logo.");
        return;
      }
      MessageBox.confirm(
        "Remove this event's logo? The image will be deleted from the server.",
        {
          title: "Clear logo",
          onClose: async function (action) {
            if (action !== MessageBox.Action.OK) return;
            try {
              const model = ctx.getModel();
              const op = model.bindContext("AdminService.clearEventLogo(...)", ctx);
              await op.execute();
              MessageToast.show("Logo cleared.");
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
