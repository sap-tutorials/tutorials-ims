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
  | { type: 'pip:init';        steps: StepPayload[]; activeStep: number; mode: PipMode }
  | { type: 'pip:hello' }
  | { type: 'pip:reattach' }
  | { type: 'pip:stepChange';  stepIndex: number }
  | { type: 'pip:complete';    stepIndex: number }
  | { type: 'pip:modeChange';  mode: PipMode }
  | { type: 'pip:themeChange'; theme: 'light' | 'dark' }
  | { type: 'pip:closed' }
);
