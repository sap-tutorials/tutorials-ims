import { stringify } from 'yaml'

/**
 * [#2023] Serialize a value as Hugo-safe frontmatter YAML.
 *
 * Hugo parses page frontmatter with YAML **1.1** semantics, where the tokens
 * `yes`/`no`/`on`/`off`/`y`/`n`/`true`/`false` (any case) are booleans. The
 * `yaml` npm library defaults to YAML **1.2**, in which only `true`/`false`
 * are booleans and `yes`/`no` are plain strings — so it emits them UNQUOTED.
 * Hugo then silently coerces those bare tokens on read, e.g. a quiz answer
 * option `yes` becomes `true` and `###Match`'s `[x] yes` renders as "true"
 * (see the issue: rules.vr `no`/`yes` shown as `false`/`true`). A
 * `correctAnswer: yes` is flipped to `true` the same way, which also breaks
 * grading.
 *
 * Serializing with `version: '1.1'` makes the writer quote every token that a
 * 1.1 reader would misinterpret, so strings survive the round-trip into Hugo's
 * parser intact. Structure and all other output are unchanged — only ambiguous
 * scalars gain quotes. Use this for anything written to Hugo frontmatter.
 */
export function hugoFrontmatterStringify(value: unknown): string {
  return stringify(value, { version: '1.1' })
}
