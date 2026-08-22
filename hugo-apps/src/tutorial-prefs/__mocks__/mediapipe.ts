// Mock @mediapipe/tasks-vision for unit tests.
// Vite's transformation phase resolves imports even for dynamic await import()
// statements, so unit tests that import eye-tracking.ts need this stub.
export const FaceLandmarker = {};
export const FilesetResolver = {};
