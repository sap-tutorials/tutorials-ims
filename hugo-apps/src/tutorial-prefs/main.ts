import { createApp, h, reactive, ref } from 'vue';
import TutorialPrefsPopover from './TutorialPrefsPopover.vue';
import CameraBadge from './CameraBadge.vue';
import {
  getPref, setPref, getSession, removeSession,
  isFirstRun, consumeFirstRun,
  setHeaderPref, setFooterPref, setBreadcrumbsPref, setFeedbackPref,
  setTextSize as setTextSizePref, setReadWidth as setReadWidthPref,
  setCodeSize as setCodeSizePref, setCodeWrap as setCodeWrapPref,
  setCopyClean as setCopyCleanPref, setImgSize as setImgSizePref,
  setImgCollapse as setImgCollapsePref, setReduceMotion as setReduceMotionPref,
  setReadableFont as setReadableFontPref
} from './prefs-store';
import { readPrefs, computeEffective, isShortViewport, applyDisplayChrome, installAutoHide } from './display-chrome';
import { detectSupport } from './browser-support';
import { PAGE_KIND_TUTORIAL, KEY_READER, type FeatureId, type HeaderMode, type SizeStep, type ReadWidth } from './constants';
import '@ui5/webcomponents/dist/SegmentedButton.js';
import '@ui5/webcomponents/dist/SegmentedButtonItem.js';

interface Runtime { stop: () => void; }

interface State {
  readerOn: boolean;
  eyePref: 'on' | 'off';
  handPref: 'on' | 'off';
  eyeRuntime: Runtime | null;
  handRuntime: Runtime | null;
  eyeError: string;
  handError: string;
  slow: boolean;
  headerMode: HeaderMode;
  footerAutohide: boolean;
  breadcrumbsOn: boolean;
  feedbackOn: boolean;
  textSize: SizeStep; readWidth: ReadWidth; codeSize: SizeStep;
  codeWrap: boolean; copyClean: boolean; imgSize: SizeStep;
  imgCollapse: boolean; reduceMotion: boolean; readableFont: boolean;
}

// Lazy-loaded overlay handle (only when ?debug-cam is present). Held at
// module scope so eye + hand share one overlay instead of mounting twice.
let debugReporter: ((r: any) => void) | null = null;
async function ensureDebugReporter(): Promise<((r: any) => void) | null> {
  if (debugReporter) return debugReporter;
  if (typeof location === 'undefined' || !new URLSearchParams(location.search).has('debug-cam')) {
    return null;
  }
  const { createDebugOverlay } = await import('./cam-debug');
  const overlay = createDebugOverlay(true);
  if (!overlay) return null;
  debugReporter = overlay.report.bind(overlay);
  return debugReporter;
}

function unsupportedText(reasons: string[]): string {
  if (reasons.includes('mobile')) return 'Available on desktop browsers only.';
  if (reasons.length > 0) return "Your browser doesn't support this feature.";
  return '';
}

async function startEye(state: State): Promise<void> {
  state.eyeError = '';
  try {
    const { runEyeTracking } = await import('./eye-tracking');
    const onDebug = (await ensureDebugReporter()) ?? undefined;
    state.eyeRuntime = await runEyeTracking({
      reducedMotion: detectSupport().prefersReducedMotion,
      onError: (e) => {
        state.eyeError = 'Detection stopped unexpectedly. Try again later.';
        console.error('[tutorial-prefs] eye-tracking', e);
        stopEye(state);
      },
      onSlow: () => { state.slow = true; },
      onDebug
    });
    consumeFirstRun('eye');
    setPref('eye', 'on');
  } catch (err: any) {
    handleStartError(state, 'eye', err);
  }
}

function stopEye(state: State): void {
  state.eyeRuntime?.stop();
  state.eyeRuntime = null;
  removeSession('eye');
}

async function startHand(state: State): Promise<void> {
  state.handError = '';
  try {
    const { runHandGestures } = await import('./hand-gestures');
    const onDebug = (await ensureDebugReporter()) ?? undefined;
    state.handRuntime = await runHandGestures({
      onError: (e) => {
        state.handError = 'Detection stopped unexpectedly. Try again later.';
        console.error('[tutorial-prefs] hand-gestures', e);
        stopHand(state);
      },
      onSlow: () => { state.slow = true; },
      onDebug
    });
    consumeFirstRun('hand');
    setPref('hand', 'on');
  } catch (err: any) {
    handleStartError(state, 'hand', err);
  }
}

function stopHand(state: State): void {
  state.handRuntime?.stop();
  state.handRuntime = null;
  removeSession('hand');
}

function handleStartError(state: State, f: FeatureId, err: any): void {
  console.error('[tutorial-prefs] start', f, err);
  const msg =
    err?.name === 'NotAllowedError' ? 'Camera permission was denied. Allow the camera in your browser to use this feature.' :
    err?.name === 'NotFoundError' ? 'No camera detected on this device.' :
    /model|wasm|fetch/i.test(String(err?.message ?? '')) ? "Couldn't load the detection model. Reload the page and try again." :
    'Detection stopped unexpectedly. Try again later.';
  if (f === 'eye') state.eyeError = msg; else state.handError = msg;
  setPref(f, 'off');
}

function toggleReader(state: State) {
  state.readerOn = !state.readerOn;
  if (state.readerOn) document.documentElement.dataset.reader = 'on';
  else delete document.documentElement.dataset.reader;
  try { localStorage.setItem(KEY_READER, state.readerOn ? 'on' : 'off'); } catch {}
}

// Note: pref persisted only after a successful Start (see startEye/startHand).
// If user toggles on then dismisses without clicking Start, pref stays 'off'
// in localStorage even though the in-memory state is 'on' — intentional, so a
// permission denial doesn't leave the toggle visually-on next session.
function togglePref(state: State, f: FeatureId) {
  if (f === 'eye') {
    if (state.eyePref === 'on') { stopEye(state); state.eyePref = 'off'; setPref('eye', 'off'); }
    else { state.eyePref = 'on'; }
  } else {
    if (state.handPref === 'on') { stopHand(state); state.handPref = 'off'; setPref('hand', 'off'); }
    else { state.handPref = 'on'; }
  }
}

function setHeader(state: State, mode: HeaderMode) {
  setHeaderPref(mode);
  state.headerMode = mode;
  applyDisplayChrome();
}
function toggleFooter(state: State) {
  const next = state.footerAutohide ? 'shown' : 'autohide';
  setFooterPref(next);
  state.footerAutohide = next === 'autohide';
  applyDisplayChrome();
}
function toggleBreadcrumbs(state: State) {
  const next = state.breadcrumbsOn ? 'off' : 'on';
  setBreadcrumbsPref(next);
  state.breadcrumbsOn = next === 'on';
  applyDisplayChrome();
}
function toggleFeedback(state: State) {
  const next = state.feedbackOn ? 'off' : 'on';
  setFeedbackPref(next);
  state.feedbackOn = next === 'on';
  applyDisplayChrome();
}

function setTextSize(state: State, v: SizeStep) { setTextSizePref(v); state.textSize = v; applyDisplayChrome(); }
function setReadWidth(state: State, v: ReadWidth) { setReadWidthPref(v); state.readWidth = v; applyDisplayChrome(); }
function setCodeSize(state: State, v: SizeStep) { setCodeSizePref(v); state.codeSize = v; applyDisplayChrome(); }
function toggleCodeWrap(state: State) { const n = state.codeWrap ? 'off' : 'on'; setCodeWrapPref(n); state.codeWrap = n === 'on'; applyDisplayChrome(); }
function toggleCopyClean(state: State) { const n = state.copyClean ? 'off' : 'on'; setCopyCleanPref(n); state.copyClean = n === 'on'; /* no attr — read at copy time */ }
function setImgSize(state: State, v: SizeStep) { setImgSizePref(v); state.imgSize = v; applyDisplayChrome(); }
function toggleImgCollapse(state: State) { const n = state.imgCollapse ? 'off' : 'on'; setImgCollapsePref(n); state.imgCollapse = n === 'on'; applyDisplayChrome(); }
function toggleReduceMotion(state: State) { const n = state.reduceMotion ? 'off' : 'on'; setReduceMotionPref(n); state.reduceMotion = n === 'on'; applyDisplayChrome(); }
function toggleReadableFont(state: State) { const n = state.readableFont ? 'off' : 'on'; setReadableFontPref(n); state.readableFont = n === 'on'; applyDisplayChrome(); }

function init() {
  const trigger = document.getElementById('sb-prefs');
  if (!trigger) return;
  const support = detectSupport();
  const onTutorial = document.documentElement.dataset.pageKind === PAGE_KIND_TUTORIAL;

  const eff0 = computeEffective(readPrefs(), isShortViewport());

  const state = reactive<State>({
    readerOn: document.documentElement.dataset.reader === 'on',
    eyePref: getPref('eye'),
    handPref: getPref('hand'),
    eyeRuntime: null,
    handRuntime: null,
    eyeError: '',
    handError: '',
    slow: false,
    headerMode: eff0.header,
    footerAutohide: eff0.footer === 'autohide',
    breadcrumbsOn: eff0.breadcrumbs === 'on',
    feedbackOn: eff0.feedback === 'on',
    textSize: eff0.textSize, readWidth: eff0.readWidth, codeSize: eff0.codeSize,
    codeWrap: eff0.codeWrap === 'on', copyClean: eff0.copyClean === 'on',
    imgSize: eff0.imgSize, imgCollapse: eff0.imgCollapse === 'on',
    reduceMotion: eff0.reduceMotion === 'on', readableFont: eff0.readableFont === 'on'
  });

  const popoverHost = document.createElement('div');
  popoverHost.id = 'tut-prefs-popover-host';
  document.body.appendChild(popoverHost);

  const badgeHost = document.createElement('div');
  badgeHost.id = 'tut-prefs-badge-host';
  document.body.appendChild(badgeHost);

  const popoverRef = ref<any>(null);

  createApp({
    render: () => h(TutorialPrefsPopover, {
      ref: popoverRef,
      readerOn: state.readerOn,
      onTutorialPage: onTutorial,
      supported: support.supported,
      unsupportedReasonText: unsupportedText(support.reasons),
      eyePref: state.eyePref,
      handPref: state.handPref,
      eyeRunning: !!state.eyeRuntime,
      handRunning: !!state.handRuntime,
      eyeFirstRun: isFirstRun('eye'),
      handFirstRun: isFirstRun('hand'),
      eyeError: state.eyeError,
      handError: state.handError,
      headerMode: state.headerMode,
      footerAutohide: state.footerAutohide,
      breadcrumbsOn: state.breadcrumbsOn,
      feedbackOn: state.feedbackOn,
      textSize: state.textSize,
      readWidth: state.readWidth,
      codeSize: state.codeSize,
      codeWrap: state.codeWrap,
      copyClean: state.copyClean,
      imgSize: state.imgSize,
      imgCollapse: state.imgCollapse,
      reduceMotion: state.reduceMotion,
      readableFont: state.readableFont,
      'onToggle-reader': () => toggleReader(state),
      'onToggle-pref': (f: FeatureId) => togglePref(state, f),
      onStart: (f: FeatureId) => f === 'eye' ? startEye(state) : startHand(state),
      onStop: (f: FeatureId) => f === 'eye' ? stopEye(state) : stopHand(state),
      'onSet-header': (m: HeaderMode) => setHeader(state, m),
      'onToggle-footer': () => toggleFooter(state),
      'onToggle-breadcrumbs': () => toggleBreadcrumbs(state),
      'onToggle-feedback': () => toggleFeedback(state),
      'onSet-text-size': (v: SizeStep) => setTextSize(state, v),
      'onSet-read-width': (v: ReadWidth) => setReadWidth(state, v),
      'onSet-code-size': (v: SizeStep) => setCodeSize(state, v),
      'onToggle-code-wrap': () => toggleCodeWrap(state),
      'onToggle-copy-clean': () => toggleCopyClean(state),
      'onSet-img-size': (v: SizeStep) => setImgSize(state, v),
      'onToggle-img-collapse': () => toggleImgCollapse(state),
      'onToggle-reduce-motion': () => toggleReduceMotion(state),
      'onToggle-readable-font': () => toggleReadableFont(state)
    })
  }).mount(popoverHost);

  createApp({
    render: () => h(CameraBadge, {
      active: [
        ...(state.eyeRuntime ? ['eye' as FeatureId] : []),
        ...(state.handRuntime ? ['hand' as FeatureId] : [])
      ],
      slow: state.slow,
      onStop: () => { stopEye(state); stopHand(state); state.slow = false; }
    })
  }).mount(badgeHost);

  trigger.addEventListener('click', () => popoverRef.value?.open(trigger));

  if (onTutorial && support.supported) {
    const session = getSession();
    if (state.eyePref === 'on' && session.includes('eye')) startEye(state);
    if (state.handPref === 'on' && session.includes('hand')) startHand(state);
  }

  if (onTutorial) {
    applyDisplayChrome();
    installAutoHide();
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init, { once: true });
} else {
  init();
}
