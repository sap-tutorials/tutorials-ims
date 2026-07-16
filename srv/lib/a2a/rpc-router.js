// srv/lib/a2a/rpc-router.js
// A2A JSON-RPC 2.0 dispatcher mounted at /a2a (#1220). Protocol concerns only:
// kill switch, auth reject, method routing, error shaping. Auth is enforced by
// CAP's auth middleware upstream (cds.context.user); we reject anonymous here
// as a clean JSON-RPC -32001 rather than a 500.
import cds from '@sap/cds';
import express from 'express';
import { resolveSkillId, runToolSkill, runChatSkillStream, A2aError } from './skills.js';
import { extractText, terminalTaskEvent } from './message-adapter.js';
import { getTask, cancelTask, newTaskId, putTask } from './task-store.js';
// FIX 1: rate limiter — same imports as /chat/stream in server.js.
import { createRateLimiter, RateLimitError } from '../chat-rate-limit.js';
import { resolveA2aSettings } from '../runtime-config/a2a-settings.js';

const LOG = cds.log('a2a');
const SETTINGS_ID = '00000000-0000-0000-0000-00000000c8a7';

// FIX 1: module-level singleton so window is shared across all requests, just
// like the rateLimiter in the /chat/stream handler in server.js.
const rateLimiter = createRateLimiter();

function rpcError(res, httpStatus, id, code, message) {
  if (httpStatus === 401) res.setHeader('WWW-Authenticate', 'Bearer error="invalid_token"');
  return res.status(httpStatus).json({ jsonrpc: '2.0', error: { code, message }, id: id ?? null });
}

async function readChatSettings() {
  const { ChatSettings } = cds.entities('com.sap.developers.ims');
  return SELECT.one.from(ChatSettings).where({ ID: SETTINGS_ID });
}

export function makeA2aRouter() {
  const router = express.Router();
  // Dual path: matches both when the router is mounted via app.use('/a2a', …)
  // (path presents as '/') and when invoked directly as a handler in server.js
  // (req.url is still '/a2a', prefix NOT stripped). Verified both styles route. (#1220)
  router.post(['/', '/a2a'], async (req, res) => {
    const { id, method, params } = req.body || {};
    try {
      const a2aCfg = await resolveA2aSettings();
      if (!a2aCfg.enabled) return rpcError(res, 503, id, -32603, 'A2A endpoint disabled');

      const user = cds.context?.user;
      if (!user?.id || user.id === 'anonymous') {
        return rpcError(res, 401, id, -32001, 'Authentication required (Tutorial.MCP scope).');
      }

      if (method === 'tasks/get') {
        const snap = await getTask(params?.id);
        // FIX 4 (IDOR): treat missing AND not-owned tasks identically to avoid
        // leaking task existence to a different user.
        if (!snap || snap.userId !== user.id) throw new A2aError(-32602, `Unknown task '${params?.id}'`);
        return res.json({ jsonrpc: '2.0', id, result: snap });
      }
      if (method === 'tasks/cancel') {
        // FIX 4 (IDOR): load first, ownership-check, then cancel.
        const existing = await getTask(params?.id);
        if (!existing || existing.userId !== user.id) throw new A2aError(-32602, `Unknown task '${params?.id}'`);
        const snap = await cancelTask(params?.id);
        return res.json({ jsonrpc: '2.0', id, result: snap });
      }

      if (method === 'message/send' || method === 'message/stream') {
        const settings = await readChatSettings();
        if (!settings || !settings.enabled || !settings.deploymentId) {
          return rpcError(res, 503, id, -32603, 'Chat backend disabled');
        }

        // FIX 1: rate-limit check before any dispatch — covers both tool skills
        // and chat skill.
        try {
          rateLimiter.check(user.id, settings.maxRequestsPerUser ?? 100);
        } catch (e) {
          if (e instanceof RateLimitError) {
            res.setHeader('Retry-After', String(e.retryAfterSec ?? 60));
            return rpcError(res, 429, id, -32005, 'Rate limit exceeded');
          }
          throw e;
        }

        const message = params?.message;
        const skillId = resolveSkillId(message, params);
        const isAdmin = !!(user.is && user.is('Admin'));
        const taskId = newTaskId();
        const contextId = params?.contextId || newTaskId();

        // Tool skills are always synchronous (no streaming).
        if (skillId !== 'tutorial-chat') {
          const result = await runToolSkill({ skillId, text: extractText(message), user });
          // FIX 4 (IDOR): include userId so tasks/get ownership check works.
          const snap = { id: taskId, contextId, userId: user.id, state: 'completed', result };
          await putTask(taskId, snap);
          return res.json({
            jsonrpc: '2.0', id,
            result: {
              kind: 'task', id: taskId, contextId,
              status: { state: 'completed' },
              artifacts: [{ name: skillId, parts: [{ kind: 'data', data: result }] }],
            },
          });
        }

        // Chat skill — streaming response.
        // FIX 5: SSE headers are now set INSIDE runChatSkillStream, AFTER
        // buildChatInvocation succeeds. Removing them here ensures that a
        // pre-flight throw (e.g. bad invocation config) produces a proper
        // JSON-RPC -32603 via the outer catch rather than an empty stream.
        if (method === 'message/stream') {
          await runChatSkillStream({ message, user, res, taskId, contextId, settings, isAdmin });
          if (!res.writableEnded) res.end();
          return;
        }

        // message/send on chat skill: buffer to completion, return one task object.
        // FIX 2: also collect artifact-update frames (already-mapped A2A events).
        let text = '';
        const collectedArtifacts = [];
        const buffer = {
          write(s) {
            const m = /^data: (.*)\n\n$/s.exec(s);
            if (m) {
              try {
                const f = JSON.parse(m[1]);
                if (f.kind === 'status-update' && f.final !== true && f.status?.state === 'working') {
                  const parts = f.status?.message?.parts;
                  if (Array.isArray(parts)) {
                    for (const p of parts) { if (p?.kind === 'text') text += p.text ?? ''; }
                  }
                }
                // FIX 2: collect artifact frames.
                if (f.kind === 'artifact-update' && f.artifact) collectedArtifacts.push(f.artifact);
              } catch { /* ignore malformed frames */ }
            }
            return true;
          },
          flush() {},
          setHeader() {},
          flushHeaders() {},
          on() {},
          end() {},
          get headersSent() { return false; },
        };
        await runChatSkillStream({ message, user, res: buffer, taskId, contextId, settings, isAdmin });
        // FIX 2: pass collected artifacts into the terminal event.
        return res.json({
          jsonrpc: '2.0', id,
          result: terminalTaskEvent({ taskId, contextId, state: 'completed', text, artifacts: collectedArtifacts }),
        });
      }

      return rpcError(res, 200, id, -32601, `Unknown method '${method}'`);
    } catch (err) {
      if (err instanceof A2aError) {
        return res
          .status(err.code === -32001 ? 401 : 200)
          .json({ jsonrpc: '2.0', error: { code: err.code, message: err.message }, id: id ?? null });
      }
      const cid = `a2a-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      LOG.error(`a2a request failed [${cid}] — ${err.message}`);
      if (!res.headersSent) return rpcError(res, 200, id, -32603, `Internal error (id: ${cid})`);
      try { res.end(); } catch { /* already closed */ }
    }
  });
  return router;
}
