// srv/lib/input-validation/json-shape.js
// Pure, dependency-free JSON shape validator for the origin input guard (PR3).
// Rejects payloads that are pathologically deep, wide, or long — the shapes a
// WAF would drop before they reach a handler and blow up the heap / a query.
//
// The walk is ITERATIVE (explicit stack), not recursive: a recursive walker
// would itself overflow the call stack on a deeply-nested attack payload —
// exactly the input we are trying to reject. NEVER throws; a caller-side fault
// (e.g. a getter that throws) is caught and treated as "ok" (fail-open is the
// caller's job, but we do not add a throw of our own).

/**
 * @typedef {{ maxJsonDepth:number, maxJsonKeys:number, maxArrayLen:number }} ShapeLimits
 * @typedef {{ ok:true } | { ok:false, reason:'depth'|'keys'|'array', detail:string }} ShapeResult
 */

/**
 * Validate a parsed JSON value against depth / total-key / array-length limits.
 * @param {*} root parsed JSON value (object/array/primitive)
 * @param {ShapeLimits} limits
 * @returns {ShapeResult}
 */
export function validateJsonShape(root, limits) {
  const maxDepth = limits.maxJsonDepth;
  const maxKeys = limits.maxJsonKeys;
  const maxArrayLen = limits.maxArrayLen;

  // Primitives (and null) have no shape to violate.
  if (root === null || typeof root !== 'object') return { ok: true };

  let totalKeys = 0;
  // Stack frames: { node, depth }. Depth 1 = the root container.
  const stack = [{ node: root, depth: 1 }];

  while (stack.length) {
    const { node, depth } = stack.pop();
    if (depth > maxDepth) {
      return { ok: false, reason: 'depth', detail: `nesting depth exceeds ${maxDepth}` };
    }

    if (Array.isArray(node)) {
      if (node.length > maxArrayLen) {
        return { ok: false, reason: 'array', detail: `array length ${node.length} exceeds ${maxArrayLen}` };
      }
      for (let i = 0; i < node.length; i++) {
        const child = node[i];
        if (child !== null && typeof child === 'object') stack.push({ node: child, depth: depth + 1 });
      }
    } else {
      // Plain object.
      const keys = Object.keys(node);
      totalKeys += keys.length;
      if (totalKeys > maxKeys) {
        return { ok: false, reason: 'keys', detail: `total key count exceeds ${maxKeys}` };
      }
      for (let i = 0; i < keys.length; i++) {
        const child = node[keys[i]];
        if (child !== null && typeof child === 'object') stack.push({ node: child, depth: depth + 1 });
      }
    }
  }

  return { ok: true };
}
