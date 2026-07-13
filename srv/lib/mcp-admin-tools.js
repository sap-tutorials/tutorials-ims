// srv/lib/mcp-admin-tools.js
// Phase 3 (#1106) — admin curation MCP tool handlers (WS2). Registered onto
// AdminService via this.on() in admin-service.js. Each handler DELEGATES to an
// existing action/entry point rather than reimplementing its logic, so the
// established auth gates, validation, and guard rails all still run.
//
// `this` is the AdminService when bound via this.on(). Test seams
// (`_connect`, `_schedule`, `_createContentHandlers`) let unit tests assert
// delegation without a live DB or GitHub dispatch.
import cds from '@sap/cds';
import { scheduleRebuild as realScheduleRebuild } from './rebuild-trigger.js';

const log = cds.log('mcp-admin');

/**
 * merge_concepts — delegate to KnowledgeGraphService.mergeConcepts.
 * KG.Admin-gated at the CDS layer; the KG action repoints links from the
 * loser concept onto the canonical one and retires the loser.
 */
export async function handleMergeConcepts(req) {
  const connect = req._connect ?? ((name) => cds.connect.to(name));
  const { loser, canonical } = req.data;
  const kg = await connect('KnowledgeGraphService');
  await kg.send('mergeConcepts', { loser, canonical });
  return { merged: true, loser, canonical };
}

/**
 * promote_community_to_mission — delegate to AdminService's OWN existing
 * promoteCommunityToMission action. These tools live ON AdminService, so
 * `this` is the service and we can invoke the sibling handler via this.send().
 * communityId is an Integer — passed through unchanged. Errors from the
 * underlying action (404 no members, etc.) propagate as MCP errors — an admin
 * needs to see why a promotion failed, so we deliberately do NOT swallow.
 */
export async function handlePromoteCommunity(req) {
  const { communityId, missionSlug, title } = req.data;
  return this.send('promoteCommunityToMission', { communityId, missionSlug, title });
}

/**
 * trigger_rebuild — preferred content path. Delegates to
 * scheduleRebuild(reason, {mode, slug}) which dispatches the CI-validated
 * rebuild-content.yml workflow. Auto-infers slug-targeted mode when a slug is
 * given and mode is omitted (matches rebuild-content.yml — see CLAUDE.md).
 */
export async function handleTriggerRebuild(req) {
  const schedule = req._schedule ?? realScheduleRebuild;
  const slug = req.data.slug ?? null;
  const mode = req.data.mode ?? (slug ? 'slug-targeted' : 'full');
  const who = req.user?.id ?? 'unknown';
  log.info(`trigger_rebuild by ${who} mode=${mode} slug=${slug ?? '-'}`);
  await schedule(`mcp:trigger_rebuild:${who}`, { mode, slug });
  return { scheduled: true, mode, slug };
}

/**
 * publish_content — EMERGENCY lever; prefer trigger_rebuild (CI-validated).
 * Reuses the DEPRECATED single-shot /content/publish entry point
 * (createContentHandlers().publishHandler) via a synthetic req/res.
 *
 * NOTE: this invokes the DEPRECATED single-shot publishHandler, which runs
 * files-validation, catalog-slug drop, size caps, publish lock, and
 * carry-forward — but NOT the #672 no-revert guard (that lives only in the
 * begin/append/commit session path in content-publish-session.js). This is an
 * emergency lever; trigger_rebuild (CI-validated) is the preferred path.
 * App-layer CONTENT_API_KEY auth is enforced explicitly below because the
 * synthetic-req invocation bypasses the Express contentAuthMiddleware.
 *
 * publishHandler expects `req.body.files[slug]` to be gzip-compressed,
 * base64-encoded HTML (it does `gunzipSync(Buffer.from(value, 'base64'))`).
 * The caller supplies that already-encoded string as req.data.html — the MCP
 * tool does not gzip on the caller's behalf; the emergency payload must match
 * what publish-content.ts would have sent for one slug.
 */
export async function handlePublishContent(req) {
  // Explicit app-layer gate: the Express contentAuthMiddleware is skipped by
  // the synthetic-req path, so we enforce the key presence here instead.
  // publishHandler itself does NOT read the auth header in the synthetic path.
  if (!process.env.CONTENT_API_KEY) {
    return req.reject(503, 'publish_content unavailable: CONTENT_API_KEY not configured');
  }

  const createContentHandlers = req._createContentHandlers
    ?? (await import('./content-store.js')).createContentHandlers;
  const { publishHandler } = createContentHandlers();

  const apiKey = process.env.CONTENT_API_KEY;
  const fakeReq = {
    body: {
      trigger: `mcp:publish_content:${req.user?.id ?? 'unknown'}`,
      files: { [req.data.slug]: req.data.html },
      metadata: {},
      bodyTexts: {},
      sources: {},
    },
    headers: {
      // Defense-in-depth: forward key in case a future refactor wires the
      // middleware; this header is NOT what gates the call (see check above).
      authorization: `Bearer ${apiKey}`,
      'x-initiator': `mcp:${req.user?.id ?? 'unknown'}`,
    },
    user: req.user,
  };

  let captured = { code: 200, body: undefined };
  const fakeRes = {
    _code: 200,
    status(c) { this._code = c; return this; },
    json(o) { captured = { code: this._code ?? 200, body: o }; return this; },
  };

  await publishHandler(fakeReq, fakeRes);

  if (captured.code >= 400) {
    return req.reject(captured.code, captured.body?.error ?? 'publish failed');
  }
  return { published: true, slug: req.data.slug };
}
