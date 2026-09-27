import MarkdownIt from 'markdown-it';

// Single, shared Markdown renderer for admin-authored descriptions (groups,
// missions — issue #121; events — issue #2296). Keeping one instance keeps the
// safety policy in exactly one place.
//
// `html: false` blocks raw HTML embeds (we never want a description to ship a
// <script>); markdown-it always escapes literal HTML when html is off. `breaks`
// turns single newlines into <br> so soft line breaks survive — authors expect
// this from the live preview. `linkify` auto-links bare URLs.
const md = new MarkdownIt({ html: false, breaks: true, linkify: true });

// Render Markdown safely. With html:false, markdown-it escapes raw HTML and
// emits only its own tag set, so the result is safe to drop into the page.
export function renderMarkdown(s) {
  return md.render(String(s ?? '')).trim();
}
