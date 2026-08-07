// Self-hosted @imgly assets (no CDN — approuter CSP). Vendored by scripts/vendor-imgly.cjs.
export const IMGLY_PUBLIC_PATH = '/vendor/imgly/'

// Square export canvas — good default for social share.
export const STAGE_WIDTH = 1080
export const STAGE_HEIGHT = 1080

// Frame layering decision from Task 1 (inspect real assets, do not guess):
//   'overlay'    → advocate frame is a transparent PNG drawn IN FRONT of the user cutout
//   'background' → advocate frame is opaque; user cutout is drawn ON TOP
export const FRAME_LAYERING: 'overlay' | 'background' = 'overlay'
