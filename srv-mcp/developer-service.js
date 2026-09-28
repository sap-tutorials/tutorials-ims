// srv-mcp/developer-service.js
//
// Thin handler for the authenticated MCP module.
//
// 5 READ tools: run locally via @tutorials/mcp handlers (self-contained SELECTs
// on shared HANA).
//
// 2 WRITE tools (complete_step, reset_tutorial_progress): forward to the deployed
// main tutorials-srv via the MainDeveloperService remote binding (Option A).
// Best-effort: if the remote service is unreachable, returns 503 gracefully;
// never crashes the srv-mcp process.
//
// Write-forward trust model (#1105 C1):
//   1. srv-mcp reads the developer's SAP ID from THEIR MCP token via resolveUserSapId.
//   2. srv-mcp calls main-srv with a CC token (from tutorials-xsuaa) + actingSapId.
//   3. main-srv accepts actingSapId ONLY on completeStepFor/resetTutorialProgressFor
//      actions gated by the InternalWrite scope (CC-only, never a browser user).
//   → Per-developer attribution is preserved; no IDOR.
//
// ⚠ STEP F BLOCKED: the CC token source (tutorials-xsuaa binding on srv-mcp) is not
// yet wired because CAP Node.js has no documented equivalent of Java's
// `cds.security.xsuaa.binding` to pin which of two bound XSUAA instances validates
// inbound tokens. Binding both tutorials-xsuaa-mcp (inbound validation) AND
// tutorials-xsuaa (outbound CC) risks CAP picking the wrong one for inbound auth.
// Until this is resolved (credstore-stored CC creds or a Node binding selector), the
// write-forward path cannot be deployed — see task-18-report.md §Step F.
//
// Remote binding: cds.requires.MainDeveloperService.credentials.url must be set to
// the main tutorials-srv /api OData base URL (MAIN_DEVELOPER_SERVICE_URL env var).
//
// (#1105 Task 18 — srv-mcp C1 write-forward trust model)

import cds from '@sap/cds';

import {
  handleGetMyTutorials,
  handleGetMyMissions,
  handleGetMyEvents,
  handleGetMyCompletedSteps,
  handleGetTutorialStep,
} from './lib/mcp-developer-tools.js';

// Workspace-first shim for resolveUserSapId — mirrors srv/lib/resolve-db-user.js.
// In local dev, resolves from the @tutorials/core workspace package;
// at CF deploy time, falls back to the bundled core.bundle.mjs.
// Do NOT import from both sources (split-module-state).
let resolveUserSapId;
try {
  ({ resolveUserSapId } = await import('@tutorials/core/resolve-db-user.js'));
} catch {
  ({ resolveUserSapId } = await import('./lib/_shared/core.bundle.mjs'));
}

const LOG = cds.log('srv-mcp');

export default class McpDeveloperService extends cds.ApplicationService {

  async init() {
    // --- 5 READ tools — local SELECTs via @tutorials/mcp handlers ---

    this.on('get_my_tutorials',        handleGetMyTutorials);
    this.on('get_my_missions',         handleGetMyMissions);
    this.on('get_my_events',           handleGetMyEvents);
    this.on('get_my_completed_steps',  handleGetMyCompletedSteps);
    this.on('get_tutorial_step',       handleGetTutorialStep);

    // --- 2 WRITE tools — forward to main tutorials-srv via remote binding ---

    this.on('complete_step', async (req) => {
      const actingSapId = resolveUserSapId(req.user);
      if (!actingSapId || actingSapId === 'anonymous') {
        return req.reject(401, 'Unauthenticated — cannot resolve developer SAP ID from MCP token');
      }
      return forwardWriteToMainSrv('completeStepFor', {
        actingSapId,
        slug: req.data.slug,
        stepNumber: req.data.stepNumber,
      }, req);
    });

    this.on('reset_tutorial_progress', async (req) => {
      const actingSapId = resolveUserSapId(req.user);
      if (!actingSapId || actingSapId === 'anonymous') {
        return req.reject(401, 'Unauthenticated — cannot resolve developer SAP ID from MCP token');
      }
      return forwardWriteToMainSrv('resetTutorialProgressFor', {
        actingSapId,
        slug: req.data.slug,
      }, req);
    });

    await super.init();
  }
}

/**
 * Forward a write action to the deployed main tutorials-srv via the
 * MainDeveloperService remote binding. Uses the `completeStepFor` /
 * `resetTutorialProgressFor` actions which are gated by the InternalWrite scope
 * and accept an explicit `actingSapId` for per-developer attribution.
 *
 * Best-effort: wraps the remote connect/send in try/catch; if the remote service
 * is unreachable (connection refused, ETIMEDOUT, network partition) the handler
 * returns a graceful 503 rather than letting an unhandled error propagate.
 *
 * @param {string} event   - The *For action name on MainDeveloperService
 *   (e.g. 'completeStepFor', 'resetTutorialProgressFor').
 * @param {object} payload - Action payload including actingSapId.
 * @param {object} req     - CAP request object (provides req.reject).
 *
 * NOTE: mainSrv.send(event, payload) is the correct OData-V4 remote action call.
 * The old pattern mainSrv.send({event, data, user}) is incorrect — `user` is not
 * a supported key and CAP ignores it. The actingSapId travels in the action payload.
 *
 * ⚠ CC auth PENDING (Step F blocked): until tutorials-xsuaa is safely bindable to
 * srv-mcp without breaking inbound-auth binding selection, the outbound call will
 * arrive at main-srv with whatever token CAP attaches. In production this will fail
 * the InternalWrite scope check until Step F is resolved.
 */
async function forwardWriteToMainSrv(event, payload, req) {
  try {
    const mainSrv = await cds.connect.to('MainDeveloperService');
    const result = await mainSrv.send(event, payload);
    return result;
  } catch (err) {
    LOG.warn(`[srv-mcp] forward to main-srv failed (${event}):`, err.message ?? err);
    return req.reject(503, 'progress service temporarily unavailable');
  }
}
