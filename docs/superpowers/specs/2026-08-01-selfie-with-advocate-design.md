# Selfie with an Advocate — Design

**Date:** 2026-08-01
**Status:** Approved (design), pending → implementation plan
**Repo:** `tutorials-ims` (Hugo page + Vue island); consumes the deployed `sap-community-gameboard` `/community/upload_selfie` backend.

## 1. Summary

Rebuild the legacy "Selfie with an Advocate" feature (legacy: a UI5 app in a Fiori Launchpad
sandbox at `/flp/#selfie-ui`) as a **Vue island at `/devtoberfest/selfie/`** on the new
stack. The user picks a Dev-Advocate frame, uploads a photo, the server composites the photo
behind the frame (the already-deployed `POST /community/upload_selfie`), and the user can
crop/rotate and download the result.

The compositing **backend is already live** (Plan D). This is a UI-only build.

## 2. Goals & non-goals

**Goals**
- Advocate-frame picker (carousel/grid of the frame thumbnails).
- Photo upload → `POST /community/upload_selfie` (multipart: the image + `selectedPic` = frame
  name) → receive the composited PNG (base64) → preview.
- In-browser **crop/rotate** of the result + **download**, via a lightweight editor lib (NOT
  sap.suite.ui.commons — that pulled in the whole UI5 stack).
- Vue island, consistent with the arcade/gameboard islands; served through the approuter.
- Clear "your photo is NOT stored" messaging (as legacy).

**Non-goals**
- No UI5 / Fiori Launchpad sandbox (dropped — the reason for the rebuild).
- No live camera capture (legacy was file-upload only; keep that; a stretch camera option is
  out of scope).
- No change to the compositing backend (`/community/upload_selfie` is deployed and unchanged).
- The legacy `selectedPic` UI5-id-prefix strip (`application-selfie-ui-component---App--`) is
  obsolete — we send a clean frame name, so the backend's prefix-strip is a harmless no-op.

## 3. Key decisions (locked with stakeholder)

| Decision | Choice |
|---|---|
| Tech | Vue island (not UI5/FLP) |
| Location | `/devtoberfest/selfie/` |
| Editing | Crop/rotate before download, via a lightweight JS lib (e.g. cropperjs) |
| Backend | Existing `POST /community/upload_selfie` (unchanged) |
| Frame picker | Carousel/grid of advocate-frame thumbnails |

## 4. Architecture

Same island pattern as arcade/gameboard — no new MTA/route.

```
Browser ─▶ tutorial approuter
   /devtoberfest/selfie/            → Hugo static page (island mount)
   /js/selfie.js                     → the Vue island bundle
   /images/devtoberfest/selfie/*     → advocate frame thumbnails (static)
   POST /community/upload_selfie      → gameboard-srv (composite) [already deployed]
```

**Files (tutorials-ims):**
- `hugo/content/devtoberfest/selfie/_index.md`
- `hugo/layouts/devtoberfest/selfie.html` — mount node + `data-api-upload="/community/upload_selfie"`
  + `data-img-base` + `data-frames` (or fetch the frame list) + `<noscript>`.
- `hugo-apps/src/selfie/` — `main.ts`, `Selfie.vue` (orchestrator), `FramePicker.vue`,
  `Uploader.vue`, `Editor.vue` (crop/rotate wrapper over the lib), `types.ts`, `styles.css`,
  `__tests__/`.
- `hugo-apps/vite.config.ts` — `selfie: resolve(__dirname,'src/selfie/main.ts')`.
- `hugo/static/images/devtoberfest/selfie/thumbnails/*` — advocate frame thumbnails.
- Add `cropperjs` (or similar) to `hugo-apps/package.json`.

## 5. Flow

1. **Pick a frame** — `FramePicker` shows the advocate thumbnails (Antonio, DJ, Josh, Kasmire,
   Thomas, Nico, Nora, Rich, Kevin, Michelle, Witalij, Mamikee, Daniel, the Group/Background
   frames, …). Selecting one sets `selectedFrame` = the frame's bare name.
2. **Upload a photo** — `Uploader` (file input, image-only, size-limited client-side to match
   the backend's 20 MB) posts multipart to `/community/upload_selfie` with fields: the image
   file + `selectedPic=<selectedFrame>`. Show a busy state during upload.
3. **Preview + edit** — the response body is a base64 PNG; render as `data:image/png;base64,<body>`.
   `Editor` wraps a crop/rotate lib over the composite.
4. **Download** — a "Download" button saves the (edited) image locally. No server storage.

## 6. Backend contract (consumed, unchanged)

```
POST /community/upload_selfie   (multipart/form-data)
  fields: <image file> (jpeg/png/gif, ≤20MB) + selectedPic=<frameName>
  → 200, body = base64 PNG string of (user photo composited behind the advocate frame)
```
Client renders `data:image/png;base64,` + body. (The backend's legacy `selectedPic` prefix
strip is a no-op for our clean value.)

## 7. Assets

Carry the advocate-frame **thumbnails** into `hugo/static/images/devtoberfest/selfie/thumbnails/`
(the picker only needs thumbnails; the full-res frames live server-side with the backend). Skip
`Originals/` and unused `Silhouette*`. Optimize (`Background2.png` was 12.7 MB — thumbnail only).
The frame list is the set of names the backend has full-res PNGs for; expose it to the island
either as a static `data-frames` JSON or a small `GET /community/selfie/frames` (nice-to-have;
default: hardcode the known frame-name list in the layout data attr, matching the backend's
`images/devtoberfest/selfie/*.png`).

## 8. Testing

- **Unit** (hugo-apps vitest): `FramePicker` selection sets `selectedPic`; `Uploader` posts
  multipart with the image + `selectedPic` to the right URL (mocked fetch); response base64 →
  `data:` URL preview; `Editor` crop/rotate produces a download blob; upload error → friendly
  message (fail-soft, no crash).
- **e2e** (committed, self-skips): `/devtoberfest/selfie/` renders the frame picker + uploader;
  (upload path is mock/skipped in e2e — no real photo).
- **Verification-before-done:** load `/devtoberfest/selfie/` on DEV, pick a frame, upload a
  test image, confirm a composited result comes back and downloads.

## 9. Rollout

Pure tutorials-ims frontend change (island + thumbnails + one dep). Standard
`npm run deploy -- --env dev`. Backend already deployed. Independent of the arcade scene (no
shared files) → the two can be built and deployed in parallel.

## 10. Open questions / risks

- **Frame list source** — hardcoded name list vs. a backend `frames` endpoint. Default to a
  hardcoded list in the layout (matches the deployed backend's frame PNGs); revisit if frames
  change often.
- **Editor lib choice** — cropperjs is the default (mature, framework-agnostic); confirm bundle
  size fits the island budget, else a lighter alternative.
- **CORS/multipart through the approuter** — `/community/*` is already routed + verified; the
  multipart POST should pass through, but verify on DEV (the existing `/upload_selfie` was
  tested at the srv level, not yet via a browser multipart through the approuter).
