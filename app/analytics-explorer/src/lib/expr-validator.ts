import { Parser } from 'node-sql-parser'

const parser = new Parser()

export interface ExprValidationResult {
  ok: boolean
  error?: string
  referencedAliases: string[]
}

/**
 * Validate a SQL expression fragment by parsing it inside `SELECT <expr> FROM dummy`.
 * Used by SelectChip's expression branch to give live feedback as the user types.
 *
 * Returns referencedAliases (extracted from column-ref AST nodes) so the chip
 * can populate `referencedAliases` on apply, matching the SelectItem.expression shape.
 */
export function validateExpression(sql: string): ExprValidationResult {
  if (!sql.trim()) {
    return { ok: false, error: 'expression is empty', referencedAliases: [] }
  }
  try {
    const ast = parser.astify(`SELECT ${sql} FROM dummy`, { database: 'MySQL' }) as any
    const aliases = new Set<string>()
    walk(ast, (n: any) => {
      if (n?.type === 'column_ref' && n.table) aliases.add(n.table)
    })
    return { ok: true, referencedAliases: [...aliases] }
  } catch (e: any) {
    return { ok: false, error: e.message, referencedAliases: [] }
  }
}

function walk(node: any, visit: (n: any) => void) {
  if (!node || typeof node !== 'object') return
  visit(node)
  for (const v of Object.values(node)) {
    if (Array.isArray(v)) v.forEach(x => walk(x, visit))
    else walk(v, visit)
  }
}
