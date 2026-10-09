export function convertBody(source, slug) {
  const flags = []
  let body = source.replace(/\r\n/g, '\n')

  // Promote the first "## Title" to "# Title" and insert a description marker.
  const h2 = body.match(/^##\s+(.+?)\s*$/m)
  if (!h2) {
    flags.push('NO_TITLE: no leading "## " heading found; set the H1 title manually')
  } else {
    const title = h2[1]
    const descLine = '<!-- description --> TODO: one-sentence catalog description (REVIEW)'
    // The regex match includes one trailing newline; replace it with H1, description, and two newlines
    // to preserve any blank line that followed the original heading
    body = body.replace(h2[0], `# ${title}\n${descLine}\n`)
  }

  // Detect nested <details> (OPTION blocks don't nest) — flag, don't convert.
  if (/<details[^>]*>(?:(?!<\/details>)[\s\S])*?<details/i.test(body)) {
    flags.push('NESTED_DETAILS: nested <details> cannot map to OPTION blocks; convert this section manually')
  }

  // Convert each top-level <details>…<summary>LABEL</summary>…</details> into an OPTION block.
  body = body.replace(
    /<details[^>]*>\s*<summary>([\s\S]*?)<\/summary>([\s\S]*?)<\/details>/gi,
    (_m, label, content) => {
      const l = label.trim()
      // Trim one leading/trailing blank line pair from content for clean spacing.
      const inner = content.replace(/^\n+/, '\n').replace(/\n+$/, '\n')
      return `[OPTION BEGIN [${l}]]${inner}[OPTION END]`
    },
  )

  // Strip Discovery-Center layout comments (whole-line HTML comments like
  // "<!-- border; size:540px -->"). Preserve the description marker comment.
  body = body.replace(/^[ \t]*<!--(?!\s*description\b)[^>]*-->[ \t]*\n/gim, '')

  // Normalize image paths: ![alt](./x.png) -> ![alt](x.png); collect filenames.
  const images = []
  body = body.replace(/!\[([^\]]*)\]\(\.?\/?([^)]+)\)/g, (_m, alt, path) => {
    const file = path.trim()
    // Only collect repo-relative images (skip absolute http(s) URLs).
    if (!/^https?:\/\//i.test(file)) images.push(file)
    return `![${alt}](${file})`
  })

  // Lint: code fence opened with no language tag.
  if (/^```[ \t]*$/m.test(body)) {
    flags.push('FENCE_NO_LANG: a code fence has no language tag; add one (e.g. ```bash)')
  }

  return { body, flags, images: [...new Set(images)] }
}

export function precheck(fullMarkdown, slug, imagesOnDisk) {
  const problems = []
  const begins = (fullMarkdown.match(/\[OPTION BEGIN \[/g) || []).length
  const ends = (fullMarkdown.match(/\[OPTION END\]/g) || []).length
  if (begins !== ends) problems.push(`UNBALANCED_OPTIONS: ${begins} [OPTION BEGIN] vs ${ends} [OPTION END]`)

  const onDisk = new Set(imagesOnDisk)
  for (const m of fullMarkdown.matchAll(/!\[[^\]]*\]\(([^)]+)\)/g)) {
    const f = m[1].trim()
    if (!/^https?:\/\//i.test(f) && !onDisk.has(f)) problems.push(`MISSING_IMAGE: ${f} is referenced but not on disk`)
  }

  const h1s = (fullMarkdown.match(/^#\s+\S/gm) || []).length
  if (h1s !== 1) problems.push(`NO_H1: exactly one "# " H1 title is required (found ${h1s})`)

  if (!/^parser:\s*v2\s*$/m.test(fullMarkdown)) problems.push('NO_PARSER_V2: frontmatter must set parser: v2')

  if (slug !== slug.toLowerCase()) problems.push(`BAD_SLUG: slug "${slug}" must be lowercase`)

  return problems
}

// CLI usage:
//   node convert-body.mjs <source.md> <slug>
//     → JSON {body,flags,images} on stdout
//
//   node convert-body.mjs --precheck <full.md> <slug> <imagesDir>
//     → JSON string[] of problem messages on stdout (empty array = clean)
//     imagesDir is scanned with readdirSync for filenames (non-recursive).
if (import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/')) || import.meta.url === `file://${process.argv[1]}`) {
  const { readFileSync, readdirSync } = await import('node:fs')
  if (process.argv[2] === '--precheck') {
    const [, , , fullMdPath, slug, imagesDir] = process.argv
    const fullMarkdown = readFileSync(fullMdPath, 'utf-8')
    const imagesOnDisk = readdirSync(imagesDir)
    process.stdout.write(JSON.stringify(precheck(fullMarkdown, slug, imagesOnDisk)))
  } else {
    const [, , srcPath, slug] = process.argv
    const src = readFileSync(srcPath, 'utf-8')
    process.stdout.write(JSON.stringify(convertBody(src, slug)))
  }
}
