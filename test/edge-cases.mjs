/**
 * Edge-case E2E: 15-image batch numbering, 429 rate-limit recovery,
 * 402 credit exhaustion -> automatic model downgrade, and failure retry.
 */
import { chromium as pw } from 'playwright-core';
import chromiumBin from '@sparticuz/chromium';
import zlib from 'node:zlib';

const T = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
const crc32 = (b) => {
  let c = -1;
  for (let i = 0; i < b.length; i += 1) c = T[(c ^ b[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
};
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const tb = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([tb, data])));
  return Buffer.concat([len, tb, data, crc]);
}
function makePng(w, h, [r, g, b]) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const raw = Buffer.alloc(h * (1 + w * 3));
  for (let y = 0; y < h; y += 1) {
    const row = y * (1 + w * 3);
    for (let x = 0; x < w; x += 1) {
      const p = row + 1 + x * 3;
      raw[p] = (r + x * 2) % 256;
      raw[p + 1] = (g + y * 2) % 256;
      raw[p + 2] = b;
    }
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const GEN = `data:image/png;base64,${makePng(48, 48, [180, 90, 30]).toString('base64')}`;
const STYLE = JSON.stringify({ summary: 'x', keywords: ['a', 'b'] });

const browser = await pw.launch({
  executablePath: await chromiumBin.executablePath(),
  args: [...chromiumBin.args, '--no-sandbox', '--disable-dev-shm-usage'],
  headless: true,
});
const ctx = await browser.newContext({ viewport: { width: 1500, height: 1100 }, acceptDownloads: true });
const page = await ctx.newPage();

const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));
page.on('console', (m) => {
  if (m.type() === 'error' && !/ERR_CONNECTION|ERR_FAILED|ERR_ABORTED|localhost/.test(m.text())) {
    pageErrors.push(m.text());
  }
});

/* --------------------------- fake backend state --------------------------- */
let imageCalls = 0;
let rateLimitSent = 0;
let creditFailures = 0;
let hardFailures = 0;
const modelsSeen = [];

await page.route('**/drivers/call**', async (route) => {
  const body = JSON.parse(route.request().postData() || '{}');
  if (body.interface === 'puter-chat-completion') {
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true, result: { message: { content: STYLE } } }),
    });
  }
  imageCalls += 1;
  modelsSeen.push(body.args?.model);
  await new Promise((r) => setTimeout(r, 40));

  // 1st + 2nd image call: rate limited
  if (rateLimitSent < 2) {
    rateLimitSent += 1;
    return route.fulfill({
      status: 429,
      contentType: 'application/json',
      body: JSON.stringify({ success: false, error: { code: 'too_many_requests', message: 'slow down' } }),
    });
  }
  // image #4 hard-fails twice, then succeeds on retry
  if (imageCalls >= 4 && imageCalls <= 5) {
    hardFailures += 1;
    return route.fulfill({
      status: 502,
      contentType: 'application/json',
      body: JSON.stringify({ success: false, error: { code: 'upstream_failed', message: 'boom' } }),
    });
  }
  // after 6 successful images, the account runs out of credit
  if (imageCalls > 8 && creditFailures < 1) {
    creditFailures += 1;
    return route.fulfill({
      status: 402,
      contentType: 'application/json',
      body: JSON.stringify({ success: false, error: { code: 'insufficient_funds', message: 'no funds' } }),
    });
  }
  return route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ success: true, result: GEN }),
  });
});

await page.goto(process.env.APP_URL || 'http://localhost:5173/', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => typeof window.puter?.ai?.txt2img === 'function', { timeout: 20000 });
await page.evaluate(() => {
  window.puter.authToken = 'test-token';
  window.puter.auth.isSignedIn = () => true;
  try {
    localStorage.removeItem('sf.settings');
    localStorage.removeItem('sf.prompts');
  } catch {}
});
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => typeof window.puter?.ai?.txt2img === 'function', { timeout: 20000 });
await page.evaluate(() => {
  window.puter.authToken = 'test-token';
  window.puter.auth.isSignedIn = () => true;
});

/* ------------------------------ exercise UI ------------------------------ */
// 15 prompts, one per line
const prompts = Array.from({ length: 15 }, (_, i) => `scene number ${i + 1} in the house style`);
await page.fill('textarea', prompts.join('\n'));
await page.waitForTimeout(400);

// concurrency high to keep the test quick
await page.evaluate(() => {
  const sels = [...document.querySelectorAll('select')];
  const conc = sels.find((s) => [...s.options].some((o) => o.textContent.includes('free-plan max')));
  if (conc) {
    conc.value = '6';
    conc.dispatchEvent(new Event('change', { bubbles: true }));
  }
});
await page.waitForTimeout(300);

const pre = await page.evaluate(() => document.querySelector('.actionbar .title')?.textContent);
console.log('[A] pre-flight:', pre);

await page.click('.actionbar .btn.primary');
await page.waitForFunction(
  () => [...document.querySelectorAll('.log-line .m')].some((l) => /Run complete|Run stopped/.test(l.textContent)),
  { timeout: 180000 },
);
await page.waitForTimeout(1500);

const state = await page.evaluate(() => ({
  doneTiles: document.querySelectorAll('.tile img').length,
  numbers: [...document.querySelectorAll('.tile .num')].map((n) => n.textContent),
  log: [...document.querySelectorAll('.log-line .m')].map((l) => l.textContent),
}));

console.log('[B] generated tiles:', state.doneTiles);
console.log('[B] numbering:', state.numbers.join(' '));
console.log('[B] log:');
state.log.forEach((l) => console.log('     -', l));

console.log('[C] fake-backend stats: imageCalls=%d rateLimits=%d hardFails=%d creditFails=%d',
  imageCalls, rateLimitSent, hardFailures, creditFailures);
console.log('[C] model sequence:', [...new Set(modelsSeen)].join(' -> '));

/* ------------------------------ ZIP + naming ----------------------------- */
const dl = page.waitForEvent('download', { timeout: 120000 });
await page.getByRole('button', { name: /Download all .* as ZIP/i }).click();
const download = await dl;
await download.saveAs('/tmp/styleforge-edge.zip');
console.log('[D] ZIP:', download.suggestedFilename());

await page.screenshot({ path: '/tmp/styleforge-edge.png' });

console.log('--- PAGE ERRORS (' + pageErrors.length + ') ---');
pageErrors.slice(0, 10).forEach((e) => console.log('  ✗', e.slice(0, 220)));

await browser.close();
