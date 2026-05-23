# VSCode Author Preview Endpoint — Design Spec

**Status:** Approved 2026-05-23

**Goal:** Add a stateless HTTP endpoint that the SAP Tutorials VSCode extension can call with raw tutorial markdown and receive a fully-rendered Object Page HTML document, suitable for display in a VSCode webview as the author types. Images stay relative so VSCode's webview can resolve them from the local disk.

---

## Background

Tutorial authors today edit markdown locally in VSCode and don't see a true rendering of their work until they push to a `*-Contribution` repo and trigger a QA rebuild. That round-trip is minutes long. The VSCode extension team wants an endpoint that turns markdown into HTML on demand, so the extension can offer a side-by-side WYSIWYG preview pane.

This work is the *server side* of that feature. The VSCode extension itself is out of scope (separate repo, separate work).

The QA channel work that just shipped (PR #38, merge `cee2a0e`) introduced `tutorials-srv-qa` — a CAP service gated by XSUAA scope `Tutorial.Author` that serves in-flight tutorial content from `*-Contribution` repos. This spec extends that service with one more route: `POST /preview/render`. Same auth scope, same target audience (authors), no schema impact.

## Confirmed decisions (Tom 2026-05-23)

1. **Render scope:** Full Object Page chrome, runtime widgets disabled. Header, breadcrumbs, side-nav, step-indicator, footer render. Joule FAB, search palette, lightbox-dialog, glossary popovers, toast container, scrollspy, reader-mode toggle, embedding-driven "what's next" rail are stubbed off.
2. **Host service:** `tutorials-srv-qa` (extend the existing QA service). Reuse the `Tutorial.Author` scope guard.
3. **Deploy scope:** BTP from day one, behind `Tutorial.Author`. No localhost-only phase.
4. **Render unit:** Whole tutorial page per request. No per-step mode.
5. **Payload:** `{ markdown: string }` only. No slug/repo/mission context. Frontmatter inside the markdown is the single source of truth.
6. **Error reporting:** Always 200, with an error HTML page that uses the same Object Page chrome and shows the diagnostic in the body.
7. **Render engine:** Hugo binary bundled with srv-qa; shell out per request against prod layouts via a thin `preview-site` Hugo project.

## Architecture

### Request contract

```
POST /preview/render
Authorization: Bearer <JWT with Tutorial.Author scope>
Content-Type: application/json
Body: { "markdown": "<full tutorial markdown, including frontmatter>" }
Limit: 1 MB
```

```
200 OK
Content-Type: text/html; charset=utf-8
Body: complete <!doctype html> document
```

Even on parse / Hugo failures the response is **200 with an error HTML page**. The only non-2xx codes are auth failures (401 missing/invalid JWT, 403 wrong scope, 503 XSUAA binding missing) and concurrency overflow (503 after 10s queue wait).

### Components

```
[VSCode extension]
       │ POST /preview/render { markdown }
       ▼
[srv-qa Express handler]                          srv-qa/server.js (extended)
       │ requireXsuaaScope('Tutorial.Author')     srv-qa/xsuaa-scope-middleware.js (reused)
       │ json body limit 1mb
       │ semaphore acquire
       ▼
[Preview renderer module]                         srv-qa/preview-renderer.js (NEW)
       │ 1. mkdtempSync(tmpdir/tut-preview-)
       │ 2. parsers/ pipeline { rewriteImages: false, skipCapFetch: true, skipGithubFetch: true }
       │ 3. write tmpdir/content/tutorials/__preview__/index.md
       │ 4. spawn hugo (timeout 5s)
       │ 5. read tmpdir/public/tutorials/__preview__/index.html
       │ 6. finally: rm -rf tmpdir
       ▼
[Hugo binary]                                     node_modules/.bin/hugo (bundled)
       │ --source preview-site/
       │ --contentDir <tmpdir>/content
       │ --destination <tmpdir>/public
       │ --quiet --logLevel error
       ▼
[Preview-site Hugo project]                       preview-site/ (NEW)
       │ hugo.toml: params.previewMode = true
       │ mounts hugo/layouts/ via Hugo modules
       │ chrome partials gate runtime widgets on .Site.Params.previewMode
```

### File-level changes

**Create:**

- `srv-qa/preview-renderer.js` — stateless renderer module. Exports `renderPreview(markdown): Promise<{ html: string, status: 'ok' | 'parse_error' | 'render_error', durationMs: number, bytes: number }>`. Owns tmp-dir lifecycle, Hugo invocation, parser pipeline orchestration, error→HTML mapping.
- `srv-qa/preview-semaphore.js` — small in-memory counting semaphore. `acquire(timeoutMs)` resolves on slot, rejects on timeout. 4 concurrent slots.
- `preview-site/hugo.toml` — Hugo project config for preview render. Sets `params.previewMode = true`, `security.exec.allow = ['^$']`, `security.funcs.getenv.allow = ['^HUGO_']`. Mounts `../hugo/layouts/` via Hugo modules so all prod layouts apply.
- `preview-site/layouts/_default/preview-error.html` — error layout that wraps a `<ui5-message-strip design="Negative">` in the standard `baseof.html` chrome.
- `test/srv-qa/preview-renderer.test.js` — unit tests. Mocks Hugo binary via stub script.
- `test/srv-qa/preview-semaphore.test.js` — unit tests for semaphore.

**Modify:**

- `srv-qa/server.js` — register `POST /preview/render`. Reuses `requireXsuaaScope('Tutorial.Author')`. Wires `express.json({ limit: '1mb' })` to this route only. Calls `renderPreview()` and writes response.
- `srv-qa/package.json` — add `hugo-bin` (or equivalent npm package that bundles the Hugo binary) to `dependencies`. Add `"type": "module"` (resolves the existing benign vitest warning, see [feedback-module-singletons-in-vitest-cds]).
- `scripts/parsers/images.ts` — accept a `rewriteImages: boolean` option (default `true` to preserve existing behavior). When `false`, leave `./images/x.png` paths unchanged.
- `scripts/parsers/v1.ts` and `v2.ts` (or whichever entry point composes the pipeline) — accept a `skipCapFetch: boolean` and `skipGithubFetch: boolean`, propagate to the relevant passes. Defaults preserve existing behavior.
- `hugo/layouts/partials/joule-step-help.html`, `joule-panel.html`, `joule-starters.html`, `joule-icon.html`, `lightbox-dialog.html`, `nav-progress.html` — wrap the runtime widget bodies in `{{ if not site.Params.previewMode }}…{{ end }}` so the chrome silently omits them when previewMode is on. Static-only partials (`header.html`, `breadcrumbs.html`, `footer.html`, `tutorial-meta.html`, `tutorial-sidebar.html`, `tutorial-prerequisites.html`, `tutorial-author.html`, `tutorial-contributors.html`) are untouched.
- `hugo/layouts/_default/baseof.html` — same `previewMode` gate around any inline `<script>` tags that wire up reader-mode toggle, scrollspy, search-palette `⌘K` shortcut, glossary popover bindings, embedding-rail fetch.
- `hugo/layouts/tutorials/u1-object-page.html` — gate the `next-steps.html` and embedding-derived "what's next" rail on `previewMode`.
- `.deploy/mta.yaml` — `tutorials-srv-qa` module `path: ../gen/srv-qa`: ensure `cds build` includes `preview-site/` and `hugo/layouts/` (or symlinked equivalents) in `gen/srv-qa/` so the runtime Hugo invocation can find them. Bump `memory` from 512 → 768 MB; `disk-quota` stays 1024 MB. Existing `requires: tutorials-xsuaa` covers JWT validation.
- `test/smoke/qa-routes.test.ts` — add the four `/preview/render` smoke cases described in the Testing section.

### Data flow per request (happy path)

1. Express receives `POST /preview/render`. JWT validated by `requireXsuaaScope('Tutorial.Author')`. Body parsed with 1 MB limit.
2. Handler calls `await previewSemaphore.acquire(10_000)`. If 4 renders in flight + queue full or 10s elapsed → 503 "Preview server busy."
3. Handler calls `renderPreview(req.body.markdown)`.
4. Renderer creates `tmpdir = mkdtempSync(os.tmpdir() + '/tut-preview-')`.
5. Renderer runs the parser pipeline with `{ rewriteImages: false, skipCapFetch: true, skipGithubFetch: true }`. Output is a Hugo-frontmatter markdown file.
6. Renderer writes `tmpdir/content/tutorials/__preview__/index.md`.
7. Renderer spawns Hugo: `node_modules/.bin/hugo --source preview-site --contentDir tmpdir/content --destination tmpdir/public --quiet --logLevel error`. Captures stdout/stderr. 5s `setTimeout` → SIGKILL on overrun.
8. On Hugo exit code 0: read `tmpdir/public/tutorials/__preview__/index.html`. Return `{ html, status: 'ok' }`.
9. `finally`: `rm -rf tmpdir`. Always runs.
10. Handler logs `{ event: 'preview.render', status: 'ok', ms, bytes }`. Writes 200 + HTML.

### Data flow per request (failure paths)

| Failure | Detection | Response |
|---|---|---|
| Empty body | Renderer entry guard | 200 + error HTML "Markdown payload is empty." |
| > 1 MB body | Express body-parser | 413 (handled by Express; not custom) |
| Frontmatter YAML invalid | gray-matter throws | 200 + error HTML with YAML message + line excerpt |
| Parser pipeline exception | try/catch in renderer | 200 + error HTML with exception message + first 3 stack frames |
| Hugo non-zero exit | Renderer reads exit code | 200 + error HTML with last 40 lines of stderr |
| Hugo timeout (5s) | setTimeout + SIGKILL | 200 + error HTML "Render timed out." |
| Auth failures | requireXsuaaScope | 401 / 403 / 503 (existing middleware) |
| Concurrency overflow | Semaphore.acquire timeout | 503 + JSON `{ error: 'busy' }` |

The error HTML layout is `preview-site/layouts/_default/preview-error.html`. It uses `baseof.html` chrome so the webview shows the same shell, just with the error in the body.

### Why these abstractions

- `preview-renderer.js` owns one job: turn markdown into HTML or an error page. No Express, no auth, no semaphore — those live in `server.js`. Easy to test in isolation by mocking the Hugo binary.
- `preview-semaphore.js` is its own module so we can test it directly (acquire/release/timeout) without spinning up Hugo.
- `preview-site/` is a separate Hugo project, not a flag on the prod build, because Hugo's config-per-site model maps cleanly to "this is a different render mode" and the tutorial content tree stays empty for this project (content comes from the tmp dir at request time).
- The `previewMode` gate on chrome partials is the *one* place layouts know about preview. Adding a new runtime widget in the future means adding one `{{ if not site.Params.previewMode }}` guard — that's the only ongoing maintenance cost.

## Security

- **No DB access** during preview render. No HANA reads, no writes.
- **No external HTTP calls.** Parser pipeline's `cap.ts` (CAP catalog) and `github.ts` (commit metadata, rules.vr) are bypassed via the new `skipCapFetch`/`skipGithubFetch` flags.
- **Hugo `--safe`-equivalent config** in `preview-site/hugo.toml`: `security.exec.allow = ['^$']` blocks shortcode shell-out; `security.funcs.getenv.allow = ['^HUGO_']` blocks env-var leakage.
- **Tmp-dir isolation:** each request gets a unique `mkdtempSync` directory; cleanup in `finally`. Startup sweep removes any orphaned `tut-preview-*` dirs older than 1 hour.
- **Payload cap:** `express.json({ limit: '1mb' })` on this route only.
- **No markdown body in logs.** Structured log line per request omits content. Author-private text never reaches log aggregation.
- **Image rewriting is OFF.** Author-supplied paths like `./images/x.png` pass through unchanged. The VSCode webview is responsible for resolving them via `webview.asWebviewUri`. Server never fetches author images.

## Testing strategy

### Unit tests (`unit` vitest project)

`test/srv-qa/preview-renderer.test.js`:
- Parser pipeline invoked with `{ rewriteImages: false }`: `./images/foo.png` survives unchanged in output markdown.
- Synthetic slug `__preview__` is consistent across calls.
- Frontmatter defaults applied when fields missing; no GitHub or CAP fetches occur (mock `globalThis.fetch`; assert zero calls).
- Malformed YAML frontmatter → returned `html` starts with `<!doctype html>` and contains the YAML error message.
- Hugo stub script (in `test/fixtures/hugo-stub.sh` or a Node script chmod +x) returns exit code 0 with a sentinel file → renderer returns its content as `html`.
- Hugo stub that exits non-zero → renderer returns error HTML containing stub stderr.
- Hugo stub that sleeps forever → renderer rejects/returns timeout error within 5s + small slack.
- Tmp-dir cleanup: `fs.existsSync(tmpDir)` is `false` after both happy and error paths.

`test/srv-qa/preview-semaphore.test.js`:
- 4 concurrent acquires succeed; 5th waits.
- Acquire with timeout 100ms throws if no slot freed within 100ms.
- Release frees a waiting acquire.

### Hybrid-qa tests
None. Preview is stateless; existing `hybrid-qa` project does not apply.

### Smoke tests (`smoke` vitest project, gated on `SRV_URL_QA` + `SMOKE_QA_TOKEN`)

Add to `test/smoke/qa-routes.test.ts`:
- `POST /preview/render` with no Authorization header → 401.
- `POST /preview/render` with bearer token but the smoke test deliberately strips scope (or with `SMOKE_QA_TOKEN_NOSCOPE` if available) → 403. If a non-author token is not available in CI secrets, document this gap in the test file.
- `POST /preview/render` with author token + valid markdown payload → 200, `Content-Type: text/html`, body contains `<title>` and a known step heading from the input.
- `POST /preview/render` with author token + markdown that has malformed YAML frontmatter (e.g. unclosed quote) → 200, body contains the YAML error string.

### a11y tests
None for v1. Preview reuses prod layouts which already have a11y coverage.

## Operational concerns

- **Memory:** Hugo invocation peaks ~80–150 MB. With semaphore limit 4 → ~600 MB worst case. 768 MB module quota leaves ~150 MB for Node runtime baseline. Comfortable.
- **Slug bloat:** `hugo-bin` adds ~50 MB to the deployed slug. Acceptable. Verify final size after `cds build` in plan stage.
- **Logging:** structured log per request `{ event: 'preview.render', status, ms, bytes, error? }`. Goes to standard CF stdout; visible via `cf logs tutorials-srv-qa --recent`. Not added to the `cfLogsUrl` plumbing in v1; revisit if the endpoint becomes flaky.
- **Concurrency:** 1 instance × 4 concurrent renders × ~500ms = ~8 req/s sustained, ~16 req/s burst (queue absorbs). Single-author edit-debounce traffic is well under this. If multiple authors hammer it, scale horizontally by bumping `instances` in mta.yaml — the renderer is stateless.
- **Hugo version pinning:** `hugo-bin` version pinned in `package.json` to match the version used in CI for prod/QA builds. Drift between preview Hugo and prod Hugo is a class of subtle bug we want to prevent. Document the alignment requirement in the package.json and in this spec.

## Rollout

1. Land code on a feature branch (`feature/vscode-author-preview`). Subagent reviews per [project-pr-over-direct-merge].
2. PR to main; CI deploy refreshes `tutorials-srv-qa` with the new endpoint and bundled Hugo binary.
3. Smoke tests run automatically post-deploy via `qa-routes.test.ts` covering all four cases above.
4. Tom assigns the `Tutorial Author` role collection to the first author (already in QA bootstrap step list — same scope reused).
5. VSCode extension team starts calling the live srv-qa URL. Their work is downstream of this PR; not in scope here.

## Out of scope (deferred follow-ups)

- **F-1: Sibling files in payload.** VSCode webview resolves local images via `webview.asWebviewUri`; server doesn't need them. Revisit if authors ask for bundled-uploads support.
- **F-2: Caching by content hash.** Rebuild every request. Add an in-memory LRU keyed by `sha256(markdown)` only if real-world latency hurts.
- **F-3: Per-step preview mode.** Whole-page only for v1. Revisit if the extension UI needs it.
- **F-4: Streaming response.** Hugo finishes <1s; chunked transfer not needed.
- **F-5: WebSocket live-reload push.** v1 is request/response. The extension can debounce and re-call.
- **F-6: VSCode extension itself.** Out of scope of this spec — separate work in a separate repo.
- **F-7: Public (non-Author) preview link.** Not asked. Auth is `Tutorial.Author` only.

## Related memories / prior work

- [project-qa-channel-not-yet-merged] — preceding QA channel work; this spec extends `tutorials-srv-qa`.
- [feedback-module-singletons-in-vitest-cds] — `srv-qa/package.json` adding `"type": "module"` resolves the open warning while we're in there.
- [feedback-pr-over-direct-merge] — default to `gh pr create` from feature branch; subagent review ≠ PR review.
- [project-tutorial-meta-auto-init] — preview deliberately *bypasses* metadata writes; only ContentFiles/Manifest/BodyText are written by srv-qa, and preview writes none of them.
- [feedback-publish-content-force] — unrelated to preview (preview never publishes), noted because authors using preview are the same audience as those running `publish-content:qa`.

## Acceptance criteria

- `POST /preview/render` exists on `tutorials-srv-qa`, gated by `Tutorial.Author` scope.
- Given any well-formed tutorial markdown, the endpoint returns `200 text/html` with a complete Object Page document where header / breadcrumbs / side-nav / step-indicator / footer all render and runtime widgets (Joule FAB, search palette, lightbox, glossary popovers, toast container, scrollspy, reader mode toggle, "what's next" rail) are absent from the DOM.
- `./images/x.png` paths in author markdown survive unchanged in the response HTML.
- Malformed frontmatter → 200 with an error HTML page that uses Object Page chrome and shows the YAML error.
- Missing JWT → 401. Wrong scope → 403. XSUAA binding missing → 503.
- All unit tests in `test/srv-qa/preview-*.test.js` pass.
- All four smoke test cases in `qa-routes.test.ts` pass against the deployed URL.
- No DB access during render (verified by code inspection in PR review).
- No outbound HTTP calls during render (verified by mocked-fetch unit test).
