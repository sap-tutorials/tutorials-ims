/**
 * Escapes Hugo template delimiters ({{ and }}) that appear outside of fenced code blocks.
 * Hugo interprets {{ as Go template syntax, so bare occurrences in markdown content
 * must be escaped to prevent build errors.
 *
 * Preserves Hugo shortcode syntax ({{% ... %}}, {{< ... >}}, {{< ... />}}).
 * Uses HTML character references: &#123;&#123; for {{ and &#125;&#125; for }}
 * Hugo passes these through to the rendered HTML where browsers display them as { and }.
 */
export function escapeHugoDelimiters(content: string): string {
  const lines = content.split('\n')
  let inCodeFence = false
  let fenceChar = ''
  let fenceLen = 0

  const result = lines.map(line => {
    if (inCodeFence) {
      const closeMatch = line.match(/^(\s*)(```+|~~~+)\s*$/)
      if (closeMatch && closeMatch[2].charAt(0) === fenceChar && closeMatch[2].length >= fenceLen) {
        inCodeFence = false
      }
      return line
    }

    const openMatch = line.match(/^(\s*)(```+|~~~+)(.*)$/)
    if (openMatch) {
      inCodeFence = true
      fenceChar = openMatch[2].charAt(0)
      fenceLen = openMatch[2].length
      return line
    }

    // Outside code fences: escape {{ and }} with HTML character references,
    // but preserve Hugo shortcode syntax ({{% ... %}}, {{< ... >}})
    // Strategy: temporarily replace shortcode delimiters, escape remaining, then restore
    return line
      .replace(/\{\{%/g, '\x00HUGO_OPEN_PCT\x00')
      .replace(/%\}\}/g, '\x00HUGO_CLOSE_PCT\x00')
      .replace(/\{\{</g, '\x00HUGO_OPEN_ANG\x00')
      .replace(/>\}\}/g, '\x00HUGO_CLOSE_ANG\x00')
      .replace(/\/>\}\}/g, '\x00HUGO_CLOSE_SELF\x00')
      .replace(/\{\{/g, '&#123;&#123;')
      .replace(/\}\}/g, '&#125;&#125;')
      .replace(/\x00HUGO_OPEN_PCT\x00/g, '{{%')
      .replace(/\x00HUGO_CLOSE_PCT\x00/g, '%}}')
      .replace(/\x00HUGO_OPEN_ANG\x00/g, '{{<')
      .replace(/\x00HUGO_CLOSE_ANG\x00/g, '>}}')
      .replace(/\x00HUGO_CLOSE_SELF\x00/g, '/>}}')
  })

  return result.join('\n')
}
