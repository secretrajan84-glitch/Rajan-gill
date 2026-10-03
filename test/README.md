# End-to-end tests

Two headless-Chromium suites that drive the **real** application. Only the
network is stubbed — everything else (the queue, retries, back-off, thumbnails,
IndexedDB persistence, file numbering and ZIP assembly) is the shipping code.

They stub `POST https://api.puter.com/drivers/call`, which is the single
endpoint the Puter SDK uses for both `puter.ai.txt2img()` and `puter.ai.chat()`.
So a test can serve a real PNG, or a 429, or a 402, and watch what the app does.

## Extra dependencies

These are intentionally **not** in `package.json` — they are large and only
needed to run the suites.

```bash
npm i -D playwright-core @sparticuz/chromium
```

`@sparticuz/chromium` ships a self-contained Chromium build that works in
containers with no system browser (it fetches its binary on first use). Import
of `playwright-core` is enough — no `playwright install` step.

## Running

Start the dev server, then:

```bash
npm run test:e2e        # both suites
npm run test:e2e:bulk   # upload -> style -> generate -> ZIP
npm run test:e2e:edge   # rate limits, retry, credit exhaustion
```

Point them somewhere else with `APP_URL=http://host:port`.

## What they assert

**`bulk-run.mjs`**

- the bundled Puter SDK boots without touching js.puter.com
- reference upload renders tiles and produces a parsed Style DNA
- the generated prompts carry the style brief
- the **wire payload** the SDK actually built
  (`model`, `quality`, `ratio`, `input_images`, and that the vision call kept
  its `image_url` block)
- the ZIP downloads and contains `001.png`, `002.png`, `manifest.csv`,
  `prompts.txt`, `README.txt`

**`edge-cases.mjs`**

- a 15-image batch numbers itself `001` … `015`
- two 429s are absorbed by the shared rate governor and the images still arrive
- a 402 mid-run triggers the automatic downgrade
  (`gemini-3-pro-image` → `gemini-3.1-flash-image`) and the batch finishes
- a 5xx is retried
- Puter's blocking `<usage-limit-dialog>` never freezes the page

## Notes for the sandbox

If Chromium fails with `libnspr4.so: cannot open shared object file`, the
bundled AL2023 shared libraries are not on the loader path:

```bash
LD_LIBRARY_PATH="$(npm root)/@sparticuz/chromium/bin/al2023/lib:$LD_LIBRARY_PATH" \
  node test/bulk-run.mjs
```
