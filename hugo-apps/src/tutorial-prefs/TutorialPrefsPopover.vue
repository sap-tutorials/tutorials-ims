<template>
  <ui5-popover ref="popoverRef" placement="Bottom" horizontal-align="End" hide-arrow header-text="Tutorial preferences">
    <div class="tut-prefs">
      <section class="tut-prefs__row">
        <label class="tut-prefs__label">
          <span>Reader mode <span class="tut-prefs__hint">(f)</span></span>
          <ui5-switch :checked="readerOn || undefined" @change="$emit('toggle-reader')"></ui5-switch>
        </label>
        <p class="tut-prefs__desc">Hide chrome and focus on the content.</p>
      </section>

      <template v-if="onTutorialPage">
        <hr class="tut-prefs__sep" />
        <p class="tut-prefs__group-label">Experimental</p>

        <section class="tut-prefs__row">
          <label class="tut-prefs__label">
            <span>Eye-tracking auto-scroll</span>
            <ui5-switch
              :checked="eyePref === 'on' || undefined"
              :disabled="!supported || undefined"
              @change="$emit('toggle-pref', 'eye')"
            ></ui5-switch>
          </label>
          <p class="tut-prefs__desc">
            Uses your webcam. The page scrolls down when you look near the bottom for about half a second. Stays running until you stop it or close the tab.
          </p>
          <template v-if="eyePref === 'on' && supported">
            <ui5-button v-if="eyeRunning" design="Transparent" @click="$emit('stop', 'eye')">Stop camera</ui5-button>
            <ui5-button v-else @click="$emit('start', 'eye')">Start camera</ui5-button>
            <p v-if="eyeRunning" class="tut-prefs__state">
              Look at the bottom of the page for half a second to scroll.
            </p>
            <p v-else-if="eyeFirstRun" class="tut-prefs__nudge">
              Press <strong>Start camera</strong> to try it.
            </p>
            <p v-if="eyeError" class="tut-prefs__error">{{ eyeError }}</p>
          </template>
        </section>

        <hr class="tut-prefs__sep" />

        <section class="tut-prefs__row">
          <label class="tut-prefs__label">
            <span>Hand-gesture step nav</span>
            <ui5-switch
              :checked="handPref === 'on' || undefined"
              :disabled="!supported || undefined"
              @change="$emit('toggle-pref', 'hand')"
            ></ui5-switch>
          </label>
          <p class="tut-prefs__desc">
            Uses your webcam. Hold an open palm to the camera, then sweep left or right to go to the previous or next step.
          </p>
          <template v-if="handPref === 'on' && supported">
            <ui5-button v-if="handRunning" design="Transparent" @click="$emit('stop', 'hand')">Stop camera</ui5-button>
            <ui5-button v-else @click="$emit('start', 'hand')">Start camera</ui5-button>
            <p v-if="handRunning" class="tut-prefs__state">
              Show an open palm, then sweep left or right.
            </p>
            <p v-else-if="handFirstRun" class="tut-prefs__nudge">
              Press <strong>Start camera</strong> to try it.
            </p>
            <p v-if="handError" class="tut-prefs__error">{{ handError }}</p>
          </template>
        </section>

        <p v-if="!supported" class="tut-prefs__unsupported">
          {{ unsupportedReasonText }}
        </p>
      </template>

      <hr class="tut-prefs__sep" />
      <p class="tut-prefs__footer">
        Camera processing happens entirely in your browser. Nothing is sent to a server.
        <a href="/end-users/experimental-features" target="_blank" rel="noopener">Learn more</a>
      </p>
    </div>
  </ui5-popover>
</template>

<script setup lang="ts">
import { ref } from 'vue';
import type { FeatureId } from './constants';

defineProps<{
  readerOn: boolean;
  onTutorialPage: boolean;
  supported: boolean;
  unsupportedReasonText: string;
  eyePref: 'on' | 'off';
  handPref: 'on' | 'off';
  eyeRunning: boolean;
  handRunning: boolean;
  eyeFirstRun: boolean;
  handFirstRun: boolean;
  eyeError: string;
  handError: string;
}>();
defineEmits<{
  (e: 'toggle-reader'): void;
  (e: 'toggle-pref', f: FeatureId): void;
  (e: 'start', f: FeatureId): void;
  (e: 'stop', f: FeatureId): void;
}>();

const popoverRef = ref<HTMLElement | null>(null);
defineExpose({
  open(opener: HTMLElement) {
    (popoverRef.value as any).opener = opener;
    (popoverRef.value as any).open = true;
  },
  close() { if (popoverRef.value) (popoverRef.value as any).open = false; }
});
</script>

<style>
.tut-prefs { padding: 0.5rem 0.75rem; min-width: 22rem; }
.tut-prefs__row { padding: 0.25rem 0; }
.tut-prefs__label { display: flex; align-items: center; justify-content: space-between; gap: 1rem; font-weight: 600; }
.tut-prefs__hint { font-weight: 400; opacity: 0.6; margin-left: 0.25rem; }
.tut-prefs__desc { margin: 0.25rem 0 0.5rem; opacity: 0.85; font-size: 0.9em; }
.tut-prefs__group-label { font-size: 0.8em; text-transform: uppercase; opacity: 0.6; margin: 0.5rem 0 0.25rem; }
.tut-prefs__sep { border: none; border-top: 1px solid var(--sapList_BorderColor, #e0e0e0); margin: 0.5rem 0; }
.tut-prefs__state { font-size: 0.85em; opacity: 0.8; margin: 0.5rem 0 0; }
.tut-prefs__nudge { font-size: 0.85em; color: var(--sapInformativeTextColor, #0070f2); margin: 0.5rem 0 0; }
.tut-prefs__error { font-size: 0.85em; color: var(--sapNegativeTextColor, #b00); margin: 0.5rem 0 0; }
.tut-prefs__unsupported { font-size: 0.85em; opacity: 0.7; margin: 0.5rem 0 0; }
.tut-prefs__footer { font-size: 0.8em; opacity: 0.7; margin: 0.5rem 0 0; }
</style>
