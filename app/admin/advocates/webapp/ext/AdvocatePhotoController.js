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
     * Header action: prompt for a file and POST it as a JSON base64 body
     * to POST /admin/advocates/:slug/photo (issue #417). The server runs
     * the sharp pipeline (256/64 WebP), upserts AdvocatePhotos, flips
     * Advocates.hasPhoto + photoUrl + photoUpdatedAt.
     *
     * Transport is JSON base64 (not multipart/form-data): the Akamai edge
     * on developers.sap.com silently stalls/blocks multipart binary uploads
     * while passing JSON on the same /admin/* xsuaa + CSRF path. base64
     * inflates the body ~33%, well within the server's 8 MB parser limit.
     *
     * Draft mode is gated OUT in the manifest (`enabled` expression
     * checks IsActiveEntity === true). The defensive check below guards
     * any programmatic invocation that bypasses the toolbar: the server
     * endpoint resolves the slug against the ACTIVE Advocates row, so
     * a draft-mode upload would succeed at the server level but appear
     * "not persisted" in the OP until the draft was activated — a
     * confusing UX that Tom flagged 2026-06-23. Photo is an out-of-band
     * attribute, not part of the structured draft contract.
     */
    onUploadPhotoPress: function (arg) {
      const ctx = resolveCtx(arg);
      if (!ctx) {
        MessageToast.show("Open an advocate first");
        return;
      }
      // We need the slug from the binding context to construct the URL.
      // ctx.getObject() returns the current row's properties; slug is
      // committed at draft-NEW (per advocate-handlers.js) so it's
      // always present here.
      const advocate = ctx.getObject ? ctx.getObject() : null;
      const slug = advocate && advocate.slug;
      if (!slug) {
        MessageBox.error("Cannot upload: advocate has no slug yet. Save the draft first.");
        return;
      }
      // Defensive guard — duplicates the manifest `enabled` expression.
      // If we get here in draft mode, the upload would succeed against
      // the active row but the user wouldn't see the change in the OP
      // they're editing. Better to refuse with a clear message.
      if (advocate.IsActiveEntity === false) {
        MessageBox.warning(
          "Save or cancel your current edits before uploading a photo. " +
          "Photos apply to the saved record, not to the draft."
        );
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
          // Read the file as base64 (data: URL, strip the prefix). JSON base64
          // survives the Akamai edge where multipart/form-data was silently
          // stalled/blocked. The approuter forwards XSUAA session cookies to
          // /admin/* so credentials: 'same-origin' is sufficient. CSRF: fetch a
          // token first (approuter enforces on non-GET POSTs to /admin/*).
          const photoBase64 = await new Promise(function (resolve, reject) {
            const reader = new FileReader();
            reader.onload = function () { resolve(String(reader.result).split(",")[1] || ""); };
            reader.onerror = function () { reject(reader.error || new Error("could not read the selected file")); };
            reader.readAsDataURL(file);
          });
          const csrfResp = await fetch("/admin/", { headers: { "x-csrf-token": "fetch" }, credentials: "same-origin" });
          const csrf = csrfResp.headers.get("x-csrf-token");
          const resp = await fetch(
            "/admin/advocates/" + encodeURIComponent(slug) + "/photo",
            {
              method: "POST",
              credentials: "same-origin",
              headers: {
                "Accept": "application/json",
                "Content-Type": "application/json",
                "x-csrf-token": csrf || "fetch"
              },
              body: JSON.stringify({ filename: file.name, mimeType: file.type, photoBase64: photoBase64 })
            }
          );
          if (!resp.ok) {
            // Server returns { error: CODE, message }. A CDN/edge rejection is
            // HTML, not JSON — surface the status + any Akamai "Reference #…"
            // so the failure is never silent.
            let detail = "HTTP " + resp.status;
            const text = await resp.text().catch(function () { return ""; });
            try {
              const body = JSON.parse(text);
              if (body && body.message) { detail = body.message; }
            } catch (e) {
              const ref = text.match(/#\s*(\d+\.[\w.\-]+)/);
              if (ref) { detail = "HTTP " + resp.status + " (reference " + ref[1] + ") — possible network/CDN issue"; }
            }
            throw new Error(detail);
          }
          MessageToast.show("Photo uploaded.");
          // Refresh the OP so hasPhoto / photoUpdatedAt / photoUrl
          // re-resolve and the header avatar re-renders.
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
     * AdvocatePhotos row, flips hasPhoto=false. The action has no body
     * payload so the OData binding shape is fine for it — no need to
     * migrate to a REST endpoint.
     *
     * Same draft-mode rationale as onUploadPhotoPress: the action is
     * bound to the active Advocate, so calling it on a draft would
     * either fail at the OData layer or mutate state outside the
     * draft envelope. Gated by `enabled: IsActiveEntity === true` in
     * the manifest; defensive check duplicates that here.
     */
    onClearPhotoPress: function (arg) {
      const ctx = resolveCtx(arg);
      if (!ctx) {
        MessageToast.show("Open an advocate first");
        return;
      }
      const advocate = ctx.getObject ? ctx.getObject() : null;
      if (advocate && advocate.IsActiveEntity === false) {
        MessageBox.warning(
          "Save or cancel your current edits before clearing the photo."
        );
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
