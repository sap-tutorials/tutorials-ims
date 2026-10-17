# Design: Official-API video transcripts for AUTOAUTHOR_VIDEO quizzes (#2800)

**Status:** approved-pending (design review)
**Date:** 2026-10-17
**Issue:** [#2800](https://github.com/sap-tutorials/tutorials-ims/issues/2800)
**Target branch:** DEV (PR; never direct-to-main)

## Intent & why

`[AUTOAUTHOR_VIDEO_N url=…]` directives generate a tutorial's validation quiz from a
YouTube video's transcript. Today the transcript is fetched via the deployed CAP app's
`/api/devtoberfest/transcript` endpoint, which uses an undocumented InnerTube/ANDROID_VR
caption path. **That path is blocked from Cloud Foundry datacenter egress** — YouTube
returns `source:none` from the CF IP, though the same fetch works from a workstation IP.
Result: during `rebuild-content.yml` builds the quiz **silently drops** and the tutorial
ships with empty validation (video header + bare "Done" button, no questions). Week 4 of
the Devtoberfest "Fun" track was hand-authored as a stopgap.

The fix replaces the IP-fragile InnerTube path with the **official YouTube Data API v3
`captions.download`** endpoint, authorized by an **OAuth refresh token for the SAP
Developers channel owner**. This is documented, supported, and not subject to the
datacenter IP block. A spike (2026-10-17) confirmed `captions.download` returns full
transcript text for both #2800 videos from the official API.

## Goals

- `AUTOAUTHOR_VIDEO` quizzes generate reliably in CF/CI builds (the #2800 failure gone).
- Transcript source is the **official YouTube Data API**, scoped to the **SAP Developers
  channel only** (`UCNfmelKDrvRmjYwSi9yvrMg`, confirmed in spike).
- Three-tier source resolution with explicit provenance:
  1. **Uploaded captions** (trackKind `standard`) — best.
  2. **Auto-generated captions** (trackKind `ASR`) — accepted (Tom's call); both #2800
     videos are English-ASR-only.
  3. **Video description** (fetched with the existing plain `YOUTUBE_API_KEY`) — fallback
     when no usable English caption track exists.
- Every AUTOAUTHOR_VIDEO quiz carries a **small fixed source notice**. Learner-facing copy
  distinguishes **two** tiers (Tom's call): captions 1 & 2 both render *"Questions generated
  from the video's captions"*; tier 3 renders *"Questions generated from the video
  description"*. (The internal provenance still records uploaded vs auto vs description for
  logs/debugging; only the learner-facing label collapses to two.)
- When even the description is too thin to generate from, the drop is **loud** — a
  greppable warning line AND a signal surfaced in the `rebuild-content.yml` workflow summary
  — but the **rebuild still finishes** (Tom's call: warn-loud-and-continue, so one
  caption-less video never blocks a full content rebuild).
- **Description-fallback length bar:** reuse the existing `MIN_SUBSTANTIVE_WORDS = 50`
  guard (Tom's call) for description text, same threshold as the transcript path. Under 50
  substantive words → loud drop.

## Non-goals

- No support for non-SAP-Developers channels (explicitly out of scope; a directive pointing
  elsewhere is rejected loudly, not silently dropped).
- No change to the runtime quiz-rendering or grading UI beyond adding the source notice.
- No removal of the existing InnerTube module (`srv/lib/devtoberfest-transcript.js`) — it
  stays for the live `/api/devtoberfest/transcript` endpoint used elsewhere; this change
  adds a parallel official-API fetcher for the build path. (A later cleanup may converge
  them; not here.)
- No per-environment OAuth tokens — one shared channel token (Tom's call).

## Anti-goals (would make this a failure even if it "works")

- Shipping an empty quiz silently again — the loud-drop requirement is the guardrail.
- Feeding the LLM a machine-translated/non-English transcript (the #2345 regression).
- Storing the OAuth client secret or refresh token in source, GitHub secrets, or mtaext
  env — they go in the **BTP Credential Store** (Tom's standing preference).

## Constraints & decisions made

- **Auth:** `captions.download` requires OAuth as the **channel owner**; an API key is
  rejected. One refresh token, minted once as the SAP Developers channel owner, stored in
  **BTP credstore** alongside a client ID + client secret. Build mints short-lived access
  tokens via the `refresh_token` grant (server-to-server, no redirect URI).
- **Plain `YOUTUBE_API_KEY` reused** for `videos.list?part=snippet` (channel gate +
  description fallback) — it's already in credstore and used by `fetch-videos-job`.
- **Track selection (spike finding):** the uploaded track may be language `und`
  (undefined) while the real English content is on the **ASR** track — both #2800 videos
  are shaped this way. Selection MUST prefer by language (`en`/`en-*`) across *both* kinds,
  not prefer `standard` kind first. Tier label (uploaded vs auto) is derived from the
  chosen track's `trackKind`, independent of the language match.
- **Caption format (spike finding):** `tfmt=sbv` returns `H:MM:SS.mmm,H:MM:SS.mmm\ntext`
  lines. The build path needs an SBV-aware parse (strip timestamp lines) — the existing
  `parseTimedText` only handles srv3/timedtext XML. Alternatively request a format that is
  pure text; builder picks, but must produce clean transcript text fed to the LLM.
- **Channel gate:** resolve the video's `snippet.channelId` via `videos.list` and require
  it equal the SAP Developers channel id. Mismatch → loud rejection.
- **Fail-open vs loud:** the build must not *crash* on a bad video, but it must not
  *silently* ship an empty quiz. "Loud" = a clearly-greppable warning line AND a
  non-silent signal the rebuild workflow surfaces (exact mechanism — build-log marker the
  workflow greps, or a summary annotation — left to the plan; must be visible without
  reading full scrollback).
- **Secrets wiring:** credstore keys (proposed) `YOUTUBE_OAUTH_CLIENT_ID`,
  `YOUTUBE_OAUTH_CLIENT_SECRET`, `YOUTUBE_OAUTH_REFRESH_TOKEN`; resolved via the same
  `resolveSecret()` path `fetch-videos-job` uses. Rotatable via `/admin-ui/#secrets`.
- **Target:** PR to DEV. Secrets seeded in DEV credstore first; verify there before PROD.

## How it fits the existing pipeline

- New module (working name `srv/lib/youtube-official-transcript.js`) exporting a
  `fetchTranscript(videoId)` with the SAME return shape the build already consumes:
  `{ source, lang, segments: [{ start, text }] }`, extended `source` enum to include the
  description-fallback tier.
- The build (`scripts/fetch-tutorials.ts`) calls this module **in-process** on the CI
  runner, replacing the HTTP round-trip through the CF-blocked endpoint
  (`fetchTranscriptViaHttp`, wired at `fetch-tutorials.ts:1185`). It plugs into the
  existing injectable `deps.fetchTranscript` seam in `scripts/lib/expand-ai-authored.ts`
  (the current drop point is ~line 228: `transcript.source === 'none'`).
- The description-fallback and source-notice logic lives at that same seam: when the
  transcript tier is unavailable, substitute description text and tag the emitted quiz with
  the source tier; `expand-ai-authored.ts` already threads a `source: 'step' | 'video'`
  provenance concept to extend.

## What's left to the builder

- SBV parsing vs choosing a cleaner `tfmt` — builder's call, output must be clean
  `segments: [{ start, text }]`. Note: SBV carries line timestamps but not srv3-style
  per-cue structure; synthesize `start` from the `H:MM:SS.mmm` prefix or emit `start: 0`
  per line (the LLM only consumes joined text — `start` is not load-bearing here).
- The precise "loud" surfacing in `rebuild-content.yml` (greppable log marker the workflow
  greps into its step summary vs a GitHub step-summary annotation). Decision is
  warn-and-continue (above); builder picks the exact surface, must be visible without
  reading full scrollback.
- Exact placement of the two-tier source notice in the runtime quiz template and final copy
  polish (strings specified above).
- Test coverage: channel gate (accept/reject), tier resolution (uploaded/asr/description),
  SBV parse, loud-drop signal + workflow surfacing, two-tier source-notice provenance,
  token-refresh failure handling.

### Builder calls already settled (adopt as written)

- Credstore keys: `YOUTUBE_OAUTH_CLIENT_ID`, `YOUTUBE_OAUTH_CLIENT_SECRET`,
  `YOUTUBE_OAUTH_REFRESH_TOKEN`; resolved via `resolveSecret()` (pattern:
  `srv/jobs/fetch-videos-job.js:147`), env fallback on CI when no credstore binding.
- New module: `srv/lib/youtube-official-transcript.js`, imported in-process by
  `scripts/fetch-tutorials.ts` (which already imports `../srv/lib/*.js`), replacing
  `fetchTranscriptViaHttp`.
- Access token cached in-module for the build run (one refresh grant, reused ~1h).
- Keep the InnerTube module (`srv/lib/devtoberfest-transcript.js`) for the live endpoint;
  convergence is a later cleanup.
- Track selection reorders the existing `pickCaptionTrack` logic to prefer by language
  (`en`/`en-*`) across BOTH `standard` and `ASR` kinds before falling back; tier label is
  derived from the chosen track's `trackKind`.
