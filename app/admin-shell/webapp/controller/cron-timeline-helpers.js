// app/admin-shell/webapp/controller/cron-timeline-helpers.js
//
// #750: SVG ribbon builder for the Cron health tile's 24-hour timeline.
// Three exports:
//   - CATEGORY_COLORS  — frozen category → hex map (5 known + 1 fallback)
//   - categoryForJob   — pure function jobName → category slug
//   - buildTimelineSvg — pure function (jobs, opts) → SVG markup string
//
// Called by Board.controller.js _loadJobControls() after the chronological
// sort, with output placed into the jobControls JSONModel at /timelineHtml
// and rendered via <core:HTML content="{jobControls>/timelineHtml}"/> at
// app/admin-shell/webapp/view/Board.view.xml above the existing Table.
//
// Unit-tested in test/unit/admin-shell/cron-timeline-helpers.test.js.

sap.ui.define([], function () {
  'use strict';

  // Frozen so accidental client-side mutation can't drift the legend out
  // of sync with category assignments at runtime.
  var CATEGORY_COLORS = Object.freeze({
    fetch:   '#4078b8',  // fetch-{learning-journeys,blog-posts,discovery-missions,videos,api-docs,samples}
    cleanup: '#888888',  // cleanup, gc-external-content
    kg:      '#9a4dbb',  // extract-concepts, consolidate-concepts, embedding-reconciliation
    retry:   '#d29922',  // ngds-retry, account-merge, mail-retry
    secret:  '#3fb950',  // secret-expiry-check, homepage-link-health
    unknown: '#888888',  // fallback (alias of cleanup grey — distinct semantic)
  });

  /**
   * Classify a job by name into one of 5 categories (+ fallback). Pattern-
   * matching only — no DB lookup, no metadata cross-reference. New jobs
   * default to 'unknown' until they get a rule here.
   *
   * @param {string} jobName
   * @returns {'fetch'|'cleanup'|'kg'|'retry'|'secret'|'unknown'}
   */
  function categoryForJob(jobName) {
    if (typeof jobName !== 'string') return 'unknown';
    if (jobName.indexOf('fetch-') === 0) return 'fetch';
    if (jobName === 'cleanup' || jobName === 'gc-external-content') return 'cleanup';
    if (jobName.indexOf('concept') !== -1 || jobName.indexOf('embedding') !== -1) return 'kg';
    if (jobName.indexOf('retry') !== -1 || jobName.indexOf('merge') !== -1) return 'retry';
    if (jobName.indexOf('secret') !== -1 || jobName.indexOf('health') !== -1) return 'secret';
    return 'unknown';
  }

  /**
   * Humanize a future ISO timestamp into "in 1h 12m" / "in 45m" / "now".
   * Internal helper for rect tooltip text.
   */
  function _humanizeRelative(iso, nowMs) {
    var t = Date.parse(iso);
    if (isNaN(t)) return iso;
    var diff = Math.max(0, t - nowMs);
    if (diff < 60000) return 'now';
    var mins = Math.round(diff / 60000);
    if (mins < 60) return 'in ' + mins + 'm';
    var hrs = Math.floor(mins / 60);
    var remMins = mins % 60;
    return remMins === 0 ? 'in ' + hrs + 'h' : 'in ' + hrs + 'h ' + remMins + 'm';
  }

  /**
   * Build an inline SVG string for the 24-hour cron timeline ribbon.
   *
   * Geometry:
   *   - widthPx wide × heightPx tall (default 800 × 80)
   *   - Now marker at x=0 (vertical line)
   *   - Tick: 3 px wide × 14 px tall, vertically centered in the band
   *   - "Fires in next 24h: N" label top-right
   *
   * Tooltips: each tick has a <title> child for native browser hover.
   *
   * @param {Array<{jobName: string, nextRunsIso: string[]}>} jobs
   * @param {{now: Date, widthPx?: number, heightPx?: number}} opts
   * @returns {string}
   */
  function buildTimelineSvg(jobs, opts) {
    opts = opts || {};
    var now = opts.now || new Date();
    var nowMs = now.getTime();
    var widthPx = opts.widthPx || 800;
    var heightPx = opts.heightPx || 80;
    var horizonMs = 24 * 60 * 60 * 1000;

    var TICK_W = 3;
    var TICK_H = 14;
    var BAND_Y_CENTER = Math.round(heightPx * 0.55);  // ribbon band sits ~55% down
    var TICK_Y = BAND_Y_CENTER - Math.floor(TICK_H / 2);

    // Count and emit ticks
    var ticks = [];
    var totalFires = 0;
    (jobs || []).forEach(function (job) {
      var cat = categoryForJob(job.jobName);
      var color = CATEGORY_COLORS[cat] || CATEGORY_COLORS.unknown;
      (job.nextRunsIso || []).forEach(function (iso) {
        var t = Date.parse(iso);
        if (isNaN(t)) return;
        var dt = t - nowMs;
        // Clamp: negative → 0, beyond horizon → widthPx (defensive, see test).
        var ratio = Math.max(0, Math.min(1, dt / horizonMs));
        var x = Math.round(ratio * widthPx);
        ticks.push({
          x: x,
          fill: color,
          jobName: job.jobName,
          iso: iso,
        });
        totalFires++;
      });
    });

    var parts = [];
    parts.push('<svg xmlns="http://www.w3.org/2000/svg" width="' + widthPx +
               '" height="' + heightPx + '" viewBox="0 0 ' + widthPx + ' ' + heightPx +
               '" role="img" aria-label="Cron firings in the next 24 hours">');

    // Background ribbon band (light grey outline, no fill so test regex that
    // looks for `<rect ... fill="#XXXXXX"` only matches category-colored ticks).
    parts.push('<rect x="0" y="' + (BAND_Y_CENTER - 10) +
               '" width="' + widthPx + '" height="20" fill="none" stroke="#d5dadc" />');

    // Hour gridlines every 6 hours (0, 6, 12, 18, 24)
    for (var h = 0; h <= 24; h += 6) {
      var gx = Math.round((h / 24) * widthPx);
      parts.push('<line x1="' + gx + '" y1="' + (BAND_Y_CENTER - 12) +
                 '" x2="' + gx + '" y2="' + (BAND_Y_CENTER + 12) +
                 '" stroke="#d5dadc" stroke-width="1" />');
      var labelText = h === 0 ? '' : '+' + h + 'h';
      if (labelText) {
        parts.push('<text x="' + gx + '" y="' + (BAND_Y_CENTER + 28) +
                   '" font-size="10" fill="#515559" text-anchor="middle">' +
                   labelText + '</text>');
      }
    }

    // Tick rects (with <title> tooltips)
    for (var i = 0; i < ticks.length; i++) {
      var t = ticks[i];
      var x = Math.min(t.x, widthPx - TICK_W);
      parts.push('<rect x="' + x + '" y="' + TICK_Y +
                 '" width="' + TICK_W + '" height="' + TICK_H +
                 '" fill="' + t.fill + '">');
      parts.push('<title>' +
                 _xmlEscape(t.jobName + ' — ' + _humanizeRelative(t.iso, nowMs)) +
                 '</title>');
      parts.push('</rect>');
    }

    // "Now" marker line + label (left edge)
    parts.push('<line x1="0" y1="' + (BAND_Y_CENTER - 14) +
               '" x2="0" y2="' + (BAND_Y_CENTER + 14) +
               '" stroke="#0070f2" stroke-width="2" />');
    parts.push('<text x="4" y="' + (BAND_Y_CENTER - 16) +
               '" font-size="10" fill="#0070f2">Now</text>');

    // Fires-count label, top-right
    parts.push('<text x="' + (widthPx - 4) + '" y="14" font-size="11" ' +
               'fill="#515559" text-anchor="end">Fires in next 24h: ' + totalFires + '</text>');

    parts.push('</svg>');
    return parts.join('');
  }

  function _xmlEscape(s) {
    return String(s || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  return {
    CATEGORY_COLORS: CATEGORY_COLORS,
    categoryForJob: categoryForJob,
    buildTimelineSvg: buildTimelineSvg,
  };
});
