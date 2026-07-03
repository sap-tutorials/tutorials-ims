// srv/lib/help-docs/_strip-markdown.js
//
// Shared markdown/MDX text-stripper used by help-docs fetchers.
// Handles both .md (help-sap-com fallback, cap-cloud-sap) and .mdx
// (architecture-sap-com) input. Emits plain text suitable for
// LLM-embedding input, with fenced code, inline code, links, and MDX
// scaffolding removed.
//
// Extracted from cap-cloud-sap-fetcher.js to keep the two consumers in
// sync. Adding the JSX-component + top-import regexes here does NOT
// change output on pure .md input — Capitalized-first component names
// and top-of-file import lines do not appear in plain markdown.

export function stripMarkdown(md) {
  return String(md || '')
    .replace(/^import\s+[^\n]+\n/gm, ' ')                          // MDX top-of-file imports
    .replace(/<[A-Z][A-Za-z0-9]*[^>]*\/>/g, ' ')                    // self-closing MDX components
    .replace(/<[A-Z][A-Za-z0-9]*[^>]*>[\s\S]*?<\/[A-Z][A-Za-z0-9]*>/g, ' ')  // opening+closing MDX components
    .replace(/```[\s\S]*?```/g, ' ')                                // fenced code blocks
    .replace(/`[^`]*`/g, ' ')                                       // inline code
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')                        // links → text
    .replace(/[#>*_~`]/g, ' ')                                      // markdown syntax
    .replace(/\s+/g, ' ')
    .trim();
}
