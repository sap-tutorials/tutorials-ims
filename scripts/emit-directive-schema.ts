import { pathToFileURL } from 'node:url';
import { getRegistry, type DirectiveDef, type AttrDef } from './parsers/directive-registry.js';

/**
 * Schema representation of a directive attribute.
 */
interface SchemaAttr {
  type: 'string' | 'number' | 'boolean' | 'enum' | 'duration';
  values?: string[];
  required?: boolean;
  default?: string | number | boolean;
  pattern?: string;
}

/**
 * Schema representation of a directive definition (exported format).
 */
interface SchemaDirective {
  name: string;
  kinds: Array<'inline' | 'leaf' | 'container'>;
  summary: string;
  label?: {
    required: boolean;
    markdown: boolean;
  };
  attrs: Record<string, SchemaAttr>;
  classes?: string[];
  since: string;
}

/**
 * Schema representation of the top-level directive registry.
 */
interface DirectiveSchema {
  $schema: string;
  $id: string;
  version: string;
  directives: Record<string, SchemaDirective>;
}

/**
 * Convert a DirectiveDef to its schema representation (omitting runtime functions).
 */
function defToSchema(def: DirectiveDef): SchemaDirective {
  const result: SchemaDirective = {
    name: def.name,
    kinds: def.kinds,
    summary: def.summary,
    attrs: def.attrs as Record<string, SchemaAttr>,
    since: def.since,
  };

  // Include optional fields if present
  if (def.label !== undefined) {
    result.label = def.label;
  }
  if (def.classes !== undefined) {
    result.classes = def.classes;
  }

  return result;
}

/**
 * Emit the directive registry as a JSON Schema artifact.
 *
 * @param registry  Optional pre-loaded registry. If omitted, getRegistry() is called.
 * @returns        JSON string (LF-normalised, with trailing newline).
 */
export function emitDirectiveSchema(registry?: ReadonlyMap<string, DirectiveDef>): string {
  const reg = registry ?? getRegistry();

  const directives: Record<string, SchemaDirective> = {};
  for (const [name, def] of reg) {
    directives[name] = defToSchema(def);
  }

  const schema: DirectiveSchema = {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: 'https://developers.sap.com/schemas/tutorial-directives.schema.json',
    version: '1.0.0',
    directives,
  };

  const json = JSON.stringify(schema, null, 2);
  // Normalise CRLF → LF on Windows
  const normalized = json.replace(/\r\n/g, '\n');
  return normalized.trimEnd() + '\n';
}

// CLI harness — only runs when invoked directly (not when imported as a module).
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { writeFileSync, mkdirSync } = await import('node:fs');
  const path = await import('node:path');
  const schema = emitDirectiveSchema();
  mkdirSync('schemas', { recursive: true });
  writeFileSync(path.join('schemas', 'tutorial-directives.schema.json'), schema, 'utf8');
  console.log(`wrote schemas/tutorial-directives.schema.json (${schema.length} bytes)`);
}
