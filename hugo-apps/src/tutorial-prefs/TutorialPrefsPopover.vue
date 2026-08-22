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
        <p class="tut-prefs__group-label">Display</p>

        <section class="tut-prefs__row">
          <label class="tut-prefs__label"><span>Header</span></label>
          <ui5-segmented-button ref="segBtnRef" @selection-change="onHeaderSelect">
            <ui5-segmented-button-item :pressed="headerMode === 'locked' || undefined" data-mode="locked">Locked</ui5-segmented-button-item>
            <ui5-segmented-button-item :pressed="headerMode === 'thinbar' || undefined" data-mode="thinbar">Compact</ui5-segmented-button-item>
            <ui5-segmented-button-item :pressed="headerMode === 'autohide' || undefined" data-mode="autohide">Auto-hide</ui5-segmented-button-item>
          </ui5-segmented-button>
          <p class="tut-prefs__desc">Reduce the space the sticky title bar uses while you read.</p>
        </section>

        <section class="tut-prefs__row">
          <label class="tut-prefs__label">
            <span>Auto-hide footer</span>
            <ui5-switch :checked="footerAutohide || undefined" @change="$emit('toggle-footer')"></ui5-switch>
          </label>
        </section>

        <section class="tut-prefs__row">
          <label class="tut-prefs__label">
            <span>Show breadcrumbs</span>
            <ui5-switch data-testid="tut-prefs-breadcrumbs-switch" :checked="breadcrumbsOn || undefined" @change="$emit('toggle-breadcrumbs')"></ui5-switch>
          </label>
        </section>

        <section class="tut-prefs__row">
          <label class="tut-prefs__label">
            <span>Show discussion section</span>
            <ui5-switch data-testid="tut-prefs-discussion-switch" :checked="feedbackOn || undefined" @change="$emit('toggle-feedback')"></ui5-switch>
          </label>
        </section>

        <hr class="tut-prefs__sep" />
        <p class="tut-prefs__group-label">Text</p>
        <section class="tut-prefs__row">
          <label class="tut-prefs__label"><span>Text size</span></label>
          <ui5-segmented-button data-testid="tut-prefs-text-size" @selection-change="onSizeSelect('set-text-size', $event)">
            <ui5-segmented-button-item :pressed="textSize === 's' || undefined" data-size="s">Small</ui5-segmented-button-item>
            <ui5-segmented-button-item :pressed="textSize === 'm' || undefined" data-size="m">Medium</ui5-segmented-button-item>
            <ui5-segmented-button-item :pressed="textSize === 'l' || undefined" data-size="l">Large</ui5-segmented-button-item>
          </ui5-segmented-button>
        </section>
        <section class="tut-prefs__row">
          <label class="tut-prefs__label"><span>Reading width</span></label>
          <ui5-segmented-button @selection-change="onWidthSelect">
            <ui5-segmented-button-item :pressed="readWidth === 'full' || undefined" data-width="full">Full</ui5-segmented-button-item>
            <ui5-segmented-button-item :pressed="readWidth === 'narrow' || undefined" data-width="narrow">Narrow</ui5-segmented-button-item>
          </ui5-segmented-button>
        </section>

        <hr class="tut-prefs__sep" />
        <p class="tut-prefs__group-label">Code</p>
        <section class="tut-prefs__row">
          <label class="tut-prefs__label"><span>Code size</span></label>
          <ui5-segmented-button data-testid="tut-prefs-code-size" @selection-change="onSizeSelect('set-code-size', $event)">
            <ui5-segmented-button-item :pressed="codeSize === 's' || undefined" data-size="s">Small</ui5-segmented-button-item>
            <ui5-segmented-button-item :pressed="codeSize === 'm' || undefined" data-size="m">Medium</ui5-segmented-button-item>
            <ui5-segmented-button-item :pressed="codeSize === 'l' || undefined" data-size="l">Large</ui5-segmented-button-item>
          </ui5-segmented-button>
        </section>
        <section class="tut-prefs__row">
          <label class="tut-prefs__label"><span>Wrap long lines</span>
            <ui5-switch data-testid="tut-prefs-code-wrap" :checked="codeWrap || undefined" @change="$emit('toggle-code-wrap')"></ui5-switch>
          </label>
        </section>
        <section class="tut-prefs__row">
          <label class="tut-prefs__label"><span>Copy without prompt ($, &gt;)</span>
            <ui5-switch data-testid="tut-prefs-copy-clean" :checked="copyClean || undefined" @change="$emit('toggle-copy-clean')"></ui5-switch>
          </label>
        </section>

        <hr class="tut-prefs__sep" />
        <p class="tut-prefs__group-label">Screenshots</p>
        <section class="tut-prefs__row">
          <label class="tut-prefs__label"><span>Screenshot size</span></label>
          <ui5-segmented-button data-testid="tut-prefs-img-size" @selection-change="onSizeSelect('set-img-size', $event)">
            <ui5-segmented-button-item :pressed="imgSize === 's' || undefined" data-size="s">Small</ui5-segmented-button-item>
            <ui5-segmented-button-item :pressed="imgSize === 'm' || undefined" data-size="m">Medium</ui5-segmented-button-item>
            <ui5-segmented-button-item :pressed="imgSize === 'l' || undefined" data-size="l">Large</ui5-segmented-button-item>
          </ui5-segmented-button>
          <p class="tut-prefs__desc">Click any screenshot to open it full-size.</p>
        </section>
        <section class="tut-prefs__row">
          <label class="tut-prefs__label"><span>Collapse screenshots</span>
            <ui5-switch data-testid="tut-prefs-img-collapse" :checked="imgCollapse || undefined" @change="$emit('toggle-img-collapse')"></ui5-switch>
          </label>
        </section>

        <hr class="tut-prefs__sep" />
        <p class="tut-prefs__group-label">Accessibility</p>
        <section class="tut-prefs__row">
          <label class="tut-prefs__label"><span>Reduce motion</span>
            <ui5-switch data-testid="tut-prefs-reduce-motion" :checked="reduceMotion || undefined" @change="$emit('toggle-reduce-motion')"></ui5-switch>
          </label>
        </section>
        <section class="tut-prefs__row">
          <label class="tut-prefs__label"><span>Easier-to-read font</span>
            <ui5-switch data-testid="tut-prefs-readable-font" :checked="readableFont || undefined" @change="$emit('toggle-readable-font')"></ui5-switch>
          </label>
        </section>

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
        <a href="https://sap-tutorials.github.io/tutorials-ims/end-users/experimental-features" target="_blank" rel="noopener" aria-label="Learn more about experimental features">Learn more</a>
      </p>
    </div>
  </ui5-popover>
</template>

<script setup lang="ts">
import { ref, onMounted, watch, nextTick } from 'vue';
import type { FeatureId, HeaderMode, SizeStep, ReadWidth } from './constants';

const props = defineProps<{
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
  headerMode: HeaderMode;
  footerAutohide: boolean;
  breadcrumbsOn: boolean;
  feedbackOn: boolean;
  textSize: SizeStep;
  readWidth: ReadWidth;
  codeSize: SizeStep;
  codeWrap: boolean;
  copyClean: boolean;
  imgSize: SizeStep;
  imgCollapse: boolean;
  reduceMotion: boolean;
  readableFont: boolean;
}>();
const emit = defineEmits<{
  (e: 'toggle-reader'): void;
  (e: 'toggle-pref', f: FeatureId): void;
  (e: 'start', f: FeatureId): void;
  (e: 'stop', f: FeatureId): void;
  (e: 'set-header', mode: HeaderMode): void;
  (e: 'toggle-footer'): void;
  (e: 'toggle-breadcrumbs'): void;
  (e: 'toggle-feedback'): void;
  (e: 'set-text-size', size: SizeStep): void;
  (e: 'set-read-width', width: ReadWidth): void;
  (e: 'set-code-size', size: SizeStep): void;
  (e: 'toggle-code-wrap'): void;
  (e: 'toggle-copy-clean'): void;
  (e: 'set-img-size', size: SizeStep): void;
  (e: 'toggle-img-collapse'): void;
  (e: 'toggle-reduce-motion'): void;
  (e: 'toggle-readable-font'): void;
}>();

function onHeaderSelect(e: any) {
  const mode = e.detail?.selectedItems?.[0]?.dataset?.mode
    ?? e.target?.querySelector('[pressed]')?.dataset?.mode;
  // Guard: skip emit when mode matches current pref (e.g. sync click on mount)
  if (mode && mode !== props.headerMode) emit('set-header', mode as HeaderMode);
}

function onSizeSelect(event: 'set-text-size' | 'set-code-size' | 'set-img-size', e: any) {
  const size = e.detail?.selectedItems?.[0]?.dataset?.size;
  if (size === 's' || size === 'm' || size === 'l') emit(event, size as SizeStep);
}
function onWidthSelect(e: any) {
  const w = e.detail?.selectedItems?.[0]?.dataset?.width;
  if (w === 'full' || w === 'narrow') emit('set-read-width', w as ReadWidth);
}

// ui5-segmented-button manages selection internally and ignores attribute/property
// mutations on child items after its initial upgrade. The only reliable way to
// correct the highlighted item is to programmatically .click() the target item,
// which triggers UI5's own selection-change path. Read the button's real selection
// via `selectedItems` (NOT a child's `pressed` property — that mirrors Vue's
// declarative binding and can disagree with UI5's internal state). Runs on mount +
// on prop change so the correct item is highlighted whenever the popover (re)opens.
const segBtnRef = ref<any>(null);
function syncHeaderPressed() {
  const seg = segBtnRef.value;
  if (!seg) return;
  const current = seg.selectedItems?.[0]?.dataset?.mode;
  if (current === props.headerMode) return; // already correct — no redundant click
  const target = Array.from(
    seg.querySelectorAll('[data-mode]') as NodeListOf<HTMLElement>
  ).find(item => item.dataset.mode === props.headerMode);
  target?.click();
}
onMounted(() => nextTick(syncHeaderPressed));
watch(() => props.headerMode, () => nextTick(syncHeaderPressed));

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
