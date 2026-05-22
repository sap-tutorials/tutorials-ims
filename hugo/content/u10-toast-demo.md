---
title: "U10 toast demo"
description: "Demo page for ui5-toast step-completion feedback (U10 prototype)."
draft: false
---

# Step-completion toast (U10)

Click each "Mark step N complete" button below. A `ui5-toast` appears at the bottom
center with the per-step progress message ("Step 2 complete — 1 to go!"). When the
final step is marked, the toast becomes celebratory and a persistent
`ui5-message-strip` appears below the steps with a CTA to browse more tutorials.

The demo bypasses the `/completeStep` API call so it's runnable without the CAP
backend; the toast + CTA wiring it exercises is the same contract used by
`tutorial.ts:markDone`.

<div class="tutorial-steps">
  <section class="tutorial-step" id="step-1">
    <h3>Step 1 — Set up your environment</h3>
    <p>Install the SDK and create a workspace.</p>
    <button type="button" class="step-done-btn" data-step="1">Mark complete</button>
  </section>

  <section class="tutorial-step" id="step-2">
    <h3>Step 2 — Build something</h3>
    <p>Wire the data model and run a quick query.</p>
    <button type="button" class="step-done-btn" data-step="2">Mark complete</button>
  </section>

  <section class="tutorial-step" id="step-3">
    <h3>Step 3 — Ship it</h3>
    <p>Push to dev, smoke-test, and merge.</p>
    <button type="button" class="step-done-btn" data-step="3">Mark complete</button>
  </section>
</div>

<style>
.tutorial-step { padding: 1rem 1.25rem; margin: 0.75rem 0; border: 1px solid var(--sapList_BorderColor, #d9d9d9); border-radius: 0.5rem; }
.tutorial-step.completed { background: var(--sapInfobar_NonInteractive_Background, #f5fafe); }
.tutorial-step.completed h3::before { content: "✓ "; color: var(--sapPositiveColor, #107e3e); }
.step-done-btn { margin-top: 0.5rem; padding: 0.4rem 0.9rem; background: var(--sapButton_Emphasized_Background, #0a6ed1); color: var(--sapButton_Emphasized_TextColor, #fff); border: none; border-radius: 0.25rem; cursor: pointer; }
.step-done-btn[disabled] { opacity: 0.6; cursor: default; }
</style>

<script>
(function () {
  function showStepToast(text, durationMs) {
    var toast = document.getElementById('step-toast');
    if (!toast) return;
    toast.textContent = text;
    toast.duration = durationMs;
    // Race: synthetic clicks (and fast users) can fire before the esbuild
    // bundle upgrades <ui5-toast>. .show() is undefined until upgrade — wait.
    if (typeof toast.show === 'function') {
      toast.show();
    } else if (window.customElements) {
      window.customElements.whenDefined('ui5-toast').then(function () {
        if (typeof toast.show === 'function') toast.show();
      });
    }
  }
  function showCompletionCta() {
    var stepsRoot = document.querySelector('.tutorial-steps');
    if (!stepsRoot || stepsRoot.querySelector('.tutorial-completion-cta')) return;
    var strip = document.createElement('ui5-message-strip');
    strip.setAttribute('design', 'Positive');
    strip.className = 'tutorial-completion-cta';
    strip.appendChild(document.createTextNode('You’ve finished this tutorial. '));
    var link = document.createElement('a');
    link.href = '/tutorials/';
    link.textContent = 'Browse more tutorials →';
    strip.appendChild(link);
    stepsRoot.appendChild(strip);
  }
  document.addEventListener('click', function (e) {
    var btn = e.target.closest && e.target.closest('.step-done-btn');
    if (!btn || btn.disabled) return;
    var stepNum = btn.dataset.step;
    var step = btn.closest('.tutorial-step');
    if (step) step.classList.add('completed');
    btn.disabled = true;
    btn.textContent = 'Completed';
    var total = document.querySelectorAll('.tutorial-step').length;
    var completed = document.querySelectorAll('.tutorial-step.completed').length;
    if (total > 0 && completed >= total) {
      showStepToast('🎉 Tutorial complete!', 4000);
      showCompletionCta();
    } else {
      var remaining = total - completed;
      var tail = remaining === 1 ? '1 to go!' : remaining + ' to go!';
      showStepToast('Step ' + stepNum + ' complete — ' + tail, 3000);
    }
  });
})();
</script>
