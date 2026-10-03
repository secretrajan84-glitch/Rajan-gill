# StyleForge Bulk

A free, no-API-key **bulk image generator** that produces new images in the
**same style as your reference images** — using **Nano Banana Pro** (Gemini 3
Pro Image).

Upload unlimited references → lock the style → paste bulk prompts → generate
100–200 images at 1K or 2K → download everything as **one ZIP** numbered
`001, 002, 003 …`.

```bash
npm install
npm run dev      # http://localhost:5173
```

---

## What it does

| Requirement | How it is met |
| --- | --- |
| **No API key** | [Puter.js](https://developer.puter.com/) (`@heyputer/puter.js`) talks to Google's image models straight from the browser under Puter's *User-Pays* model. You sign in once with a normal Puter login; your own account's allowance covers usage. No key, no token, no backend of ours. |
| **Nano Banana Pro** | Default model is `google/gemini-3-pro-image`. Nano Banana 2 / 2 Lite / FLUX.1 Schnell are selectable, and the runner can fall back to them automatically. |
| **Unlimited reference images** | Drop in as many as you want. Every file is downscaled in-browser to a 1024px JPEG for the API plus a 320px thumbnail for the grid, so a hundred references stay fast. |
| **Same style as the references** | Two layers: a vision model writes a **Style DNA** brief (palette, lighting, texture, medium, keywords, things to avoid) which is appended to *every* prompt; and the reference images themselves are sent as `input_images` on every request. |
| **Aspect ratio tab** | Ten natively-supported shapes (1:1, 4:5, 3:4, 2:3, 9:16, 3:2, 4:3, 5:4, 16:9, 21:9) plus a custom ratio, each previewed with its approximate pixel size. |
| **100–200 images in bulk** | One prompt per line, ×N variations, or set an explicit target count — your prompt list is cycled until the target is hit. A worker pool runs a configurable number at a time with retries and adaptive back-off. |
| **1K or 2K, high quality** | Quality tiers are passed straight through as `quality: '1K' \| '2K' \| '4K'`. Default is 2K. |
| **No watermark** | Nothing in this app or in Puter draws anything onto your pixels — no logo, no border, no overlay. |
| **One ZIP, in prompt order** | “Download all … as ZIP” packages every finished image into a single archive named `001.png`, `002.png`, … with `manifest.csv`, `prompts.txt` and a short `README.txt` inside. |

---

## The workflow

1. **Reference images** — drop / browse / paste. Unlimited.
2. **Style DNA** — “Analyse reference style” runs a vision pass over the
   references and returns an editable art-direction brief. Strength is
   `light` / `balanced` / `strict`.
3. **Bulk prompts** — one per line. Import `.txt` / `.csv`, dedupe, shuffle,
   or have the model write prompts from a theme and enrich existing ones.
4. **Aspect ratio** — pick a shape for the whole batch.
5. **Engine & output** — model, resolution, concurrency, PNG/JPG/WebP, first
   file number, filename pattern, plus advanced options (send references per
   request, auto-downgrade, manifest, ZIP splitting).
6. **Batch run** — live progress, throughput, estimated time left, and a
   colour-coded log. Pause / resume / stop at any time.
7. **Results** — grid of numbered tiles, full-resolution lightbox, per-image
   download, and the ZIP button.

---

## Being honest about the limits

This section matters more than the feature list.

**Puter's published AI rate limits** are **3 concurrent requests** and **30
requests per 10 s** on a free account (higher on paid plans). Concurrency
defaults to 3 for that reason. The runner has a *shared* rate governor: when any
worker gets a 429 the whole pool backs off together instead of each worker
retrying into the same wall.

**A 200-image Nano Banana Pro run is roughly $27 of model usage** at published
Gemini list prices, which is far more than a free monthly Puter allowance
covers. Puter bills **your own account at real cost** — this app charges
nothing, but it cannot make the model free.

So the runner is built to survive that:

- **Auto-downgrade.** On `insufficient_funds` it switches to a cheaper Nano
  Banana tier *in place* — the in-flight image does not burn a retry, and the
  batch keeps going. Turn it off in Advanced if you would rather fail loudly.
- **Model ladder.** Nano Banana Pro → Nano Banana 2 → Nano Banana 2 Lite →
  FLUX.1 Schnell.
- **Predictable cost.** Estimated dollars are shown before you press Generate.

The Puter sign-in popup is the one thing that can break the flow: browsers block
popups opened from background work. The app therefore asks for sign-in on a real
button press, and shows an “open in its own tab” hint when embedded in a frame.

---

## Architecture

```
src/
  lib/
    puterClient.js   Puter SDK wrapper: boot, auth, txt2img, chat, error codes
    styleEngine.js   reference analysis -> Style DNA; prompt composition
    queueEngine.js   plan building, worker pool, pause gate, rate governor
    zip.js           ZIP assembly, manifest.csv, prompts.txt, file naming
    idb.js           IndexedDB persistence
    storage.js       navigator.storage persistence + quota
    imageUtils.js    resize, re-encode, thumbnails, downloads
    constants.js     models, aspect ratios, defaults
  hooks/
    useGenerator.js  the bulk-run orchestrator
    useLocalState.js localStorage-backed state
  components/        TopBar, ReferencePanel, StylePanel, PromptPanel,
                     AspectRatioTabs, OutputPanel, RunPanel, ResultsPanel
```

### Notes worth knowing

- **The SDK is bundled, not CDN-loaded.** `@heyputer/puter.js` is imported
  directly, so the page makes no third-party request until you actually
  generate. If the bundle ever fails to boot, the client falls back to
  `https://js.puter.com/v2/` automatically.
- **`puter.ai.chat()` only attaches images when the first argument is a plain
  string.** Passing an array of `{role, content}` messages silently drops the
  media, so the style analyser sends `chat(prompt, [mediaUrls], testMode,
  options)` with the system brief folded into the prompt. This was verified
  against the SDK source, not just the docs.
- **Failed driver calls reject with the raw response body**, e.g.
  `{ success: false, error: { code: 'insufficient_funds' } }`, not an `Error`.
  `errorCode()` checks every shape before falling back to string matching.
- **Puter injects a blocking `<usage-limit-dialog>` on 402.** The client removes
  it and republishes an inline banner instead — otherwise a modal would freeze a
  running batch.
- **Blobs never live in React state.** 200 2K PNGs is ~800 MB. Only thumbnails
  stay in memory; full-resolution bytes sit in IndexedDB and are read back when
  the ZIP is assembled, part by part.
- **HMR is disabled** in the Vite config. Vite's client reloads the page when
  its websocket cannot reach the proxy, which would destroy a running batch.
- **IndexedDB persistence is requested** via `navigator.storage.persist()`, and
  the remaining quota is checked against the estimated batch size.

---

## Testing

Two headless-Chromium suites exercise the real app; only the network is stubbed
(the sandbox cannot reach `api.puter.com`). Everything else — the queue,
retries, thumbnails, IndexedDB, numbering and ZIP assembly — runs for real.

```bash
npm i -D playwright-core @sparticuz/chromium   # not shipped in package.json
npm run test:e2e                               # both suites
```

- `test/bulk-run.mjs` — upload → analyse → generate → ZIP
- `test/edge-cases.mjs` — 15-image batch, 429 back-off, 402 auto-downgrade, retry

See [`test/README.md`](test/README.md) for the container `LD_LIBRARY_PATH` note.

They assert the wire payload the SDK actually produced:

```
model: google/gemini-3-pro-image | quality: 2K | ratio: {"w":16,"h":9}
input_images: 2 | vision messages: [<system brief>, [image_url]]
ZIP: 001.png … 015.png + manifest.csv + prompts.txt
```

---

## License

Apache-2.0 (matching the Puter.js SDK this builds on).
