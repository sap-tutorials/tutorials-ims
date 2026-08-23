# Experimental features

Two opt-in webcam features live under the **Tutorial preferences** gear in the header:

- **Eye-tracking auto-scroll** — after a one-time calibration, tilting your head/gaze down scrolls the page down and tilting up scrolls it back up (held for about half a second).
- **Hand-gesture step navigation** — show an open palm to the camera, then sweep left or right to move to the previous or next **step within the tutorial**.

Both features are **off by default** and require an explicit "Start camera" click each browser session.

## How they work

Camera frames are processed entirely on your device by Google's MediaPipe `tasks-vision` library, running in WebAssembly inside your browser. **No video, no images, and no derived data are sent to any server.** The detector outputs (a head-tilt amount, a swipe direction) drive page actions locally.

Eye-tracking measures how far you tilt your head/gaze up or down, relative to the resting position captured during calibration. It does not record gaze data. Tilt down past your calibrated range for about 600 ms and it scrolls the page down; tilt up and it scrolls back up.

Hand-gesture navigation looks for an open palm and tracks its horizontal motion across frames. A sweep over a fraction of the camera frame moves you to the previous or next step within the current tutorial.

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

- **Eye-tracking:** press Begin, then slowly look from the top of the page to the
  bottom and back for about five seconds, letting your head follow your gaze.
- **Hand gestures:** press Begin, then hold an open palm up and sweep it left and
  right a few times for about five seconds.

Hand gestures fall back to sensible defaults without calibration, but **eye-tracking
needs calibration** to learn your resting head position — until you calibrate, it
won't scroll. Your calibration is stored only in this browser and is never sent
anywhere. These remain experimental, hands-free conveniences, not assistive
technologies.

## Not assistive technology

These are experimental input demos, not accessibility tools. People who rely on hands-free input every day have purpose-built options that work better and run system-wide:

- **macOS** Voice Control (System Settings → Accessibility) and Head Pointer.
- **Windows** Eye Control (Settings → Accessibility).
- Dedicated eye-tracker hardware (Tobii, EyeTech) and switch-access devices.

If you need consistent hands-free input across applications, please use one of those instead.

## Browser and device support

The features require a modern desktop browser with `getUserMedia`, `WebAssembly`, and `OffscreenCanvas`. They are **not** available on phones or tablets — coarse-pointer / narrow-viewport devices show a "desktop only" message.
