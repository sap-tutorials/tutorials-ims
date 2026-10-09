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

  return { body, flags }
}

