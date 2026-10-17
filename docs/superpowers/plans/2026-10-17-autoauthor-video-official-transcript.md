# Official-API Video Transcripts for AUTOAUTHOR_VIDEO — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fetch AUTOAUTHOR_VIDEO transcripts via the official YouTube Data API v3 (OAuth, SAP Developers channel only) so quizzes stop silently dropping in CF/CI builds (#2800).

**Architecture:** A new in-process build-time fetcher (`srv/lib/youtube-official-transcript.js`) mints a short-lived access token from a credstore refresh token, gates on the SAP Developers channelId, resolves transcript text in three tiers (uploaded captions → ASR captions → video description), and returns the existing `{ source, segments }` shape (widened with a `'description'` source). `scripts/fetch-tutorials.ts` imports it in-process, replacing the CF-egress-blocked HTTP round-trip. The `expand-ai-authored.ts` seam gains a two-tier learner notice and a loud-drop signal.

**Tech Stack:** Node 26 native `fetch`; YouTube Data API v3 (`videos.list`, `captions.list`, `captions.download`); OAuth 2.0 refresh-token grant; BTP Credential Store via `resolveSecret`; Vitest.

**Spec:** `docs/superpowers/specs/2026-10-17-autoauthor-video-official-transcript-design.md`

## Global Constraints

- Node.js 22+ (project baseline); native `fetch`, no HTTP-client dependency.
- Secrets ONLY from BTP credstore via `resolveSecret(alias, { logTag })` with an injectable test override — NEVER in source, GitHub secrets, or mtaext env.
- Credstore aliases (verbatim): `YOUTUBE_OAUTH_CLIENT_ID`, `YOUTUBE_OAUTH_CLIENT_SECRET`, `YOUTUBE_OAUTH_REFRESH_TOKEN`; reuse existing `YOUTUBE_API_KEY` for `videos.list`.
- SAP Developers channelId (verbatim): `UCNfmelKDrvRmjYwSi9yvrMg` (overridable via `SAP_DEV_CHANNEL_ID` env for test/robustness).
- Learner-facing notice copy (verbatim, two tiers only):
  - captions (uploaded OR asr): `Questions generated from the video's captions`
  - description fallback: `Questions generated from the video description`
- Description-fallback length bar: reuse `MIN_SUBSTANTIVE_WORDS = 50`.
- Empty-quiz behavior: warn-loud-and-continue (greppable marker + rebuild-workflow surfacing); the build MUST NOT crash and MUST NOT silently ship an empty quiz.
- `captions.download` is owner-OAuth-only; API key is rejected there (do not attempt key auth on that endpoint).
- Return shape consumed by the build: `{ source: 'uploaded'|'auto'|'description'|'none', segments: Array<{start:number,text:string}> }`.
- Target branch: DEV (PR). Do not deploy a feature branch.

## Review Focus

- **Refresh-token expiry / revocation mid-build** — `captions.download` 401 after a previously-valid token: the fetcher must surface a clear error and the build must warn-loud, not crash or silently drop. (Task 1 tests token-refresh failure.)
- **Non-SAP-Developers channel URL** — a directive pointing off-channel must be *rejected loudly*, not silently dropped, and must not fall through to the description tier of a foreign video. (Task 2 tests the gate.)
- **`und`-standard + `en`-asr track shape** (both #2800 videos) — language-first selection across both kinds, else the real English ASR track is missed. (Task 3 tests this exact shape.)
- **SBV body with no usable segments** (caption track exists but downloads empty/garbled) — must fall through to description, not emit an empty transcript. (Task 3 tests empty-download → next tier.)
- **Description present but under 50 substantive words** — loud drop, not a thin low-quality quiz. (Task 5 tests the threshold reuse.)

---

<!-- TASKS -->

### Task 1: OAuth token minting + official-API client core

**Files:**
- Create: `srv/lib/youtube-official-transcript.js`
- Test: `test/unit/youtube-official-transcript.test.js`

**Interfaces:**
- Consumes: `resolveSecret(alias, { logTag })` from `srv/lib/secret-resolver.js`.
- Produces:
  - `getAccessToken(deps?)` → `Promise<string>`. `deps` optional test seam:
    `{ clientId, clientSecret, refreshToken }`; when absent, resolves the three
    `YOUTUBE_OAUTH_*` credstore aliases. Caches the token in-module for the process
    lifetime (one refresh grant, reused ~1h); throws on non-ok token response.
  - `_resetTokenCache()` — test-only cache reset.

- [ ] **Step 1: Write failing tests**

```js
// token exchange posts refresh_token grant, returns access_token
test('getAccessToken exchanges refresh token for access token', async () => {
  const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ access_token: 'AT', expires_in: 3600 }) }))
  const tok = await getAccessToken({ clientId: 'c', clientSecret: 's', refreshToken: 'r', fetchImpl: fetchMock })
  expect(tok).toBe('AT')
  const body = fetchMock.mock.calls[0][1].body
  expect(body).toContain('grant_type=refresh_token')
})
// caches: second call does not re-fetch
test('getAccessToken caches within process', async () => { /* 2 calls, fetch called once */ })
// loud failure on bad refresh token
test('getAccessToken throws on non-ok token response', async () => { /* ok:false -> rejects */ })
```

- [ ] **Step 2: Run tests, verify they fail** — `npx vitest run test/unit/youtube-official-transcript.test.js` → FAIL (module/export missing).
- [ ] **Step 3: Implement `getAccessToken` + `_resetTokenCache`** in `srv/lib/youtube-official-transcript.js`. POST `https://oauth2.googleapis.com/token` with `grant_type=refresh_token`, `client_id`, `client_secret`, `refresh_token` as urlencoded body (native `fetch`, injectable `fetchImpl` default `globalThis.fetch`). Credstore path mirrors `fetch-videos-job.js:146-153`.
- [ ] **Step 4: Run tests, verify pass.**
- [ ] **Step 5: Commit** — `git add srv/lib/youtube-official-transcript.js test/unit/youtube-official-transcript.test.js && git commit -m "feat(#2800): YouTube OAuth token minting for official transcript API"`

---

### Task 2: Channel gate + video snippet (description source)

**Files:**
- Modify: `srv/lib/youtube-official-transcript.js`
- Test: `test/unit/youtube-official-transcript.test.js`

**Interfaces:**
- Consumes: `YOUTUBE_API_KEY` via `resolveSecret` (or `deps.apiKey` test seam); `SAP_DEV_CHANNEL_ID` env default `UCNfmelKDrvRmjYwSi9yvrMg`.
- Produces: `getVideoSnippet(videoId, deps?)` → `Promise<{ channelId, title, description }|null>`;
  `isSapDevelopersChannel(channelId)` → `boolean`.

- [ ] **Step 1: Write failing tests** — `getVideoSnippet` parses `items[0].snippet` (channelId/title/description); returns `null` when `items` empty; `isSapDevelopersChannel` true only for the constant / `SAP_DEV_CHANNEL_ID`.
- [ ] **Step 2: Run, verify fail.**
- [ ] **Step 3: Implement** `getVideoSnippet` (`GET videos?part=snippet&id=&key=`) and `isSapDevelopersChannel`.
- [ ] **Step 4: Run, verify pass.**
- [ ] **Step 5: Commit** — `feat(#2800): channel gate + video snippet fetch`

---

### Task 3: Caption listing, track selection, download + parse

**Files:**
- Modify: `srv/lib/youtube-official-transcript.js`
- Test: `test/unit/youtube-official-transcript.test.js`

**Interfaces:**
- Consumes: `getAccessToken` (Task 1).
- Produces:
  - `listCaptions(videoId, accessToken, deps?)` → `Promise<Array<{id, language, trackKind}>>`.
  - `pickCaptionTrack(tracks)` → chosen track or `null`. **Language-first across BOTH kinds:**
    prefer `language === 'en'`, then `startsWith('en-')`, across `standard` AND `ASR`; else
    first track. (Do NOT prefer `standard` kind first — #2800 videos are `und`-standard + `en`-asr.)
  - `downloadCaption(captionId, accessToken, deps?)` → `Promise<string>` (SBV text).
  - `parseSbv(text)` → `Array<{start:number, text:string}>` — strips `H:MM:SS.mmm,H:MM:SS.mmm` timestamp lines, keeps text; synthesizes `start` from the line's first timestamp (seconds), else 0.

- [ ] **Step 1: Write failing tests:**

```js
test('pickCaptionTrack prefers en across kinds (und-standard + en-asr)', () => {
  const tracks = [{language:'und',trackKind:'standard',id:'u'},{language:'en',trackKind:'ASR',id:'e'}]
  expect(pickCaptionTrack(tracks).id).toBe('e')
})
test('parseSbv strips timestamps and keeps text', () => {
  const sbv = '0:00:01.680,0:00:05.440\nHello there\n\n0:00:05.440,0:00:09.599\nwelcome'
  expect(parseSbv(sbv)).toEqual([{start:1.68,text:'Hello there'},{start:5.44,text:'welcome'}])
})
test('parseSbv returns [] on empty/garbled', () => { expect(parseSbv('')).toEqual([]) })
```

- [ ] **Step 2: Run, verify fail.**
- [ ] **Step 3: Implement** the four functions. `listCaptions`/`downloadCaption` use `authorization: Bearer <token>` header; `downloadCaption` requests `tfmt=sbv`.
- [ ] **Step 4: Run, verify pass.**
- [ ] **Step 5: Commit** — `feat(#2800): caption list/select/download + SBV parse`

---

### Task 4: Three-tier `fetchTranscript` orchestrator

**Files:**
- Modify: `srv/lib/youtube-official-transcript.js`
- Test: `test/unit/youtube-official-transcript.test.js`

**Interfaces:**
- Consumes: Tasks 1–3.
- Produces: `fetchTranscript(videoId, deps?)` → `Promise<{ source:'uploaded'|'auto'|'description'|'none', segments:Array<{start,text}> }>`.
  Order: (a) snippet + channel gate — off-channel → throw a labeled error (loud reject, caught by the seam in Task 5, NOT silently `'none'`); (b) list+pick+download+parse a caption track → `source` = `'uploaded'` (trackKind standard) or `'auto'` (ASR) when segments non-empty; (c) else description from snippet → one segment `{start:0,text:description}`, `source:'description'`; (d) else `{source:'none',segments:[]}`.

- [ ] **Step 1: Write failing tests** — uploaded→`uploaded`; und-standard+en-asr→`auto`; no captions but description→`description`; neither→`none`; off-channel video→throws labeled error. (Inject Task 1–3 fns via `deps`.)
- [ ] **Step 2: Run, verify fail.**
- [ ] **Step 3: Implement** `fetchTranscript` composing the tiers.
- [ ] **Step 4: Run, verify pass.**
- [ ] **Step 5: Commit** — `feat(#2800): three-tier official transcript orchestrator`

---

### Task 5: Wire into build + widen seam + loud drop + source discriminator

**Files:**
- Modify: `scripts/fetch-tutorials.ts:706-726` (replace `fetchTranscriptViaHttp` impl) and `:1185` (wiring stays).
- Modify: `scripts/lib/expand-ai-authored.ts:20-23` (widen `TranscriptFetcher.source` to include `'description'`), `:228-239` (description no longer a drop; stamp per-step `questionSource`), and the per-step emit so a `questionSource: 'captions'|'description'` discriminator is carried out.
- Test: `test/unit/youtube-fetcher.test.js` sibling or extend `scripts/__tests__/expand-ai-authored.test.ts`.

**Interfaces:**
- Consumes: `fetchTranscript` (Task 4), imported in-process in `fetch-tutorials.ts` (it already imports `../srv/lib/*.js`).
- Produces: expander stamps each emitted AUTOAUTHOR_VIDEO step with `questionSource`: `'captions'` when `transcript.source` ∈ {uploaded,auto}, `'description'` when `'description'`. `'none'` → loud warn (greppable `[ai-author][EMPTY-QUIZ]` marker) + drop, build continues.

- [ ] **Step 1: Write failing tests** — (a) `source:'description'` no longer drops, generates, stamps `questionSource:'description'`; (b) `source:'uploaded'|'auto'` stamps `'captions'`; (c) `source:'none'` emits the `[ai-author][EMPTY-QUIZ]` marker and drops; (d) description under 50 substantive words → drop (reuses existing `MIN_SUBSTANTIVE_WORDS` guard at `expand-ai-authored.ts:247`).
- [ ] **Step 2: Run, verify fail.**
- [ ] **Step 3: Implement** — replace `fetchTranscriptViaHttp` body with an in-process call to Task 4's `fetchTranscript`; widen the `TranscriptFetcher` type; change the `source === 'none'` branch so only `'none'` drops (description flows through to generation); add the `[ai-author][EMPTY-QUIZ]` marker; thread `questionSource` to the per-step object written at `fetch-tutorials.ts:1218`.
- [ ] **Step 4: Run, verify pass** + `npx vitest run scripts/__tests__/expand-ai-authored.test.ts`.
- [ ] **Step 5: Commit** — `feat(#2800): build uses official transcript API in-process + loud drop + source tag`

---

### Task 6: Learner-facing source notice in the quiz island

**Files:**
- Modify: `hugo-apps/src/validation/main.ts:9-12` (`StepData` += `questionSource?`), `:44-56` (read + pass prop), `hugo-apps/src/validation/Validation.vue:14-23` (Props), `:697` (render notice after `</form>`).
- Test: `hugo-apps/src/validation/Validation.*.test.ts` (sibling to existing validation island tests).

**Interfaces:**
- Consumes: per-step `questionSource: 'captions'|'description'` from frontmatter JSON (Task 5).
- Produces: rendered `<p class="validation-source-notice">` with the verbatim Global-Constraints copy; absent when `questionSource` is undefined (hand-authored / non-video quizzes show nothing).

- [ ] **Step 1: Write failing test** — mounting `Validation` with `questionSource:'captions'` renders "Questions generated from the video's captions"; `'description'` renders the description copy; omitted → no `.validation-source-notice` node.
- [ ] **Step 2: Run, verify fail** — `npx vitest run hugo-apps/src/validation/`.
- [ ] **Step 3: Implement** — add `questionSource` to `StepData`, read at main.ts:44-56, pass as prop, declare in `Props`, render the `<p>` after `</form>` at Validation.vue:697 with a `v-if="questionSource"` and a two-branch label.
- [ ] **Step 4: Run, verify pass.**
- [ ] **Step 5: Commit** — `feat(#2800): two-tier source notice under video quizzes`

---

### Task 7: Credstore secret seeding docs + rebuild-workflow loud surfacing

**Files:**
- Modify: `.github/workflows/rebuild-content.yml` (surface the `[ai-author][EMPTY-QUIZ]` marker into the step summary).
- Modify: `docs/developers/operations/secrets-tracking.md` (document the three new `YOUTUBE_OAUTH_*` credstore aliases + how to mint/rotate via `/admin-ui/#secrets`).
- Test: none (docs + workflow YAML); verified by Task 5's marker test + a `grep` assertion if a workflow-lint test exists.

**Interfaces:**
- Consumes: the `[ai-author][EMPTY-QUIZ]` marker (Task 5).
- Produces: a rebuild step-summary line when any AUTOAUTHOR_VIDEO quiz dropped.

- [ ] **Step 1:** Add a workflow step that greps the build log for `[ai-author][EMPTY-QUIZ]` and appends matches to `$GITHUB_STEP_SUMMARY` (non-failing).
- [ ] **Step 2:** Document the three credstore aliases + rotation path in `secrets-tracking.md`, referencing the design doc.
- [ ] **Step 3: Commit** — `chore(#2800): surface empty-quiz drops in rebuild summary + document OAuth secrets`

---

## Self-Review

**1. Spec coverage:** official-API fetch (T1–4); channel gate (T2/T4); three tiers incl. ASR accept + description fallback (T4/T5); two-tier notice (T6); loud-drop warn+continue (T5/T7); credstore secrets (T1/T7); 50-word bar reuse (T5). All spec sections mapped.

**2. Step scan:** each code step carries a signature or exact edit site; test steps carry assertions with verbatim spec values (channel id, notice copy, SBV example). No "handle edge cases" lines.

**3. Type consistency:** `fetchTranscript` return `source` enum is `'uploaded'|'auto'|'description'|'none'` in T4 and the widened `TranscriptFetcher` in T5; `questionSource` is `'captions'|'description'` consistently T5→T6. Token/snippet/caption fn names match across tasks.

**4. Review Focus:** token expiry (T1), off-channel (T2/T4), und-standard+en-asr (T3), empty download → next tier (T3/T4), sub-50-word description (T5) — each has an owning test.

**5. Proportion:** plan is task-shaped (signatures + test names + edit sites), not a code transcript; code blocks only where assertions pin exact values.

