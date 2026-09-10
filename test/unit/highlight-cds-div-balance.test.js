// test/unit/highlight-cds-div-balance.test.js
// #1657 regression: the CDS Shiki transform must not leak <div>s. Each CDS code
// block that lost one <div> ejected the tutorial right-rail out of the two-column
// grid on PROD. This guards div balance on the pure splice function.
import { describe, it, expect } from 'vitest';
import { replaceCdsBlocks } from '../../scripts/highlight-cds.ts';

// A single rendered CDS code block, minified exactly as render-codeblock.html +
// Hugo's Chroma `highlight` emit it: <div class=highlight><pre…>…</pre></div>
// nested in code-block-body / code-block. Balanced on its own (4 opens/4 closes).
const CDS_BLOCK =
  '<div class=code-block data-lang=cds>' +
    '<div class=code-block-header><span class=code-block-lang>CDS</span></div>' +
    '<div class=code-block-body>' +
      '<div class=highlight><pre tabindex=0 class=chroma><code>entity Foo { key ID : Integer; }</code></pre></div>' +
    '</div>' +
  '</div>';

// Shiki's codeToHtml returns a bare <pre> with NO wrapping div.
const shikiStub = () => '<pre class="shiki"><code>entity Foo { key ID : Integer; }</code></pre>';

// #2228: a LONG CDS block. render-codeblock.html sets $isLong when lineCount > 25,
// which adds ` data-collapsed=true` on the body div AND a <button class=code-block-toggle>
// after the body. Hugo --minify drops the attribute quotes. The old exact-string
// matcher `<div class=code-block-body>` could not match this body-open tag.
const CDS_BLOCK_LONG =
  '<div class=code-block code-block-long data-lang=cds>' +
    '<div class=code-block-header><span class=code-block-lang>CDS</span></div>' +
    '<div class=code-block-body data-collapsed=true>' +
      '<div class=highlight><pre tabindex=0 class=chroma><code>entity Foo { key ID : Integer; }</code></pre></div>' +
    '</div>' +
    '<button class=code-block-toggle>Show more</button>' +
  '</div>';

// A step content div, as tutorial-step shortcode renders per step.
const STEP_DIV = (n) => `<div id=step-${n} class=tutorial-step><h2>Step ${n}</h2><p>body ${n}</p></div>`;


const countDivs = (h) => ({
  open: (h.match(/<div\b/g) || []).length,
  close: (h.match(/<\/div>/g) || []).length,
});

describe('replaceCdsBlocks div balance (#1657)', () => {
  it('keeps <div> open/close balanced for one CDS block', () => {
    const { result, processedBlocks } = replaceCdsBlocks(CDS_BLOCK, shikiStub);
    expect(processedBlocks).toBe(1);
    const { open, close } = countDivs(result);
    expect(open, `<div> must stay balanced (got ${open} open / ${close} close)`).toBe(close);
  });

  it('stays balanced across 3 CDS blocks (the -3 PROD incident shape)', () => {
    const three = CDS_BLOCK + '<p>a</p>' + CDS_BLOCK + '<p>b</p>' + CDS_BLOCK;
    const { result, processedBlocks } = replaceCdsBlocks(three, shikiStub);
    expect(processedBlocks).toBe(3);
    const { open, close } = countDivs(result);
    expect(open, `3 blocks must stay balanced (got ${open}/${close})`).toBe(close);
  });

  it('splices Shiki output in place of the Chroma body', () => {
    const { result } = replaceCdsBlocks(CDS_BLOCK, shikiStub);
    expect(result).toContain('class="shiki"');
    expect(result).not.toContain('class=chroma');
  });

  it('processes a LONG collapsible block (#2228: data-collapsed body)', () => {
    const { result, processedBlocks } = replaceCdsBlocks(CDS_BLOCK_LONG, shikiStub);
    expect(processedBlocks, 'long-block body-open tag must be matched despite attributes').toBe(1);
    expect(result).toContain('class="shiki"');
    expect(result).not.toContain('class=chroma');
    // The toggle button must survive untouched.
    expect(result).toContain('code-block-toggle');
    const { open, close } = countDivs(result);
    expect(open, `long block must stay balanced (got ${open}/${close})`).toBe(close);
  });

  it('does NOT delete step divs between a long block and a later short block (#2228)', () => {
    // Shape of abap-environment-adt-coretools-vscode: a long CDS block inside an
    // early step, then several intervening step divs, then a short CDS block.
    // The old matcher jumped from the long block's unmatched body-open to the
    // short block's body far downstream and spliced away everything in between.
    const html =
      STEP_DIV(7) + CDS_BLOCK_LONG +
      STEP_DIV(8) + STEP_DIV(9) + STEP_DIV(10) + STEP_DIV(11) + STEP_DIV(12) + STEP_DIV(13) +
      STEP_DIV(14) + CDS_BLOCK;
    const { result, processedBlocks } = replaceCdsBlocks(html, shikiStub);
    expect(processedBlocks).toBe(2);
    for (const n of [7, 8, 9, 10, 11, 12, 13, 14]) {
      expect(result, `step-${n} div must survive`).toContain(`id=step-${n}`);
    }
    const { open, close } = countDivs(result);
    expect(open, `mixed blocks must stay balanced (got ${open}/${close})`).toBe(close);
  });
});
