# Experimental features

Two opt-in webcam features live under the **Tutorial preferences** gear in the header:

- **Eye-tracking auto-scroll** — the page scrolls down when you look near the bottom of the viewport for about half a second.
- **Hand-gesture step navigation** — show an open palm to the camera, then sweep left or right to go to the previous or next step.

Both features are **off by default** and require an explicit "Start camera" click each browser session.

## How they work

Camera frames are processed entirely on your device by Google's MediaPipe `tasks-vision` library, running in WebAssembly inside your browser. **No video, no images, and no derived data are sent to any server.** The detector outputs (a normalized gaze position, a swipe direction) drive page actions locally.

Eye-tracking estimates approximately where in the viewport you are looking by comparing the position of your iris to the corners of your eyes. It does not record gaze data. The detector simply asks "is gaze near the bottom of the screen for at least 600 ms?" and triggers a single scroll action when yes.

Hand-gesture navigation looks for an open palm and tracks its horizontal motion across frames. A fast sweep over a fraction of the camera frame triggers a click on the existing Previous / Next links.

## Privacy and control

- Camera processing is local. Nothing is uploaded.
- A persistent "Camera active" badge appears whenever the camera is in use, with a Stop button that always works.
- Closing the tab ends the camera session immediately.
- Your preference (the toggle position) is stored in `localStorage`. The active-camera state is stored in `sessionStorage` and dies with the tab.
- Disable a feature by toggling it off in the Tutorial preferences popover.

## Calibrate for best results

Both camera features work out of the box, but a quick one-time calibration makes
them noticeably more reliable for your camera, seating position, and screen. When
you first start a feature you'll be offered a short calibration; you can also run
it anytime from the **Calibrate** button in Tutorial preferences.

- **Eye-tracking:** press Begin, then slowly scan your eyes over the whole page,
  top to bottom, for about five seconds.
- **Hand gestures:** press Begin, then hold an open palm up and sweep it left and
  right a few times for about five seconds.

Calibration is optional — without it the features fall back to sensible defaults.
Your calibration is stored only in this browser and is never sent anywhere. These
remain experimental, hands-free conveniences, not assistive technologies.

## Not assistive technology

These are experimental input demos, not accessibility tools. People who rely on hands-free input every day have purpose-built options that work better and run system-wide:

- **macOS** Voice Control (System Settings → Accessibility) and Head Pointer.
- **Windows** Eye Control (Settings → Accessibility).
- Dedicated eye-tracker hardware (Tobii, EyeTech) and switch-access devices.

If you need consistent hands-free input across applications, please use one of those instead.

## Browser and device support

The features require a modern desktop browser with `getUserMedia`, `WebAssembly`, and `OffscreenCanvas`. They are **not** available on phones or tablets — coarse-pointer / narrow-viewport devices show a "desktop only" message.
