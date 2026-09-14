// srv/lib/input-validation/register.js
//
// WAF-equivalent input validation for the anon / agentic write surface (PR3 of
// the origin-abuse-protection series). Follows the register(app) convention of
// srv/lib/rate-limit/register.js and mounts in cds.on('bootstrap') so it sits
// AHEAD of the CAP service handlers in the express stack.
//
// Master kill switch: INPUT_VALIDATION_ENABLED (ImsConfig flag.inputvalidation),
// default OFF. When off every mounted middleware is a straight pass-through.
// Numeric thresholds come from input-validation-settings.js (~5s cache, DB-
// backed, env-free). EVERYTHING here FAILS OPEN: a fault anywhere resolves to
// next() (request allowed) — the validator must never break the surface it
// protects.
//
// Two mount modes:
//   'size' — Content-Length size cap ONLY. Never touches the request stream, so
//            it can't loosen a stricter inline limit (e.g. /api/ui-event's 64kb
//            express.json) and can't interfere with CAP's OData body parsing.
//            Applied broadly across the anon POST surface.
//   'full' — size cap PLUS a bounded pre-parse + JSON depth/shape check. Scoped
//            to the agentic JSON-RPC surface (/mcp*, /a2a, /chat/stream) which is
//            anonymous AND CSRF-disabled (the sharpest exposure) and carries no
//            stricter inline body limit to loosen. The pre-parse is reused
//            downstream: CAP's bodyParser4 early-returns when req.body is already
//            an object, and graphql-http reads req.body when a parser has run —
//            so we never double-consume the stream.
//
// GraphQL /graphql/public depth/complexity/introspection limiting lives in
// srv/lib/graphql-guard.js (wired through graphql-config.js); here we only add
// the outer body-size cap for that path.

import cds from '@sap/cds';
import express from 'express';
import { isFlagEnabled } from '../feature-flags/db-flags.js';
import { resolveInputValidationConfig } from '../runtime-config/input-validation-settings.js';
import { validateJsonShape } from './json-shape.js';
import { counter } from '../metrics.js';

const LOG = cds.log('input-validation');

const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH']);
const JSON_CT = /application\/(json|[\w.+-]*\+json)\b/i;

function isJsonBody(req) {
  return JSON_CT.test(String(req.headers['content-type'] || ''));
}

// Validate an already-parsed body and either 400 or continue. Fail-open: a fault
// in the walker itself logs and allows.
function shapeCheckAndContinue(req, res, next, cfg) {
  try {
    const body = req.body;
    if (body === null || typeof body !== 'object') return next();
    const r = validateJsonShape(body, cfg);
    if (!r.ok) {
      counter(`inputvalidation.blocked[reason=${r.reason}]`);
      return res.status(400).json({ error: 'invalid_body_shape', reason: r.reason });
    }
  } catch (err) {
    LOG.warn(`shape check error (allowing request): ${err.message}`);
  }
  return next();
}

/**
 * Build an input-validation middleware.
 * @param {{ mode?: 'size'|'full', exclude?: RegExp|null }} opts
 */
export function inputValidationMiddleware({ mode = 'size', exclude = null } = {}) {
  return async function inputValidation(req, res, next) {
    let cfg;
    try {
      if (!isFlagEnabled('INPUT_VALIDATION_ENABLED')) return next();
      if (!WRITE_METHODS.has(req.method)) return next();
      if (exclude && exclude.test(req.path)) return next();
      cfg = await resolveInputValidationConfig();
    } catch (err) {
      LOG.warn(`input-validation setup error (allowing request): ${err.message}`);
      return next();
    }

    try {
      // 1. Body-size cap from the declared Content-Length (cheap, pre-parse).
      const clen = Number(req.headers['content-length']);
      if (Number.isFinite(clen) && clen > cfg.maxBodyBytes) {
        counter('inputvalidation.blocked[reason=size]');
        return res.status(413).json({ error: 'payload_too_large', maxBytes: cfg.maxBodyBytes });
      }

      // 2. size-only mode, non-JSON, or a non-object body → nothing more to do.
      if (mode !== 'full' || !isJsonBody(req)) return next();

      // If a parser already ran (object body), validate what we have.
      if (req.body !== undefined && req.body !== null && typeof req.body === 'object') {
        return shapeCheckAndContinue(req, res, next, cfg);
      }

      // Bounded pre-parse. The byte limit backstops a lying/absent Content-Length.
      // strict:false keeps express.json's acceptance set (primitives allowed) so
      // we don't reject payloads a handler would otherwise accept.
      const parser = express.json({ limit: cfg.maxBodyBytes, strict: false });
      parser(req, res, (err) => {
        if (err) {
          if (err.type === 'entity.too.large' || err.status === 413 || err.statusCode === 413) {
            counter('inputvalidation.blocked[reason=size]');
            return res.status(413).json({ error: 'payload_too_large', maxBytes: cfg.maxBodyBytes });
          }
          // Malformed JSON: the stream is already consumed, so we cannot fall
          // through to a downstream parser. CAP would itself answer 400 here
          // (InvalidJSON), so a 400 is not a behaviour regression.
          counter('inputvalidation.blocked[reason=malformed]');
          return res.status(400).json({ error: 'invalid_json' });
        }
        return shapeCheckAndContinue(req, res, next, cfg);
      });
    } catch (err) {
      LOG.warn(`input-validation error (allowing request): ${err.message}`);
      return next();
    }
  };
}

// Broad anon POST surface — size cap only (stream-safe, no loosening).
const SIZE_MOUNTS = [
  // Spare the privileged publish/rollback write paths (API-key auth, low volume).
  { prefix: '/content', exclude: /^\/(publish|rollback)\b/ },
  // Spare /build/repo-catalog — authenticated, intentionally large (10mb) writes.
  { prefix: '/build', exclude: /^\/repo-catalog\b/ },
  { prefix: '/graph' },
  { prefix: '/feedback' },
  { prefix: '/homepage' },
  { prefix: '/api' },
  { prefix: '/graphql/public' },
];

// Agentic JSON-RPC surface — size cap PLUS pre-parse depth/shape check.
const FULL_MOUNTS = [
  { prefix: '/mcp' },
  { prefix: '/mcp-pat' },
  { prefix: '/a2a' },
  { prefix: '/chat/stream' },
];

/**
 * Mount the input validator on the anon/agentic surface. Call from
 * cds.on('bootstrap'). Idempotent-safe to call once.
 */
export function register(app) {
  for (const m of SIZE_MOUNTS) {
    app.use(m.prefix, inputValidationMiddleware({ mode: 'size', exclude: m.exclude }));
  }
  for (const m of FULL_MOUNTS) {
    app.use(m.prefix, inputValidationMiddleware({ mode: 'full', exclude: m.exclude }));
  }
  LOG.info(
    `input validator mounted (size:${SIZE_MOUNTS.length}, full:${FULL_MOUNTS.length}; flag-gated, default off)`
  );
}
