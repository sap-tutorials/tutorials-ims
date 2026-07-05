import cds from '@sap/cds';
import { createRequire } from 'node:module';

const _require = createRequire(import.meta.url);

/**
 * Emit the GraphQL SDL string for the project's @graphql-annotated services.
 *
 * All three GraphQL services (KnowledgeGraphService, SearchService,
 * DeveloperService) use service-level @graphql annotation. The plugin's
 * `served` hook detects service-level @graphql only — entity-level
 * @protocol does not register the service for GraphQL.
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

  // All GraphQL services use service-level @graphql annotation.
  // Detect via cds.compile.to.serviceinfo(...).endpoints kind === 'graphql'.
  const services: Record<string, unknown> = Object.fromEntries(
    (linked.services as any[])
      .map((s: any) => [s.name, new (cds.ApplicationService as any)(s.name, linked)])
      .filter(([, service]: [string, any]) => {
        return serviceinfo
          .find((si: any) => si.name === service.name)
          ?.endpoints?.some((e: any) => e.kind === 'graphql');
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
