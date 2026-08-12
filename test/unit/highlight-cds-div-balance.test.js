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
});
