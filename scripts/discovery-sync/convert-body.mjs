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

  return { body, flags }
}

