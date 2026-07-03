<!-- hugo-apps/src/tutorial-reset/TutorialReset.vue -->
<script setup lang="ts">
import { ref, onMounted, watch } from 'vue';
import { csrfFetch } from '@shared/csrf-fetch';

interface Props {
  slug: string;
}

const props = defineProps<Props>();

// Whether to surface the reset button. We only show it AFTER the learner has
// completed every step of the tutorial — for partial-progress, "Reset" would
// imply nuking work they may not have intended to lose. The dataset.stepCount
// attribute is emitted on <html> by the Hugo tutorial layout (Task 21).
const showReset = ref(false);

// Dialog open state — drives an imperative `.open` property write on the
// underlying <ui5-dialog> via the watcher below (NOT a template binding).
// UI5 web components treat the `open` attribute as presence-truthy — both
// `:open="dialogOpen"` and `v-bind="{ open: dialogOpen }"` render
// `<ui5-dialog open>` on first paint regardless of value (and Vue's
// prop-vs-attr decision for unknown elements often results in NEITHER
// attribute nor property being written reliably). Imperative `.open =
// true/false` on the actual element is what UI5 v2.x's reactive observer
// reads. See feedback_ui5_dialog_open_property +
// feedback_vue_ui5_boolean_attr_coercion. Same pattern as
// browse/controller.ts L178 (`(filterDrawer as any).open = true`).
const dialogOpen = ref(false);

// Component root ref — let Vue's reliable component-root mechanism give us
// a handle, then walk DOWN to the dialog via querySelector. Template refs
// on hoisted custom-element vnodes warn in Vue 3.5, and the callback-ref
// timing for unknown elements in some test envs is unstable.
const rootEl = ref<HTMLElement | null>(null);

function getDialogEl(): (HTMLElement & { open?: boolean }) | null {
  // Primary: scoped to this component instance via rootEl. Falls back to
  // a document-wide query if rootEl hasn't captured yet (e.g. during the
  // initial onMounted call on some test environments where Vue 3.5 hoists
  // and ref capture races with onMounted).
  const fromRoot = rootEl.value?.querySelector('ui5-dialog');
  if (fromRoot) return fromRoot as HTMLElement & { open?: boolean };
  // In production there's only one TutorialReset per page, so this is
  // unambiguous. Tests that mount multiple components in the same DOM
  // would need rootEl to work — they should.
  return document.querySelector('.tutorial-reset > ui5-dialog') as
    (HTMLElement & { open?: boolean }) | null;
}

watch(dialogOpen, (open) => {
  const el = getDialogEl();
  if (el) el.open = open;
});

// In-flight POST guard. While true the confirm button is disabled (via the
// v-bind={disabled: true} pattern — see comment on the button below).
const submitting = ref(false);

// Error message strip — surfaced when the POST fails. Two distinct copies:
//  - 429 → "You've reset progress too many times" (rate limit hit)
//  - other 4xx/5xx/network → generic "Couldn't reset progress" message
const errorMessage = ref<string | null>(null);

onMounted(async () => {
  // Belt-and-braces: ensure the dialog is closed at mount time regardless
  // of what UI5 might have inferred from initial attribute rendering. UI5
  // v2.x defaults `.open = false` but a stray attribute or earlier upgrade
  // could leave it truthy.
  const el = getDialogEl();
  if (el) el.open = false;

  // Read step-count from <html data-step-count="N"> (Task 21 emits this).
  // If the attribute is missing or malformed, default to a large number so
  // we never wrongly surface the reset button on incomplete progress.
  const stepCount = Number(document.documentElement.dataset.stepCount ?? '999');
  if (!Number.isFinite(stepCount) || stepCount <= 0) return;

  try {
    const res = await fetch(`/api/getProgress?slug=${encodeURIComponent(props.slug)}`, {
      credentials: 'include',
    });
    if (!res.ok) return;
    const data = await res.json();
    const completed: unknown = data?.completedSteps;
    const completedCount = Array.isArray(completed) ? completed.length : 0;
    if (completedCount >= stepCount) {
      showReset.value = true;
    }
  } catch {
    // Network / parse error — leave the button hidden. Don't surface a
    // failure UI for the read path; the user can still reload the page.
  }
});

function openDialog() {
  errorMessage.value = null;
  dialogOpen.value = true;
  // Belt-and-braces: also write imperatively so we don't depend on the
  // watcher's flush timing. The watcher above is the same write but on
  // a different schedule; this duplicate is cheap and idempotent.
  const el = getDialogEl();
  if (el) el.open = true;
}

function closeDialog() {
  dialogOpen.value = false;
  const el = getDialogEl();
  if (el) el.open = false;
}

async function confirmReset() {
  if (submitting.value) return;
  submitting.value = true;
  errorMessage.value = null;
  try {
    const res = await csrfFetch('/api/resetTutorialProgress', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ slug: props.slug }),
    });

    if (res.status === 200) {
      // SYNCHRONOUS BLOCK — Task 14 spec reviewer's hard requirement:
      // dispatch the CustomEvent + reload with no `await` between them, so
      // the localStorage cleanup listener (Task 21, wired inline in
      // head.html) runs before the page navigates away.
      document.dispatchEvent(new CustomEvent('tutorial-reset', {
        detail: { slug: props.slug },
      }));
      window.location.reload();
      return;
    }

    if (res.status === 429) {
      errorMessage.value = "You've reset progress too many times — please wait a few minutes and try again.";
      dialogOpen.value = false;
      return;
    }

    errorMessage.value = "Couldn't reset progress. Please try again in a moment.";
    dialogOpen.value = false;
  } catch {
    errorMessage.value = "Couldn't reset progress. Check your connection and try again.";
    dialogOpen.value = false;
  } finally {
    submitting.value = false;
  }
}

// Test hooks — only used by TutorialReset.test.ts. Mirrors the Validation
// island's `defineExpose` pattern (PR #235).
defineExpose({
  showReset,
  dialogOpen,
  submitting,
  errorMessage,
  openDialog,
  closeDialog,
  confirmReset,
});
</script>

<template>
  <div ref="rootEl" class="tutorial-reset">
    <!-- Rate-limit / error strip — always rendered above the button so a
         failed POST has somewhere to surface. The dialog closes first
         (closeDialog in confirmReset) so the strip is the only visible UX. -->
    <ui5-message-strip
      v-if="errorMessage"
      design="Negative"
      hide-close-button
      class="tutorial-reset__error"
    >
      {{ errorMessage }}
    </ui5-message-strip>

    <ui5-button
      v-if="showReset"
      design="Default"
      class="tutorial-reset__button"
      @click="openDialog"
    >
      Reset progress and try again
    </ui5-button>

    <!-- ui5-dialog `open` is set imperatively via the `watch(dialogOpen)`
         in <script setup> — NOT through a template binding. The watcher
         queries `rootEl > ui5-dialog` and writes `.open` on the element,
         which UI5 v2.x's reactive observer reads. The `close` event still
         fires when UI5 flips open=false (Esc / backdrop / explicit set),
         so we wire @close → closeDialog for that path too. -->
    <ui5-dialog
      header-text="Reset progress?"
      @close="closeDialog"
    >
      <p class="tutorial-reset__body">
        This will clear your completion record for this tutorial and
        you'll start again from step 1. Your other tutorials are unaffected.
      </p>
      <div slot="footer" class="tutorial-reset__footer">
        <ui5-button
          design="Transparent"
          v-bind="submitting ? { disabled: true } : {}"
          @click="closeDialog"
        >
          Cancel
        </ui5-button>
        <!-- design="Negative" — Horizon's deliberate-destructive-action cue.
             v-bind={disabled: true} (not :disabled="submitting") because UI5
             web components treat attribute *presence* as truthy regardless
             of value. See feedback_vue_ui5_boolean_attr_coercion + the
             Validation.vue Submit button comment. -->
        <ui5-button
          design="Negative"
          v-bind="submitting ? { disabled: true } : {}"
          @click="confirmReset"
        >
          Reset progress
        </ui5-button>
      </div>
    </ui5-dialog>
  </div>
</template>

<style scoped>
.tutorial-reset {
  margin: 1.5rem 0;
}
.tutorial-reset__button {
  margin-top: 0.5rem;
}
.tutorial-reset__body {
  margin: 0 0 0.5rem;
  line-height: 1.5;
}
.tutorial-reset__footer {
  display: flex;
  justify-content: flex-end;
  gap: 0.5rem;
  padding: 0.5rem 0;
}
.tutorial-reset__error {
  margin-bottom: 0.5rem;
}
</style>
