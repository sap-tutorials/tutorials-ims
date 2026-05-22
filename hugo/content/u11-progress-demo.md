---
title: "U11 reading-progress demo"
description: "Demo for reading-progress bar + scrollspy TOC (U11 prototype)."
draft: false
---

# Reading-progress + scrollspy (U11)

This page demonstrates the two U11 surfaces:

1. **Top-of-viewport progress bar** — the thin Horizon-blue line at the very
   top of your browser window fills as you scroll through the steps below.
2. **Scrollspy TOC** — on a real tutorial page, the right-rail step TOC
   highlights the step nearest the top band of the viewport. This demo page
   doesn't render the TOC partial, but it logs the active step number to the
   document body for inspection.

Scroll down to see the bar fill. The bar is hidden until the steps section
overlaps the viewport, so it stays out of the way on overview content.

<div class="tutorial-steps" id="u11-demo-steps">
  <section class="tutorial-step" data-step="1">
    <h3>Step 1 — A long step</h3>
    <p>Lorem ipsum dolor sit amet, consectetur adipiscing elit. Pellentesque eget tincidunt urna, eget tincidunt urna. Praesent volutpat ipsum eu eros aliquet, vitae imperdiet velit dignissim. Aenean sit amet vehicula ipsum. Vivamus dictum, odio non lacinia commodo, neque metus tristique tortor, eget consequat dolor lacus a libero. Fusce non urna eget enim ullamcorper sodales.</p>
    <p>Curabitur a tellus a tortor pellentesque sodales. Sed sit amet nisl quis libero finibus tristique. Mauris vehicula, mauris a luctus pretium, lacus est mattis nibh, in lobortis ipsum tortor at libero. Vestibulum ante ipsum primis in faucibus orci luctus et ultrices posuere cubilia curae.</p>
    <p>Donec consectetur, justo non porta volutpat, augue magna ullamcorper sapien, sit amet tincidunt mi est ac eros. Vivamus venenatis fermentum nibh, in efficitur eros sodales sit amet. Suspendisse potenti. Nullam tristique magna a sapien ultricies, eget ultrices arcu varius.</p>
    <p>Quisque ut enim id arcu volutpat dignissim. Etiam aliquam, dolor at vestibulum interdum, urna magna sodales arcu, in sagittis tortor nibh ac risus. Aliquam erat volutpat. Sed condimentum nibh nec orci pulvinar, sit amet posuere tellus efficitur.</p>
  </section>

  <section class="tutorial-step" data-step="2">
    <h3>Step 2 — Another long step</h3>
    <p>Sed eu ipsum vel velit fermentum suscipit. Mauris luctus, lectus a tristique pharetra, est nibh fermentum eros, sed posuere ligula massa eu lacus. Praesent vitae lectus eget purus pharetra commodo nec eget metus. In tincidunt erat in libero euismod, sit amet bibendum eros tincidunt.</p>
    <p>Aenean elementum lacinia ligula, et auctor purus consectetur ac. Phasellus ut sapien et augue commodo egestas. In quis arcu vitae arcu suscipit pretium. Cras ultrices nibh ut consectetur tempus. Pellentesque non augue eget metus pulvinar pharetra.</p>
    <p>Donec id nibh tristique, fringilla velit a, lacinia est. Suspendisse fringilla mauris quis lacus pretium efficitur. Etiam pharetra dignissim ligula, eu condimentum dolor consectetur eget. Vivamus vehicula posuere lectus, sit amet pulvinar magna fermentum non.</p>
    <p>Mauris non orci nec lectus pulvinar tristique. Cras a dignissim ipsum. Phasellus consequat tellus eget purus venenatis, vel rhoncus arcu accumsan. Vestibulum ut purus ac arcu rhoncus auctor.</p>
  </section>

  <section class="tutorial-step" data-step="3">
    <h3>Step 3 — Final step</h3>
    <p>Quisque eu purus a sapien dictum tincidunt. Nullam aliquet, neque vitae fermentum gravida, est urna fringilla nisl, sed efficitur metus arcu non sapien. Maecenas nec dui non lectus rhoncus tincidunt. Nullam in lectus eu dolor varius bibendum.</p>
    <p>Vivamus eget urna mauris. Etiam vitae lectus et neque facilisis pharetra. Suspendisse potenti. Sed in turpis nec nibh feugiat tincidunt. Morbi consequat, ipsum et sodales fermentum, leo nibh feugiat sapien, eu pharetra dolor odio non turpis.</p>
    <p>Aenean accumsan vitae odio at faucibus. Donec sed semper urna. Sed et purus eu nibh consequat tincidunt. Quisque varius enim eget mauris fermentum, sit amet tincidunt enim hendrerit.</p>
    <p>Cras tristique, sapien ut imperdiet finibus, lectus orci tristique mauris, ac volutpat nibh purus a leo. Suspendisse a sapien sed neque sodales pretium.</p>
  </section>
</div>

<div id="u11-spy-status" style="position:fixed;right:0.75rem;bottom:0.75rem;padding:0.5rem 0.75rem;border:1px solid var(--sapList_BorderColor);background:var(--sapList_Background);border-radius:0.25rem;font-family:var(--sapFontMonospaceFamily, monospace);font-size:0.8125rem;z-index:50;">spy: idle</div>

<script>
(function () {
  // Observe the .step-toc-item active flips driven by tutorial.ts and mirror
  // them into a corner readout, so the demo can prove scrollspy works without
  // the right-rail TOC partial.
  var status = document.getElementById('u11-spy-status');
  if (!status) return;
  function mockTocItem(stepNum) {
    // tutorial.ts looks for .step-toc-item[data-toc-step="N"] — synthesize
    // hidden ones here so its querySelector finds something to mark active.
    var existing = document.querySelector('.step-toc-item[data-toc-step="' + stepNum + '"]');
    if (existing) return existing;
    var el = document.createElement('span');
    el.className = 'step-toc-item';
    el.style.display = 'none';
    el.setAttribute('data-toc-step', String(stepNum));
    document.body.appendChild(el);
    return el;
  }
  [1, 2, 3].forEach(mockTocItem);
  var mo = new MutationObserver(function () {
    var active = document.querySelector('.step-toc-item.active');
    var n = active && active.getAttribute('data-toc-step');
    status.textContent = 'spy: step ' + (n || '—');
  });
  document.querySelectorAll('.step-toc-item').forEach(function (item) {
    mo.observe(item, { attributes: true, attributeFilter: ['class'] });
  });
})();
</script>

<style>
.tutorial-step { padding: 1.25rem 1.5rem; margin: 1.5rem 0; border: 1px solid var(--sapList_BorderColor, #d9d9d9); border-radius: 0.5rem; }
.tutorial-step h3 { margin-top: 0; }
</style>
