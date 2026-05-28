// hugo-apps/src/shared/pip-types.ts
// Shared between tutorial-pip-launcher (main tab) and tutorial-pip (PiP window).
// Keep this file types-only — no runtime code, no imports beyond Vue types if needed.

export type PipMode = 'full' | 'controller';

export type StepPayload = {
  stepIndex: number;        // 1-based, matches data-step on .tutorial-step nodes
  heading: string;          // step H3 text content
  html: string;             // sanitized step body HTML (already sanitized by Hugo build)
};

export type PipSource = 'main' | 'pip';

type Envelope = { senderId: string; source: PipSource };

export type PipMessage = Envelope & (
  // Bootstrap data (steps, activeStep, mode) is passed synchronously to
  // mountPip() inside the PiP window — not over the channel. The orphan-window
  // recovery flow (pip:hello / pip:reattach / pip:init over channel) was cut
  // from scope; see spec §9 "Main tab reloads while PiP is open".
  | { type: 'pip:stepChange';  stepIndex: number }
  | { type: 'pip:complete';    stepIndex: number }
  | { type: 'pip:modeChange';  mode: PipMode }   // informational only — sent by PiP on manual toggle, no current receiver
  | { type: 'pip:themeChange'; theme: 'light' | 'dark' }
  | { type: 'pip:closed' }
);
