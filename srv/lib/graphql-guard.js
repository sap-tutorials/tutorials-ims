// srv/lib/graphql-guard.js
//
// Depth + complexity + introspection guard for the anonymous GraphQL endpoint
// /graphql/public (PR3 of origin-abuse-protection). Wired into graphql-config.js
// as the `validationRules` option of the /graphql/public GraphQLAdapter, which
// graphql-http evaluates PER REQUEST — so the guard is flag-gated and config-
// driven live, with no re-mount required.
//
// - Depth limit: rejects queries whose selection-set nesting exceeds gqlMaxDepth
//   (a classic amplification vector on a graph schema with cyclic associations).
// - Complexity limit: rejects queries whose total field-selection count exceeds
//   gqlMaxComplexity (a cheap, schema-agnostic cost proxy — no field weights, no
//   new dependency).
// - Introspection: in PROD, adds graphql-js's NoSchemaIntrospectionCustomRule so
//   __schema / __type probes are rejected on the public endpoint. Left ON in
//   dev/local so tooling keeps working.
//
// Master kill switch: INPUT_VALIDATION_ENABLED (default OFF). When off — or on
// ANY error — the guard returns the caller's default `specifiedRules` unchanged
// (fail-open: never break the endpoint it protects). No new dependency: the
// depth/complexity rules are hand-rolled graphql-js ValidationRules.

import cds from '@sap/cds';
import { GraphQLError, NoSchemaIntrospectionCustomRule } from 'graphql';
import { isFlagEnabled } from './feature-flags/db-flags.js';
import { resolveInputValidationConfig } from './runtime-config/input-validation-settings.js';
import { resolveDeployEnvironment } from './deploy-environment.js';

const LOG = cds.log('graphql-guard');

/**
 * Walk a selection set (resolving fragment spreads, guarding cycles) and return
 * the max nesting depth and total field-selection count beneath `depth`.
 * @returns {{ maxDepth:number, fields:number }}
 */
function analyzeSelectionSet(selectionSet, fragments, visitedFragments, depth) {
  if (!selectionSet) return { maxDepth: depth, fields: 0 };
  let maxDepth = depth;
  let fields = 0;

  for (const sel of selectionSet.selections) {
    if (sel.kind === 'Field') {
      fields += 1;
      const r = analyzeSelectionSet(sel.selectionSet, fragments, visitedFragments, depth + 1);
      if (r.maxDepth > maxDepth) maxDepth = r.maxDepth;
      fields += r.fields;
    } else if (sel.kind === 'InlineFragment') {
      // Inline fragments don't add a nesting level of their own.
      const r = analyzeSelectionSet(sel.selectionSet, fragments, visitedFragments, depth);
      if (r.maxDepth > maxDepth) maxDepth = r.maxDepth;
      fields += r.fields;
    } else if (sel.kind === 'FragmentSpread') {
      const name = sel.name.value;
      if (visitedFragments.has(name)) continue; // cycle guard (validate() also reports this)
      const frag = fragments[name];
      if (!frag) continue;
      const nextVisited = new Set(visitedFragments);
      nextVisited.add(name);
      const r = analyzeSelectionSet(frag.selectionSet, fragments, nextVisited, depth);
      if (r.maxDepth > maxDepth) maxDepth = r.maxDepth;
      fields += r.fields;
    }
  }
  return { maxDepth, fields };
}

/**
 * A graphql-js ValidationRule that enforces both a depth and a complexity cap.
 * One rule = one AST walk per operation.
 */
export function costLimitRule(maxDepth, maxComplexity) {
  return function CostLimit(context) {
    const fragments = Object.create(null);
    for (const def of context.getDocument().definitions) {
      if (def.kind === 'FragmentDefinition') fragments[def.name.value] = def;
    }
    return {
      OperationDefinition(node) {
        const { maxDepth: d, fields: c } = analyzeSelectionSet(
          node.selectionSet,
          fragments,
          new Set(),
          0
        );
        if (d > maxDepth) {
          context.reportError(
            new GraphQLError(`Query exceeds maximum depth of ${maxDepth} (depth ${d}).`, {
              nodes: [node],
            })
          );
        }
        if (c > maxComplexity) {
          context.reportError(
            new GraphQLError(
              `Query exceeds maximum complexity of ${maxComplexity} (cost ${c}).`,
              { nodes: [node] }
            )
          );
        }
        return false; // analysis is done at the operation root; don't descend
      },
    };
  };
}

/**
 * Build the effective validation rules for a /graphql/public request. Shape
 * matches graphql-http's `validationRules` function form:
 *   (req, args, specifiedRules) => rules
 * FAILS OPEN: flag off / any error → return `specifiedRules` unchanged.
 */
export async function buildPublicValidationRules(_req, _args, specifiedRules) {
  try {
    if (!isFlagEnabled('INPUT_VALIDATION_ENABLED')) return specifiedRules;
    const cfg = await resolveInputValidationConfig();
    const rules = [...specifiedRules, costLimitRule(cfg.gqlMaxDepth, cfg.gqlMaxComplexity)];
    if (resolveDeployEnvironment().id === 'prod') {
      rules.push(NoSchemaIntrospectionCustomRule);
    }
    return rules;
  } catch (err) {
    LOG.warn(`validation-rule build failed (allowing default rules): ${err.message}`);
    return specifiedRules;
  }
}
