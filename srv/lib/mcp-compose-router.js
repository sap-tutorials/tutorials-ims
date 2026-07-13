// srv/lib/mcp-compose-router.js
import cds from '@sap/cds';
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  GetPromptRequestSchema, ListPromptsRequestSchema, ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
// Adapter internals — deep imports (see spec "Deep-import risk").
import {
  registerGenericReadTool, registerCallActionTool, registerPerActionTools,
  registerDescribeTool, getInstructions,
} from '@cap-js/mcp/lib/tools.js';
import { checkAuthorization } from '@cap-js/mcp/lib/auth.js';
import { resolvePrefix } from '@cap-js/mcp/lib/utils/service-name.js';
import { getDescription } from '@cap-js/mcp/lib/utils/cds-to-schema.js';
import { registerResources as realRegisterResources } from './mcp-resources.js';
import { loadPrompts, listPrompts, getPrompt } from './mcp-prompt-loader.js';
import * as metrics from './metrics.js';

const LOG = cds.log('mcp-compose');
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROMPT_DIR = path.join(__dirname, '..', 'mcp', 'prompts');

let _promptMap = null;
export function promptMapSingleton() {
  if (_promptMap) return _promptMap;
  try { _promptMap = loadPrompts(PROMPT_DIR); }
  catch (e) { LOG.error(`prompt load failed — ${e.message}`); _promptMap = new Map(); }
  return _promptMap;
}

export function flags() {
  const on = (v) => process.env[v] !== 'false';
  return { phase3: on('MCP_PHASE3_ENABLED'), resources: on('MCP_RESOURCES_ENABLED'), prompts: on('MCP_PROMPTS_ENABLED'), adminTools: on('MCP_ADMIN_TOOLS_ENABLED') };
}

/** Wire tools + (optionally) resources + prompts onto `server`, set capabilities. */
export async function buildServer(server, srv, { entities, actions }, deps = {}) {
  const f = flags();
  const prefix = resolvePrefix(srv.definition);
  // Tools — reuse adapter fns (injected in tests).
  const registerTools = deps.registerTools ?? (() => {
    const entityCount = Object.keys(entities).length;
    const actionCount = Object.keys(actions).length;
    if (entityCount > 0 || actionCount > 0) {
      registerGenericReadTool(server, srv, entities, prefix);
      (cds.env.mcp?.per_action_tool ? registerPerActionTools : registerCallActionTool)(server, srv, actions, prefix);
      registerDescribeTool(server, srv, entities, actions, prefix);
    } else {
      // Mirror adapter parity: empty service must still respond to tools/list with {tools:[]}.
      server.server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: [] }));
    }
  });

  // Build full caps FIRST, register ONCE, THEN wire request handlers.
  // SDK's setRequestHandler calls assertRequestHandlerCapability which throws
  // "Server does not support <capability>" if registerCapabilities hasn't been called yet.
  const caps = { tools: { listChanged: false } };
  if (f.resources) caps.resources = { subscribe: false, listChanged: false };
  if (f.prompts)   caps.prompts   = { listChanged: false };
  server.server.registerCapabilities(caps);

  registerTools();

  if (f.resources) {
    (deps.registerResourcesFn ?? realRegisterResources)(server, {});
  }
  if (f.prompts) {
    const map = deps.promptMap ?? promptMapSingleton();
    server.server.setRequestHandler(ListPromptsRequestSchema, () => ({ prompts: listPrompts(map) }));
    server.server.setRequestHandler(GetPromptRequestSchema, (req) => getPrompt(map, req.params.name, req.params.arguments ?? {}));
  }

  return server;
}

/** Express router that composes tools + resources + prompts per request.
 *
 * Fallback semantics: if buildServer/transport throws we return a JSON-RPC 500
 * for THIS request and bump `mcp_compose_fallback_total`; the NEXT request still
 * tries compose. A hard, permanent fallback (unmount compose, let `@cap-js/mcp`
 * autowire the plain adapter) is the `MCP_PHASE3_ENABLED=false` operator lever
 * (Task 8), NOT an automatic per-request router swap — swapping routers mid-flight
 * is not safe with the stateless StreamableHTTP transport.
 */
export default function makeComposeRouter(srv) {
  const router = express.Router();
  router.post('/', async (req, res) => {
    try {
      let requestService = srv;
      if (cds?.context?.model?.definitions) requestService = cds.context.model.definitions[srv.name] ?? srv;
      const { entities, actions, error } = checkAuthorization(requestService);
      if (error) {
        return res.status(error.code).json({
          jsonrpc: '2.0',
          error: { code: error.code === 401 ? -32001 : -32003, message: `Authorization error (${error.code}): Not authorized to access ${srv.name}.` },
          id: req.body?.id || null,
        });
      }
      const server = new McpServer(
        { name: srv.name, version: '1.0.0', description: getDescription(srv.definition) || `MCP server for ${srv.name}` },
        { instructions: getInstructions(srv.definition, null, resolvePrefix(srv.definition)) },
      );
      await buildServer(server, srv, { entities, actions });

      // Accept-header patch (identical to adapter lib/index.js).
      const accept = req.headers['accept'] || '';
      const enableJsonResponse = accept.includes('application/json') && !accept.includes('text/event-stream');
      if (!accept.includes('application/json') || !accept.includes('text/event-stream')) {
        const newAccept = 'application/json, text/event-stream';
        req.headers['accept'] = newAccept;
        const idx = req.rawHeaders.findIndex((h) => h.toLowerCase() === 'accept');
        if (idx !== -1) req.rawHeaders[idx + 1] = newAccept; else req.rawHeaders.push('Accept', newAccept);
      }
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse });
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
      await server.close();
    } catch (err) {
      LOG.error(`compose request failed — ${err.message}`);
      metrics.counter?.('mcp_compose_fallback_total');
      if (!res.headersSent) {
        res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal error: ' + err.message }, id: req.body?.id || null });
      }
    }
  });
  return router;
}
