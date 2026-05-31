// Type declarations for the isomorphic Phase 1 modules consumed via the
// @srv-lib Vite alias. The .mjs files themselves are plain ESM JavaScript;
// these stub declarations give TypeScript-side consumers a typed surface
// without forcing JSDoc into the runtime modules.

declare module '@srv-lib/query-spec-validator.mjs' {
  import type { QuerySpec, ValidationResult } from '../src/types/query-spec'

  // entityMap: Map<entityName, { columns: Map<colName, { type: string }> }>
  // Modeled loosely here — chip components pass useEntityGraph()'s entityMap
  // and the validator only reads .has(name) + .columns.has(col) + .columns.get(col).type.
  export function validateQuerySpec(
    spec: QuerySpec | null | undefined,
    entityMap: Map<string, { columns: Map<string, { type: string }> }>
  ): ValidationResult
}

declare module '@srv-lib/spec-to-sql.mjs' {
  import type { QuerySpec } from '../src/types/query-spec'

  // sqlNames: { [logicalEntityName]: physicalSqlName }
  export function specToSql(
    spec: QuerySpec,
    sqlNames: Record<string, string>
  ): string
}
