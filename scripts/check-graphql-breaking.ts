#!/usr/bin/env tsx
// Additive-only SDL diff.
// - Detects: removed types, removed fields, changed field types, added required args, removed enum values.
// - Reports each breaking change with whether the outgoing element is @deprecated in the OLD schema.
//
// Uses require() via createRequire to stay in the CJS realm and avoid the
// ESM/CJS dual-instance "Cannot use GraphQLObjectType from another module" error.

import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const _require = createRequire(import.meta.url);

const {
  buildSchema,
  isObjectType,
  isInterfaceType,
  isEnumType,
} = _require('graphql') as typeof import('graphql');

export interface Breaking {
  kind: string;
  where: string;
  detail: string;
  deprecated: boolean;
}

type GqlSchema = ReturnType<typeof buildSchema>;

function collectFields(sc: GqlSchema): Map<string, any[]> {
  const out = new Map<string, any[]>();
  for (const t of Object.values(sc.getTypeMap())) {
    if (isObjectType(t) || isInterfaceType(t)) {
      out.set(t.name, Object.values(t.getFields()));
    }
  }
  return out;
}

export function diffSchemas(oldSdl: string, newSdl: string): { breaking: Breaking[] } {
  const o = buildSchema(oldSdl, { assumeValid: true });
  const n = buildSchema(newSdl, { assumeValid: true });
  const oldFields = collectFields(o);
  const newFields = collectFields(n);
  const breaking: Breaking[] = [];

  for (const [typeName, ofs] of oldFields) {
    const nfs = newFields.get(typeName);
    if (!nfs) {
      breaking.push({ kind: 'TYPE_REMOVED', where: typeName, detail: '', deprecated: false });
      continue;
    }
    const nByName = new Map(nfs.map((f: any) => [f.name, f]));
    for (const of_ of ofs) {
      const nf = nByName.get(of_.name);
      if (!nf) {
        breaking.push({
          kind: 'FIELD_REMOVED',
          where: `${typeName}.${of_.name}`,
          detail: '',
          deprecated: !!of_.deprecationReason,
        });
        continue;
      }
      if (of_.type.toString() !== nf.type.toString()) {
        breaking.push({
          kind: 'FIELD_TYPE_CHANGED',
          where: `${typeName}.${of_.name}`,
          detail: `${of_.type} -> ${nf.type}`,
          deprecated: !!of_.deprecationReason,
        });
      }
      // Args made required (added with ! and not present in old schema).
      for (const na of nf.args) {
        const oa = of_.args.find((a: any) => a.name === na.name);
        if (!oa && na.type.toString().endsWith('!')) {
          breaking.push({
            kind: 'REQUIRED_ARG_ADDED',
            where: `${typeName}.${of_.name}(${na.name})`,
            detail: '',
            deprecated: false,
          });
        }
      }
    }
  }

  // Enum values removed.
  for (const t of Object.values(o.getTypeMap())) {
    if (!isEnumType(t)) continue;
    const nt = n.getType(t.name);
    if (!nt || !isEnumType(nt)) {
      breaking.push({ kind: 'ENUM_REMOVED', where: t.name, detail: '', deprecated: false });
      continue;
    }
    for (const v of t.getValues()) {
      const nv = nt.getValue(v.name);
      if (!nv) {
        breaking.push({
          kind: 'ENUM_VALUE_REMOVED',
          where: `${t.name}.${v.name}`,
          detail: '',
          deprecated: !!v.deprecationReason,
        });
      }
    }
  }

  return { breaking };
}

// CLI harness — only runs when invoked directly (not when imported as a module).
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { readFileSync } = await import('node:fs');
  const oldSdl = readFileSync('graphql/.last-release.graphql', 'utf8');
  const newSdl = readFileSync('graphql/schema.graphql', 'utf8');
  const { breaking } = diffSchemas(oldSdl, newSdl);
  const unmitigated = breaking.filter(b => !b.deprecated);
  if (unmitigated.length) {
    console.error('Unmitigated breaking changes:');
    for (const b of unmitigated) {
      console.error(`  ${b.kind} at ${b.where}${b.detail ? ' ' + b.detail : ''}`);
    }
    process.exit(1);
  }
  console.log(`ok — ${breaking.length} deprecated-only changes, 0 unmitigated`);
}
