import { describe, it, expect } from 'vitest';
import {
  findForbiddenMarkers,
  stripScripts,
  markerAppearsAsAttribute,
} from '../../scripts/verify-qa-build';

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
      expect(stripScripts(html)).toBe('middleend');
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

  describe('markerAppearsAsAttribute', () => {
    it('matches id="X" with double quotes', () => {
      expect(markerAppearsAsAttribute('<div id="op-sheet-mark">', 'op-sheet-mark')).toBe(true);
    });

    it("matches id='X' with single quotes", () => {
      expect(markerAppearsAsAttribute("<div id='op-sheet-mark'>", 'op-sheet-mark')).toBe(true);
    });

    it('matches class="X" as full class', () => {
      expect(markerAppearsAsAttribute('<div class="progress-bar">', 'progress-bar')).toBe(true);
    });

    it('matches class="...X..." as one token in space-separated list', () => {
      expect(markerAppearsAsAttribute('<div class="foo progress-bar bar">', 'progress-bar')).toBe(true);
    });

    it('does NOT match compound class containing the marker', () => {
      // class="nav-progress-bar" should not match "progress-bar"
      expect(markerAppearsAsAttribute('<div class="nav-progress-bar">', 'progress-bar')).toBe(false);
    });

    it('does NOT match arbitrary URL substring', () => {
      expect(markerAppearsAsAttribute('<img src="progress-bars-1.png">', 'progress-bar')).toBe(false);
    });

    it('does NOT match prose substring', () => {
      expect(markerAppearsAsAttribute('<p>Set up a leaderboard for your event</p>', 'leaderboard')).toBe(false);
    });
  });

  describe('findForbiddenMarkers', () => {
    it('returns no markers on clean QA HTML', () => {
      expect(findForbiddenMarkers('<div>welcome</div>')).toEqual([]);
    });

    it('flags real DOM id', () => {
      expect(findForbiddenMarkers('<div id="op-sheet-mark">x</div>')).toContain('op-sheet-mark');
    });

    it('flags real DOM class', () => {
      expect(findForbiddenMarkers('<div class="progress-bar">x</div>')).toContain('progress-bar');
    });

    it('does NOT flag inside script tags', () => {
      const html = `<div>QA tutorial</div><script>
        const markBtn = document.getElementById("op-sheet-mark");
        const tutorialSlug = document.querySelector("#tutorial-rating-mount")?.dataset.slug;
        const progressBar = document.getElementById("progress-bar");
      </script>`;
      expect(findForbiddenMarkers(html)).toEqual([]);
    });

    it('does NOT flag prose mentioning the markers', () => {
      // Regression case from rebuild-content-qa.yml run #27885050471:
      // ai-core-genaihub-evaluation-quickstart has "leaderboard" in body text.
      const html = '<p>Set up a leaderboard to track participants</p>';
      expect(findForbiddenMarkers(html)).toEqual([]);
    });

    it('does NOT flag image filename containing marker substring', () => {
      // Regression case: btp-cockpit-cf-understanding-spaces has
      // <img src="...progress-bars-1.png"> which previously tripped progress-bar.
      const html = '<img src="https://example.com/progress-bars-1.png">';
      expect(findForbiddenMarkers(html)).toEqual([]);
    });

    it('does NOT flag compound class names containing marker', () => {
      // class="nav-progress-bar" should not match "progress-bar" because
      // it's not a complete whitespace-separated class token.
      const html = '<ui5-progress-indicator class="nav-progress-bar"></ui5-progress-indicator>';
      expect(findForbiddenMarkers(html)).toEqual([]);
    });

    it('still flags markers when both visible AND in script', () => {
      const html = '<div id="progress-bar">x</div><script>document.getElementById("progress-bar")</script>';
      expect(findForbiddenMarkers(html)).toContain('progress-bar');
    });
  });
});
