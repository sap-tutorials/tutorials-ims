import cds from '@sap/cds';
import { createRequire } from 'node:module';

const _require = createRequire(import.meta.url);

/**
 * Emit the GraphQL SDL string for the project's @graphql-annotated services.
 *
 * Handles two annotation strategies used in this project:
 *   1. Service-level @graphql annotation (SearchService, DeveloperService — Tasks 3 & 5).
 *      Detected via cds.compile.to.serviceinfo(...).endpoints kind === 'graphql'.
 *   2. Entity-level @protocol containing 'graphql' (KnowledgeGraphService — Task 4).
 *      Detected by inspecting linked.services[*].entities[*]['@protocol'].
 *
 * Avoids the ESM/CJS dual-instance "Cannot use GraphQLObjectType from another module"
 * problem by using require() for all graphql-plugin and graphql-js modules (CJS path).
 *
 * Task 8 stub — CLI harness added in Task 9.
 *
 * @param csn  Pre-loaded CSN. If omitted, cds.load('srv/') is called.
 * @returns    SDL string (LF-normalised).
 */
export async function emitSdl(csn?: unknown): Promise<string> {
  const model: any = csn ?? (await cds.load('srv/'));

  // Register the graphql protocol so serviceinfo recognises service-level @graphql
  // annotations (cds-plugin.js sets cds.env.protocols.graphql).  This is idempotent.
  _require('@cap-js/graphql/cds-plugin.js');

  const { generateSchema4 } = _require('@cap-js/graphql/lib/schema') as {
    generateSchema4: (services: Record<string, unknown>) => unknown;
  };

  const linked: any = cds.linked(model);
  const serviceinfo: any[] = (cds as any).compile.to.serviceinfo(model);

  /**
   * A service should appear in the GraphQL schema if it is annotated at:
   *   a) service-level: serviceinfo shows endpoint kind 'graphql'  (strategy 1)
   *   b) entity-level: any entity in the service has @protocol containing 'graphql'
   *      (strategy 2 — KnowledgeGraphService, Task 4)
   */
  const hasEntityLevelGraphql = (service: any): boolean => {
    for (const ent of Object.values<any>(service.entities ?? {})) {
      const proto: unknown = ent['@protocol'];
      const asArr: unknown[] = Array.isArray(proto) ? proto : proto != null ? [proto] : [];
      if (asArr.some((p: unknown) => p === 'graphql' || (typeof p === 'object' && (p as any)?.kind === 'graphql'))) {
        return true;
      }
    }
    return false;
  };

  const services: Record<string, unknown> = Object.fromEntries(
    (linked.services as any[])
      .map((s: any) => [s.name, new (cds.ApplicationService as any)(s.name, linked)])
      .filter(([, service]: [string, any]) => {
        // Strategy 1: service-level @graphql (registered endpoint kind)
        const hasServiceLevel = serviceinfo
          .find((si: any) => si.name === service.name)
          ?.endpoints?.some((e: any) => e.kind === 'graphql');
        if (hasServiceLevel) return true;
        // Strategy 2: entity-level @protocol containing 'graphql'
        return hasEntityLevelGraphql(service);
      })
  );

  const schema = generateSchema4(services);

  // generateSchema4 returns a GraphQLSchema object; printSchema turns it into SDL.
  // Use require() to stay in the CJS realm and avoid the dual-instance error.
  const { printSchema } = _require('graphql') as { printSchema: (s: unknown) => string };
  const sdl: string = printSchema(schema);

  // Normalise CRLF → LF so JS regex `$` anchors work correctly on Windows.
  return sdl.replace(/\r\n/g, '\n');
}
