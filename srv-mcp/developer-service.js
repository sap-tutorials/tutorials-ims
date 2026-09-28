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
// Remote binding stub — T12 deploy config must set:
//   cds.requires.MainDeveloperService.credentials.url =
//     https://<tutorials-srv-hostname>/api
// (In BTP CF, wire via Destination Service or mtaext; for local hybrid testing,
// set MAIN_DEVELOPER_SERVICE_URL env var and reference it from credentials.url.)
//
// (#1105 Task 11 — srv-mcp dedicated authenticated MCP module)

import cds from '@sap/cds';

import {
  handleGetMyTutorials,
  handleGetMyMissions,
  handleGetMyEvents,
  handleGetMyCompletedSteps,
  handleGetTutorialStep,
} from './lib/mcp-developer-tools.js';

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
      return forwardWriteToMainSrv('completeStep', req.data, req);
    });

    this.on('reset_tutorial_progress', async (req) => {
      return forwardWriteToMainSrv('resetTutorialProgress', { slug: req.data.slug }, req);
    });

    await super.init();
  }
}

/**
 * Forward a write action to the deployed main tutorials-srv.
 *
 * Best-effort: wraps the remote connect/send in try/catch; if the remote service
 * is unreachable (connection refused, ETIMEDOUT, network partition) the handler
 * returns a graceful 503 rather than letting an unhandled error propagate.
 *
 * @param {string} event - The camelCase action name on main DeveloperService
 *   (e.g. 'completeStep', 'resetTutorialProgress').
 * @param {object} data  - Action payload (slug + optional stepNumber).
 * @param {object} req   - CAP request object (provides req.user + req.reject).
 *
 * BINDING STUB — T12 must supply credentials.url in MainDeveloperService binding.
 * Until that is set, every write returns 503.
 */
async function forwardWriteToMainSrv(event, data, req) {
  try {
    const mainSrv = await cds.connect.to('MainDeveloperService');
    const result = await mainSrv.send({
      event,
      data,
      user: req.user,
    });
    return result;
  } catch (err) {
    LOG.warn(`[srv-mcp] forward to main-srv failed (${event}):`, err.message ?? err);
    return req.reject(503, 'progress service temporarily unavailable');
  }
}
