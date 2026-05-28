import { createApp, h, reactive, ref } from 'vue';
import TutorialPrefsPopover from './TutorialPrefsPopover.vue';
import CameraBadge from './CameraBadge.vue';
import {
  getPref, setPref, getSession, removeSession,
  isFirstRun, consumeFirstRun
} from './prefs-store';
import { detectSupport } from './browser-support';
import { PAGE_KIND_TUTORIAL, KEY_READER, type FeatureId } from './constants';

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
    state.eyeRuntime = await runEyeTracking({
      reducedMotion: detectSupport().prefersReducedMotion,
      onError: (e) => {
        state.eyeError = 'Detection stopped unexpectedly. Try again later.';
        console.error('[tutorial-prefs] eye-tracking', e);
        stopEye(state);
      },
      onSlow: () => { state.slow = true; }
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
    state.handRuntime = await runHandGestures({
      onError: (e) => {
        state.handError = 'Detection stopped unexpectedly. Try again later.';
        console.error('[tutorial-prefs] hand-gestures', e);
        stopHand(state);
      },
      onSlow: () => { state.slow = true; }
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

function init() {
  const trigger = document.getElementById('sb-prefs');
  if (!trigger) return;
  const support = detectSupport();
  const onTutorial = document.documentElement.dataset.pageKind === PAGE_KIND_TUTORIAL;

  const state = reactive<State>({
    readerOn: document.documentElement.dataset.reader === 'on',
    eyePref: getPref('eye'),
    handPref: getPref('hand'),
    eyeRuntime: null,
    handRuntime: null,
    eyeError: '',
    handError: '',
    slow: false
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
      'onToggle-reader': () => toggleReader(state),
      'onToggle-pref': (f: FeatureId) => togglePref(state, f),
      onStart: (f: FeatureId) => f === 'eye' ? startEye(state) : startHand(state),
      onStop: (f: FeatureId) => f === 'eye' ? stopEye(state) : stopHand(state)
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
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init, { once: true });
} else {
  init();
}
