// Cartoonify style transfer for the selfie composer (#1520). Runs the
// self-hosted AnimeGANv2 face_paint_512_v2 ONNX model in-browser via
// onnxruntime-web — the same in-browser posture as imgly background removal.
// Lazy-imported so neither the runtime nor the model touch the page-load path.
// Fail-soft: ANY failure returns the input canvas unchanged.
//
// wasmPaths decision (#1520 Task 6):
//   The brief's template set `ort.env.wasm.wasmPaths = '/vendor/onnxruntime/'`
//   but Task 5 only vendored the ONNX model, NOT the ORT WASM binaries. Pointing
//   at a non-existent path causes every session.create() to 404-fail. Instead we
//   let onnxruntime-web resolve its own bundled WASM via Vite's asset pipeline —
//   Vite copies the .wasm / .mjs files from node_modules/onnxruntime-web/dist/
//   into the build output (served under /js/), and the ORT internal loader finds
//   them via import.meta.url-relative resolution. No CDN fetch occurs (package is
//   a local dep, no CDN URL hardcoded in ORT itself when bundled with Vite).
//   If a future task explicitly copies ORT binaries to a known served path, set
//   `ort.env.wasm.wasmPaths` to that path at that point.

const MODEL_URL = '/vendor/animegan/model.onnx'
const SIZE = 512 // model's fixed square I/O

let sessionPromise: Promise<unknown> | null = null

async function getSession(ort: typeof import('onnxruntime-web')) {
  if (!sessionPromise) {
    sessionPromise = ort.InferenceSession.create(MODEL_URL, {
      executionProviders: ['webgpu', 'wasm'],
    }).catch((e: unknown) => { sessionPromise = null; throw e })
  }
  return sessionPromise
}

export async function cartoonify(canvas: HTMLCanvasElement): Promise<HTMLCanvasElement> {
  try {
    const ort = await import('onnxruntime-web')
    const session = (await getSession(ort)) as import('onnxruntime-web').InferenceSession

    // Downscale the composite into a SIZE×SIZE working canvas.
    const work = document.createElement('canvas')
    work.width = SIZE; work.height = SIZE
    const wctx = work.getContext('2d')
    if (!wctx) return canvas
    wctx.drawImage(canvas, 0, 0, SIZE, SIZE)
    const { data } = wctx.getImageData(0, 0, SIZE, SIZE)

    // RGBA uint8 → planar RGB float32 in [-1,1], NCHW.
    const chw = new Float32Array(3 * SIZE * SIZE)
    const plane = SIZE * SIZE
    for (let i = 0; i < plane; i++) {
      chw[i] = data[i * 4] / 127.5 - 1
      chw[plane + i] = data[i * 4 + 1] / 127.5 - 1
      chw[2 * plane + i] = data[i * 4 + 2] / 127.5 - 1
    }
    const input = new ort.Tensor('float32', chw, [1, 3, SIZE, SIZE])
    const feeds: Record<string, unknown> = { [session.inputNames[0]]: input }
    const out = await session.run(feeds as never)
    const outTensor = out[session.outputNames[0]] as import('onnxruntime-web').Tensor
    const od = outTensor.data as Float32Array

    // Planar RGB float32 [-1,1] → RGBA uint8.
    const rgba = new Uint8ClampedArray(plane * 4)
    for (let i = 0; i < plane; i++) {
      rgba[i * 4] = (od[i] + 1) * 127.5
      rgba[i * 4 + 1] = (od[plane + i] + 1) * 127.5
      rgba[i * 4 + 2] = (od[2 * plane + i] + 1) * 127.5
      rgba[i * 4 + 3] = 255
    }
    wctx.putImageData(new ImageData(rgba, SIZE, SIZE), 0, 0)

    // Upscale the stylized result back onto a canvas of the input's dimensions.
    const outCanvas = document.createElement('canvas')
    outCanvas.width = canvas.width; outCanvas.height = canvas.height
    const octx = outCanvas.getContext('2d')
    if (!octx) return canvas
    octx.drawImage(work, 0, 0, canvas.width, canvas.height)
    return outCanvas
  } catch (e) {
    console.warn('[selfie] cartoonify failed; exporting without it', e)
    return canvas
  }
}
