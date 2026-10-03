/**
 * Full end-to-end smoke test for StyleForge Bulk.
 *
 * The sandbox cannot reach api.puter.com, so we intercept the SDK's
 * `/drivers/call` endpoint and answer with a real PNG. Everything else — the
 * queue, retries, thumbnails, IndexedDB persistence, numbering and the ZIP
 * build — runs for real in the browser.
 */
import { chromium as pw } from 'playwright-core';
import chromiumBin from '@sparticuz/chromium';
import zlib from 'node:zlib';

/* ----------------------------- tiny PNG encoder ---------------------------- */

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
  return Buffer.concat([len, typeBuf, data, crc]);
}

function makePng(w, h, [r, g, b]) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // truecolour
  const raw = Buffer.alloc(h * (1 + w * 3));
  for (let y = 0; y < h; y += 1) {
    const row = y * (1 + w * 3);
    raw[row] = 0;
    for (let x = 0; x < w; x += 1) {
      const p = row + 1 + x * 3;
      raw[p] = (r + x) % 256;
      raw[p + 1] = (g + y) % 256;
      raw[p + 2] = b;
    }
  }
  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const REF_PNG = makePng(96, 96, [200, 60, 40]);
const GEN_PNG = makePng(64, 64, [30, 120, 200]);
const GEN_DATA_URI = `data:image/png;base64,${GEN_PNG.toString('base64')}`;

const STYLE_JSON = JSON.stringify({
  summary: 'Moody cinematic photography with warm amber practical lights.',
  medium: '35mm film photograph',
  palette: ['#1b1a17', '#c9772f', '#e8c07d', '#3a4a52'],
  lighting: 'low-key with warm rim light and deep shadows',
  texture: 'fine grain, slight halation',
  linework: 'none',
  composition: 'centred subject, generous negative space',
  cameraOrRender: '50mm f/1.4, shallow depth of field',
  mood: ['moody', 'intimate'],
  keywords: ['amber glow', 'film grain', 'low-key', 'cinematic'],
  mustAvoid: ['flat lighting', 'neon colours'],
});

/* --------------------------------- runner --------------------------------- */

const executablePath = await chromiumBin.executablePath();
const browser = await pw.launch({
  executablePath,
  args: [...chromiumBin.args, '--no-sandbox', '--disable-dev-shm-usage'],
  headless: true,
});

const ctx = await browser.newContext({
  viewport: { width: 1500, height: 1100 },
  acceptDownloads: true,
});
const page = await ctx.newPage();

const errors = [];
page.on('pageerror', (err) => errors.push(`PAGEERROR: ${err.message}`));
page.on('console', (m) => {
  if (m.type() === 'error' && !/ERR_CONNECTION|ERR_FAILED|ERR_ABORTED|wss?:\/\//.test(m.text())) {
    errors.push(m.text());
  }
});

let imageCalls = 0;
const seenRequests = [];

await page.route('**/drivers/call**', async (route) => {
  const body = JSON.parse(route.request().postData() || '{}');
  seenRequests.push({
    iface: body.interface,
    driver: body.driver,
    method: body.method,
    args: body.args,
  });

  if (body.interface === 'puter-chat-completion') {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true, result: { message: { content: STYLE_JSON } } }),
    });
    return;
  }

  if (body.interface === 'puter-image-generation') {
    imageCalls += 1;
    await new Promise((r) => setTimeout(r, 120));
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true, result: GEN_DATA_URI }),
    });
    return;
  }

  await route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ success: true, result: {} }),
  });
});

await page.goto(process.env.APP_URL || 'http://localhost:5173/', { waitUntil: 'domcontentloaded' });
await page.waitForSelector('.app');

/* 1 — SDK boots from the bundled package, no CDN needed */
await page.waitForFunction(() => typeof window.puter?.ai?.txt2img === 'function', { timeout: 20000 });
// The sandbox cannot reach puter.com, so pretend we hold a session; the
// intercepted /drivers/call never validates it.
await page.evaluate(() => {
  window.puter.authToken = 'test-token';
  window.puter.auth.isSignedIn = () => true;
});
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => typeof window.puter?.ai?.txt2img === 'function', { timeout: 20000 });
await page.evaluate(() => {
  window.puter.authToken = 'test-token';
  window.puter.auth.isSignedIn = () => true;
});
await page.waitForTimeout(500);

const sdk = await page.evaluate(() => ({
  loaded: typeof window.puter !== 'undefined',
  txt2img: typeof window.puter?.ai?.txt2img,
  chat: typeof window.puter?.ai?.chat,
  isSignedIn: (() => {
    try {
      return window.puter.auth.isSignedIn();
    } catch (e) {
      return `threw: ${e.message}`;
    }
  })(),
}));
console.log('[1] bundled SDK:', JSON.stringify(sdk));

/* 2 — upload reference images */
await page.setInputFiles('input[type=file][accept="image/*"]', [
  { name: 'ref-1.png', mimeType: 'image/png', buffer: REF_PNG },
  { name: 'ref-2.png', mimeType: 'image/png', buffer: REF_PNG },
]);
await page.waitForSelector('.ref-tile', { timeout: 15000 });
const refCount = await page.locator('.ref-tile').count();
console.log('[2] reference tiles rendered:', refCount);

/* 3 — analyse style */
await page.getByRole('button', { name: /Analyse reference style/i }).click();
await page.waitForSelector('.dna-row', { timeout: 30000 });
const dna = await page.evaluate(() => ({
  rows: [...document.querySelectorAll('.dna-row')].map(
    (r) => `${r.querySelector('.k')?.textContent}: ${r.querySelector('.v')?.textContent?.trim().slice(0, 60)}`,
  ),
  chips: [...document.querySelectorAll('.chip')].map((c) => c.textContent).slice(0, 8),
}));
console.log('[3] style DNA parsed ->', JSON.stringify(dna, null, 1));

/* 4 — bulk prompts + aspect ratio + batch size */
await page.fill('textarea', 'a lone lighthouse keeper on a stormy cliff\nnight market from a rooftop');
await page.waitForTimeout(300);
await page.evaluate(() => {
  [...document.querySelectorAll('.aspect-tab')].find((t) => t.textContent.includes('16:9'))?.click();
});
await page.waitForTimeout(200);
await page.selectOption('select >> nth=1', { label: /Nano Banana Pro/ }).catch(() => {});
await page.waitForTimeout(200);

const preflight = await page.evaluate(() => ({
  bar: document.querySelector('.actionbar .title')?.textContent,
  sub: document.querySelector('.actionbar .sub')?.textContent,
  btn: document.querySelector('.actionbar .btn.primary')?.textContent?.trim(),
}));
console.log('[4] pre-flight:', JSON.stringify(preflight));

/* 5 — generate */
await page.click('.actionbar .btn.primary');
await page.waitForFunction(
  () => document.querySelectorAll('.tile img').length >= 2,
  { timeout: 60000 },
);
await page.waitForTimeout(2500);

const runState = await page.evaluate(() => ({
  doneTiles: document.querySelectorAll('.tile img').length,
  numbers: [...document.querySelectorAll('.tile .num')].map((n) => n.textContent),
  metrics: [...document.querySelectorAll('.metric')].map(
    (m) => `${m.querySelector('.lbl')?.textContent}=${m.querySelector('.val')?.textContent}`,
  ),
  log: [...document.querySelectorAll('.log-line .m')].map((l) => l.textContent).slice(-6),
  statusPill: document.querySelector('.card-head .sub')?.textContent,
}));
console.log('[5] run state:', JSON.stringify(runState, null, 1));

/* 6 — verify the wire payload the SDK produced */
const imgReq = seenRequests.find((r) => r.iface === 'puter-image-generation');
const chatReq = seenRequests.find((r) => r.iface === 'puter-chat-completion');
console.log('[6] image request args keys:', Object.keys(imgReq?.args || {}).join(', '));
console.log('    model:', imgReq?.args?.model, '| quality:', imgReq?.args?.quality, '| ratio:', JSON.stringify(imgReq?.args?.ratio));
console.log('    input_images:', imgReq?.args?.input_images?.length, '| prompt len:', imgReq?.args?.prompt?.length);
console.log('    prompt starts:', JSON.stringify(imgReq?.args?.prompt?.slice(0, 110)));
console.log('    chat vision messages:', JSON.stringify(chatReq?.args?.messages?.[0]?.content?.slice?.(0, 2)?.map?.((c) => (typeof c === 'string' ? c.slice(0, 40) : Object.keys(c)))));
console.log('    image calls made:', imageCalls);

/* 7 — build and download the ZIP */
const dl = page.waitForEvent('download', { timeout: 90000 });
await page.getByRole('button', { name: /Download all .* as ZIP/i }).click();
await page.waitForTimeout(1500);
const download = await dl;
const zipPath = '/tmp/styleforge-test.zip';
await download.saveAs(zipPath);
console.log('[7] ZIP downloaded as:', download.suggestedFilename());

await page.screenshot({ path: '/tmp/styleforge-results.png' });

console.log('--- ERRORS (' + errors.length + ') ---');
errors.slice(0, 15).forEach((e) => console.log('  ✗', e.slice(0, 250)));

await browser.close();
