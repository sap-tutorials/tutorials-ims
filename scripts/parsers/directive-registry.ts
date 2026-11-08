// scripts/parsers/directive-registry.ts
//
// Central registry for tutorial directive definitions.
// Directives are registered at startup (or in tests) and queried by the parser.
//
// Name constraint: must match /^[a-z][a-z0-9-]*$/ (lowercase kebab-case).
// Duplicate registration of the same name throws.
// resetRegistry() is test-only — clears all registrations.

/** Attribute schema for a directive. */
export interface AttrDef {
  type: 'string' | 'number' | 'boolean' | 'enum' | 'duration';
  /** For type === 'enum', the allowed values. */
  values?: string[];
  required?: boolean;
  default?: string | number | boolean;
  /** Regex pattern (for type === 'string'). */
  pattern?: string;
}

/** Render output for a directive — either structured shortcode params or raw markdown. */
export interface DirectiveRenderOutput {
  /** Shortcode parameters. Framework handles escaping. */
  params?: Record<string, string | number | boolean>;
  /** Container body (markdown, not escaped — Hugo re-renders). */
  body?: string;
  /** Plain markdown to emit unwrapped (no shortcode). */
  markdown?: string;
  /**
   * Override the emitted Hugo shortcode name. Defaults to `tut-<directive name>`.
   * Use when several directives share one template — e.g. the callout
   * directives (details/troubleshoot/result/hint/solution) all render via the
   * single `tut-alert` shortcode (distinguished by a `type` param), so there is
   * no `tut-details.html` etc. Value is used verbatim as the shortcode name.
   */
  shortcode?: string;
}

/** Full directive definition registered in the registry. */
export interface DirectiveDef {
  /** Lowercase kebab-case name, e.g. 'code-block', 'note'. */
  name: string;
  /** Which syntactic kinds this directive accepts. */
  kinds: Array<'inline' | 'leaf' | 'container'>;
  /** Human-readable description for tooling / documentation. */
  summary: string;
  /** Label (content between [...]) schema. */
  label?: {
    required: boolean;
    markdown: boolean;
  };
  /** Attribute schema keyed by attribute name. */
  attrs: Record<string, AttrDef>;
  /**
   * When true, attributes not listed in `attrs` are accepted without error.
   * Used by directives like `::include` that accept free-form param attrs.
   */
  allowExtraAttrs?: boolean;
  /** Allowed CSS class names (the values that may appear after '.' in attr block). */
  classes?: string[];
  /** Optional expander: rewrite the node before rendering. */
  expand?(node: unknown, ctx: unknown): string;
  /** Render the node. Returns structured output; framework builds shortcodes with safe escaping. */
  render(node: unknown, ctx: unknown): DirectiveRenderOutput;
  /** Render the node to plain text. */
  toText(node: unknown, ctx: unknown): string;
  /** Semver of the platform version that introduced this directive. */
  since: string;
}

// Name constraint: lowercase letter, then lowercase letters/digits/hyphens.
const NAME_RE = /^[a-z][a-z0-9-]*$/;

const _registry = new Map<string, DirectiveDef>();

/**
 * Register a directive definition.
 * Throws if the name is invalid or already registered.
 */
export function registerDirective(def: DirectiveDef): void {
  if (!NAME_RE.test(def.name)) {
    throw new Error(
      `Invalid directive name "${def.name}": must match /^[a-z][a-z0-9-]*$/`,
    );
  }
  if (_registry.has(def.name)) {
    throw new Error(`Directive "${def.name}" is already registered`);
  }
  _registry.set(def.name, def);
}

/**
 * Return the live registry as a ReadonlyMap.
 * The map is the same object as the internal registry — do not mutate it.
 */
export function getRegistry(): ReadonlyMap<string, DirectiveDef> {
  return _registry;
}

/**
 * Clear all registrations. Test-only helper — do not call in production code.
 */
export function resetRegistry(): void {
  _registry.clear();
}
