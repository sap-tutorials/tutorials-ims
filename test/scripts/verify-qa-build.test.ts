import { describe, it, expect } from 'vitest';
import { findForbiddenMarkers, stripScripts } from '../../scripts/verify-qa-build';

describe('verify-qa-build', () => {
  describe('stripScripts', () => {
    it('removes a single script tag', () => {
      const html = '<div>visible</div><script>const x = 1;</script><p>also visible</p>';
      expect(stripScripts(html)).toBe('<div>visible</div><p>also visible</p>');
    });

    it('removes a script tag with attributes', () => {
      const html = '<script type="module" defer>code</script>visible';
      expect(stripScripts(html)).toBe('visible');
    });

    it('removes multiple script tags', () => {
      const html = '<script>a</script>middle<script type="module">b</script>end';
      expect(stripScripts(html)).toBe('middle' + 'end');
    });

    it('handles multi-line script bodies', () => {
      const html = `<div>x</div><script>
        const a = 1;
        const b = 2;
      </script><p>y</p>`;
      expect(stripScripts(html)).toMatch(/<div>x<\/div>\s*<p>y<\/p>/);
    });

    it('case-insensitive on the script tag', () => {
      const html = '<SCRIPT>code</SCRIPT>visible';
      expect(stripScripts(html)).toBe('visible');
    });
  });

  describe('findForbiddenMarkers', () => {
    it('returns no markers on clean QA HTML', () => {
      const html = '<div>welcome to tutorial</div>';
      expect(findForbiddenMarkers(html)).toEqual([]);
    });

    it('flags forbidden markers in visible DOM', () => {
      const html = '<div id="op-sheet-mark">Mark Done</div>';
      expect(findForbiddenMarkers(html)).toContain('op-sheet-mark');
    });

    it('does NOT flag forbidden markers inside script tags (QA defensive references)', () => {
      // This is the regression case — u1-object-page.html line 580+ has an
      // inline script that calls getElementById("op-sheet-mark") even though
      // the DOM element is correctly QA-stripped via {{ if not site.Params.qa }}.
      const html = `<div>QA tutorial content</div>
        <script type="module">
          const markBtn = document.getElementById("op-sheet-mark");
          const tutorialSlug = document.querySelector("#tutorial-rating-mount")?.dataset.slug;
          const progressBar = document.getElementById("progress-bar");
        </script>`;
      expect(findForbiddenMarkers(html)).toEqual([]);
    });

    it('still flags markers when both visible AND in script', () => {
      // If QA somehow leaks the visible UI, we should still flag — the script-
      // tag whitelist is only for cases where the DOM is correctly absent.
      const html = `<div id="progress-bar">x</div><script>document.getElementById("progress-bar")</script>`;
      expect(findForbiddenMarkers(html)).toContain('progress-bar');
    });
  });
});
