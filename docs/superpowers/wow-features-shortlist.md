# "Wow, browsers can do that?" — Feature Shortlist

Working backlog of end-user-facing capabilities for the tutorial platform. Each entry is a candidate for its own brainstorm → spec → plan cycle.

Ordering reflects rough impact/effort, not commitment. First pick: **Document PiP step window** (in-flight as of 2026-05-28).

## Capability shocks

- **Pyodide — run real Python (and agents) in the page.** Boot a full CPython 3.12 runtime compiled to WebAssembly via [pyodide.org](https://pyodide.org). The agent-tutorial track's headline capability: real Python, real package install, real LLM API calls, no `pip install` instructions, no venv, no `.env` file.
  - **What learners see.** Two-pane embed: Monaco (Python source, top) + output panel (bottom — text, matplotlib charts, or a custom widget area). A "Run" button executes the cell; subsequent cells share state by default so a multi-step tutorial accumulates a workspace, the way a real notebook does. No terminal — Python isn't shelling out to anything, so there's nothing for the learner to type into.
  - **Stacks it covers.** Anything single-process and Python-shaped: **agent tutorials** (`openai`, `anthropic`, `langchain` clients all install and call out via the browser's `fetch`), **data/AI walkthroughs** (numpy, pandas, scikit-learn, matplotlib are pre-built and load on demand), **scripting against SAP APIs** (`requests`-style calls to BTP destinations, parsing OData responses), and **prompt-engineering exercises** where the page itself is the dev environment. Pairs especially well with Joule and SAP AI Core tutorials. **Does not** cover CAP / UI5 / Fiori — those need a Node runtime in the page, which is not on the roadmap (see Considered and rejected below).
  - **Hard constraints.**
    - **No filesystem persistence by default.** Pyodide has an in-memory MEMFS; refresh the page and the workspace is gone. For multi-page tutorials we'd need to serialize state to IndexedDB ourselves, or accept "each page is a fresh kernel" as the contract. Worth deciding up front.
    - **Package install is "micropip", not pip.** Pure-Python wheels install in seconds; native extensions (anything with C/Rust) only work if the Pyodide team has pre-built a Pyodide-compatible wheel. The covered set is large (numpy, pandas, scipy, scikit-learn, pillow, lxml, …) but not exhaustive — any tutorial that wants `psycopg2` or `cryptography` needs validation early.
    - **No raw sockets, no subprocess, no threads.** Standard browser-sandbox boundary. `fetch`-style HTTP works (and CORS rules apply); `subprocess.run`, `socket`, and `multiprocessing` don't. Most agent tutorials don't care; ML training loops sometimes do.
    - **Cold-boot cost.** Core runtime ~6 MB compressed; numpy adds ~5 MB; full data-science stack ~25 MB. First-paint matters — preload the runtime on tutorial-page hover, not on click, or learners watch a spinner.
    - **COOP/COEP only if we use threading.** The basic synchronous runtime works without `Cross-Origin-Opener-Policy` / `Cross-Origin-Embedder-Policy` headers. Threading and some scientific-package optimizations need them; agent and data tutorials generally don't. Means we can ship without disturbing analytics or third-party embeds.
    - **Browser support.** Works on all evergreen browsers including Safari/iOS.
    - **License.** Mozilla Public License 2.0 — no commercial-use friction, no procurement conversation.
  - **Authoring model.** Tutorial source repo gets a `pyodide/` folder per step — `cell.py` (initial code), `packages.json` (micropip imports), optional `setup.py` (cells run silently before the visible cell). Hugo shortcode `{{< pyodide step="3" >}}` renders the embed.
  - **Why this is a headline.** Agent tutorials are where SAP's developer story is moving fastest, and right now the entry point is "install Python, set up a venv, get an OpenAI key, configure dotenv, install langchain, ask why the import failed." Pyodide collapses that to a click — and unlike the Node equivalent, ships free.
- **wa-sqlite — real SQL in code blocks.** WASM SQLite seeded with sample data. "Try this query" becomes interactive instead of copy-paste.

## Daily-use polish

- **Document Picture-in-Picture step window.** Pop the current tutorial step into a floating, always-on-top OS-level window that stays visible while the learner alt-tabs to VS Code / BAS. ([Document PiP API](https://developer.chrome.com/docs/web-platform/document-picture-in-picture).) **← in design**
- **View Transitions API for step navigation.** Native cinematic morphs between steps (heading flies into place, code crossfades). No library.
- **Scroll-driven animations.** Pure CSS `animation-timeline: view()`. Hero diagrams assemble themselves as you scroll.
- **Wake Lock + ambient reader mode.** Keep the screen on during long tutorials, dim chrome. Pairs with shipped U12 reader mode.

## Co-presence

- **"Pair through this with me."** WebRTC screenshare + voice + synced step pointer, launched from any step. No Zoom needed.

## Sensory / accessibility

- **Eye-tracking auto-scroll.** Webcam + face-api.js / MediaPipe — the page scrolls when gaze nears the bottom. Niche but striking.
- **Hand-gesture step navigation.** MediaPipe Hands — air-swipe to advance. Best as a kiosk / event-booth demo.

---

Items not yet shortlisted but on the table for later: live cursors on tutorial steps, on-device LLM via transformers.js, Web Serial firmware flashing, Shape Detection API for QR, WebXR mission map, Web Speech voice control.

## Considered and rejected

- **WebContainers (StackBlitz) — run `cds watch` in the page.** Would have been the strongest funnel-mover for CAP / UI5 / Fiori tutorials: real Node.js + npm in the browser tab, no install, no BTP trial sign-up. **Rejected 2026-05-28 on licensing.** StackBlitz dual-licenses the runtime — free for OSS / personal use, **paid commercial license required** for embedding on commercial domains, which `developers.sap.com` is. The license is enforced at runtime via a CDN-validated token, so there is no "ship it and figure it out later" path. Pricing is sales-led (not public) and historically lands in the five-to-six-figure annual range for embed-heavy sites. That converts the entry from an engineering decision into a procurement / legal / DevRel-budget conversation, on a different cost curve from every other item on this list. The capability is real and uncloned — `container2wasm` and `WebVM` aren't close — but the gap stays unfilled until either StackBlitz changes terms or an OSS Node-in-browser runtime matures. Revisit if either happens.
