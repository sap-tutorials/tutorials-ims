// Plain UI5 module for the Devtoberfest Config Object Page header actions.
//
// Mirrors app/admin/advocates/webapp/ext/AdvocatePhotoController.js — see that
// file for the full rationale on why this is a bare `sap.ui.define` module (NOT
// a ControllerExtension): FE V4 resolves manifest `press` references as plain
// modules (loader path `<dotted-name>.js`), and press handlers get the binding
// context(s) directly.
//
// Difference from the advocate photo flow: advocates POST multipart/form-data
// to a REST endpoint; the banner is written via the `uploadBanner` BOUND ACTION
// on AdminService.DevtoberfestConfig, which takes base64 (`imageBase64`,
// `mimeType`) and runs the sharp → WebP → BLOB pipeline server-side. We do NOT
// use a Fiori UploadSet: the banner is a 1:1 composition whose key IS the parent
// association, and FE's UploadSet "Create" POSTs a new composition row, which
// OData rejects ("Method POST is not allowed for singletons and individual
// entities" — confirmed live on DEV 2026-07-29).
sap.ui.define([
  "sap/m/MessageToast",
  "sap/m/MessageBox"
], function (MessageToast, MessageBox) {
  "use strict";

  // Resolve the binding context regardless of how FE V4 invoked the handler.
  // (Same four-shape handling as AdvocatePhotoController.)
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
        // reader.result is a data: URL; strip the "data:<mime>;base64," prefix.
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
     * and invoke the AdminService.uploadBanner bound action on the current
     * config. The server runs the sharp pipeline (resize → WebP), upserts the
     * DevtoberfestBanner row, and flips hasBanner + bannerUpdatedAt.
     *
     * Gated to active (non-draft) rows: the action is bound to the active
     * DevtoberfestConfig, so a draft-mode upload would mutate state outside the
     * draft envelope. The manifest `enabled` expression already restricts this;
     * the check below is a defensive duplicate.
     */
    onUploadBannerPress: function (arg) {
      const ctx = resolveCtx(arg);
      if (!ctx) {
        MessageToast.show("Open a Devtoberfest configuration first");
        return;
      }
      const cfg = ctx.getObject ? ctx.getObject() : null;
      if (cfg && cfg.IsActiveEntity === false) {
        MessageBox.warning(
          "Save or cancel your current edits before uploading a banner. " +
          "The banner applies to the saved record, not to the draft."
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
            MessageBox.error("Banner too large (max 8 MB).");
            return;
          }
          MessageToast.show("Uploading banner…");
          const imageBase64 = await fileToBase64(file);
          const model = ctx.getModel();
          // Bind + invoke the bound action against the current config context.
          const op = model.bindContext("AdminService.uploadBanner(...)", ctx);
          op.setParameter("imageBase64", imageBase64);
          op.setParameter("mimeType", file.type || "image/png");
          await op.execute();
          MessageToast.show("Banner uploaded.");
          // Refresh so hasBanner / bannerUpdatedAt re-resolve in the header + facet.
          if (ctx.refresh) ctx.refresh();
        } catch (err) {
          MessageBox.error("Banner upload failed: " + (err && err.message ? err.message : err));
        } finally {
          input.remove();
        }
      });
      input.click();
    },

    /**
     * Header action: confirm + call AdminService.clearBanner. Drops the
     * DevtoberfestBanner row and flips hasBanner=false. Same draft-mode
     * rationale as onUploadBannerPress.
     */
    onClearBannerPress: function (arg) {
      const ctx = resolveCtx(arg);
      if (!ctx) {
        MessageToast.show("Open a Devtoberfest configuration first");
        return;
      }
      const cfg = ctx.getObject ? ctx.getObject() : null;
      if (cfg && cfg.IsActiveEntity === false) {
        MessageBox.warning(
          "Save or cancel your current edits before clearing the banner."
        );
        return;
      }
      MessageBox.confirm(
        "Remove this event's banner? The image will be deleted from the server.",
        {
          title: "Clear banner",
          onClose: async function (action) {
            if (action !== MessageBox.Action.OK) return;
            try {
              const model = ctx.getModel();
              const op = model.bindContext("AdminService.clearBanner(...)", ctx);
              await op.execute();
              MessageToast.show("Banner cleared.");
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
