<!-- hugo-apps/src/tutorial-reset/TutorialReset.vue -->
<script setup lang="ts">
import { ref, onMounted } from 'vue';

interface Props {
  slug: string;
}

const props = defineProps<Props>();

// Whether to surface the reset button. We only show it AFTER the learner has
// completed every step of the tutorial — for partial-progress, "Reset" would
// imply nuking work they may not have intended to lose. The dataset.stepCount
// attribute is emitted on <html> by the Hugo tutorial layout (Task 21).
const showReset = ref(false);

// Dialog open state — bound to `<ui5-dialog open>`. v2.x of UI5 web
// components has `open` as a property (set true/false); the `:open` v-bind
// pattern works because Vue's prop-vs-attr coercion sets the property on
// the custom element when it exists.
const dialogOpen = ref(false);

// In-flight POST guard. While true the confirm button is disabled (via the
// v-bind={disabled: true} pattern — see comment on the button below).
const submitting = ref(false);

// Error message strip — surfaced when the POST fails. Two distinct copies:
//  - 429 → "You've reset progress too many times" (rate limit hit)
//  - other 4xx/5xx/network → generic "Couldn't reset progress" message
const errorMessage = ref<string | null>(null);

onMounted(async () => {
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
}

function closeDialog() {
  dialogOpen.value = false;
}

async function confirmReset() {
  if (submitting.value) return;
  submitting.value = true;
  errorMessage.value = null;
  try {
    const res = await fetch('/api/resetTutorialProgress', {
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
  <div class="tutorial-reset">
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

    <!-- ui5-dialog uses :open as a property (UI5 v2.x). Bound directly via
         :open here; Vue's prop-vs-attr coercion sets the property when the
         custom element exposes one. See feedback_ui5_dialog_open_property. -->
    <ui5-dialog
      :open="dialogOpen"
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
