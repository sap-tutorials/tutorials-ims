export function convertBody(source, slug) {
  const flags = []
  let body = source.replace(/\r\n/g, '\n')

  // Promote the first "## Title" to "# Title" and insert a description marker.
  // Match "## Title" followed by exactly one newline (so we can preserve blank lines after)
  const h2Match = body.match(/^##\s+([^\n]+)\n/)
  if (!h2Match) {
    flags.push('NO_TITLE: no leading "## " heading found; set the H1 title manually')
  } else {
    const title = h2Match[1]
    const descLine = '<!-- description --> TODO: one-sentence catalog description (REVIEW)'
    // Replace "## Title\n" with "# Title\n<!-- description -->\n"
    body = body.replace(h2Match[0], `# ${title}\n${descLine}\n`)
  }

  return { body, flags }
}

