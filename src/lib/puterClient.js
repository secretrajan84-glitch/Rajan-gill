/**
 * Thin, defensive wrapper around Puter.js.
 *
 * Why Puter.js: it gives us Nano Banana Pro (Gemini 3 Pro Image) straight from
 * the browser with **no API key and no backend**. Puter uses a "User-Pays"
 * model — the signed-in user's own Puter account covers the AI usage, so this
 * app stays free to run and never stores a credential.
 *
 * Docs: https://docs.puter.com/AI/txt2img/
 */

const SCRIPT_URL = 'https://js.puter.com/v2/';

let readyPromise = null;
let loadedVia = null;

/**
 * Which SDK we booted from: 'bundled' or 'cdn'. Exposed for the console so a
 * support question ("is the CDN blocked?") has a one-line answer.
 */
export function sdkSource() {
  return loadedVia;
}

/* ------------------------------------------------------------------ *
 * Usage-limit dialog handling
 *
 * When a driver call comes back 402 the SDK appends a
 * <usage-limit-dialog> custom element and calls showModal() on it. That is a
 * blocking modal: it freezes the whole page, which is exactly what you do not
 * want mid-way through a 200-image batch — and it duplicates the message this
 * app already shows inline (with the auto-downgrade explanation).
 *
 * So we watch for it, remove it, and republish the event so the UI can show a
 * non-blocking banner instead. Nothing is hidden from the user; the same
 * information is surfaced in a better place.
 * ------------------------------------------------------------------ */

const usageListeners = new Set();
let usageWatcher = null;

/** Subscribe to "the account hit a Puter usage limit". Returns an unsubscribe. */
export function onUsageLimit(fn) {
  usageListeners.add(fn);
  return () => usageListeners.delete(fn);
}

function watchUsageDialog() {
  if (usageWatcher || typeof document === 'undefined' || !document.body) return;
  const sweep = () => {
    const dialogs = document.querySelectorAll('usage-limit-dialog');
    if (!dialogs.length) return;
    dialogs.forEach((el) => {
      el.remove();
      usageListeners.forEach((fn) => {
        try {
          fn();
        } catch {
          /* listener errors must not break the sweep */
        }
      });
    });
    console.info(
      '[StyleForge] Replaced the Puter usage-limit modal with an inline banner so the batch keeps running.',
    );
  };
  usageWatcher = new MutationObserver(sweep);
  usageWatcher.observe(document.body, { childList: true });
  sweep();
}

function injectCdnScript(timeout = 8000) {
  return new Promise((resolve, reject) => {
    if (typeof document === 'undefined') {
      reject(new Error('No document'));
      return;
    }
    const el = document.createElement('script');
    el.src = SCRIPT_URL;
    el.async = true;
    const timer = setTimeout(() => {
      el.remove();
      reject(new Error('CDN timed out'));
    }, timeout);
    el.onload = () => {
      clearTimeout(timer);
      resolve();
    };
    el.onerror = () => {
      clearTimeout(timer);
      el.remove();
      reject(new Error('CDN blocked'));
    };
    document.head.appendChild(el);
  });
}

/**
 * Boot the Puter SDK.
 *
 * Primary path is the **bundled** SDK (`@heyputer/puter.js`), so the app never
 * depends on a third-party CDN being reachable — only api.puter.com is called,
 * and only when you actually generate something. If the local bundle somehow
 * fails we fall back to the official CDN build.
 */
export function whenPuterReady({ timeout = 25000 } = {}) {
  if (typeof window !== 'undefined' && window.puter) {
    if (!loadedVia) loadedVia = 'bundled';
    return Promise.resolve(window.puter);
  }
  if (readyPromise) return readyPromise;

  readyPromise = (async () => {
    watchUsageDialog();
    let bundleError = null;
    try {
      // The module assigns `globalThis.puter` as a side effect.
      const mod = await import('@heyputer/puter.js');
      if (mod?.puter) {
        globalThis.puter = mod.puter;
        loadedVia = 'bundled';
        return mod.puter;
      }
      if (globalThis.puter) {
        loadedVia = 'bundled';
        return globalThis.puter;
      }
    } catch (err) {
      bundleError = err;
    }

    try {
      await injectCdnScript();
      const started = Date.now();
      while (Date.now() - started < timeout) {
        if (globalThis.puter) {
          loadedVia = 'cdn';
          return globalThis.puter;
        }
        await new Promise((r) => setTimeout(r, 100));
      }
      throw new Error('CDN script loaded but Puter was never registered');
    } catch (cdnError) {
      throw new Error(
        'Could not start the Puter SDK. ' +
          `Bundled build: ${bundleError?.message || 'unavailable'}. CDN: ${cdnError.message}. ` +
          'Check your internet connection or content blocker, then reload.',
      );
    }
  })();

  readyPromise.catch(() => {
    readyPromise = null;
  });
  return readyPromise;
}

/** True once the Puter SDK object exists. */
export function isPuterLoaded() {
  return typeof window !== 'undefined' && !!window.puter;
}

/* ------------------------------------------------------------------ *
 * Auth (still no API key: the user signs in with a normal Puter login)
 * ------------------------------------------------------------------ */

export function isSignedIn() {
  try {
    return !!window.puter?.auth?.isSignedIn?.();
  } catch {
    return false;
  }
}

export async function signIn() {
  const puter = await whenPuterReady();
  if (puter.auth.isSignedIn()) return puter.auth.getUser();
  await puter.auth.signIn();
  return puter.auth.getUser();
}

export async function signOut() {
  const puter = await whenPuterReady();
  return puter.auth.signOut();
}

export async function getUser() {
  const puter = await whenPuterReady();
  try {
    if (!puter.auth.isSignedIn()) return null;
    return await puter.auth.getUser();
  } catch {
    return null;
  }
}

/**
 * Monthly usage info, when the account exposes it. Used purely to show the
 * user how much of their free allowance is left.
 */
export async function getMonthlyUsage() {
  const puter = await whenPuterReady();
  try {
    if (!puter.auth.isSignedIn()) return null;
    if (typeof puter.auth.getMonthlyUsage !== 'function') return null;
    return await puter.auth.getMonthlyUsage();
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ *
 * Image generation
 * ------------------------------------------------------------------ */

/**
 * Pull a usable `src` out of whatever `txt2img()` resolved to.
 * In browsers it is an HTMLImageElement; in workers/Node it is an object with
 * `src` + toString(). Some versions hand back a bare string.
 */
function resolveImageSrc(result) {
  if (!result) return null;
  if (typeof result === 'string') return result;
  if (typeof result.src === 'string' && result.src) return result.src;
  if (result.image && typeof result.image === 'string') return result.image;
  if (typeof result.url === 'string' && result.url) return result.url;
  try {
    const s = result.toString?.();
    if (s && s !== '[object Object]') return s;
  } catch {
    /* ignore */
  }
  return null;
}

/** Wait for an <img> to actually have decodable pixels. */
async function ensureDecoded(result) {
  if (typeof result?.decode !== 'function') return;
  try {
    await Promise.race([
      result.decode(),
      new Promise((r) => setTimeout(r, 20000)),
    ]);
  } catch {
    /* decode() rejects on non-image sources; the src is still usable */
  }
}

export function dataUrlToBlob(dataUrl) {
  const [head, body] = dataUrl.split(',');
  const mime = /:(.*?);/.exec(head)?.[1] || 'image/png';
  const isBase64 = /;base64/i.test(head);
  if (isBase64) {
    const bin = atob(body);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
    return new Blob([bytes], { type: mime });
  }
  return new Blob([decodeURIComponent(body)], { type: mime });
}

/**
 * Turn whatever the provider returned into a durable Blob.
 * Hosted URLs are temporary, so we always try to materialise bytes now.
 */
async function srcToBlob(src) {
  if (!src) return null;

  if (src.startsWith('data:')) {
    return dataUrlToBlob(src);
  }

  if (src.startsWith('blob:')) {
    const res = await fetch(src);
    if (!res.ok) throw new Error(`Blob fetch failed (${res.status})`);
    return res.blob();
  }

  // Hosted URL — usually CORS-enabled, but we degrade gracefully if not.
  const res = await fetch(src, { credentials: 'include', mode: 'cors' });
  if (!res.ok) throw new Error(`Image fetch failed (${res.status})`);
  const blob = await res.blob();
  if (!blob || blob.size === 0) throw new Error('Image fetch returned 0 bytes');
  return blob;
}

export async function measureBlob(blob) {
  if (!blob) return { width: 0, height: 0 };
  try {
    const url = URL.createObjectURL(blob);
    const dims = await new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
      img.onerror = () => reject(new Error('decode failed'));
      img.src = url;
    });
    URL.revokeObjectURL(url);
    return dims;
  } catch {
    return { width: 0, height: 0 };
  }
}

/**
 * Generate one image.
 *
 * @returns {{blob: Blob|null, mime: string, width: number, height: number,
 *            previewSrc: string, bytesAvailable: boolean, modelUsed: string}}
 */
/**
 * The Puter SDK blocks silently on its sign-in popup when a signed-out visitor
 * triggers an AI call (`driverCall` → `puter.ui.authenticateWithPuter()`). If a
 * popup blocker eats that, the promise would never settle, so every AI call
 * gets a hard ceiling well above the slowest legitimate response.
 */
const IMAGE_TIMEOUT_MS = 10 * 60 * 1000;
const CHAT_TIMEOUT_MS = 3 * 60 * 1000;

function withTimeout(promise, ms, label) {
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => {
      timer = setTimeout(
        () =>
          reject(
            new Error(
              `${label} produced no response after ${Math.round(ms / 1000)}s. ` +
                'If you are not signed in yet, the Puter sign-in popup was probably blocked — allow popups for this page (or open it in its own tab) and try again.',
            ),
          ),
        ms,
      );
    }),
  ]);
}

export async function generateImage({
  prompt,
  modelId,
  tier,
  ratio,
  inputImages = [],
  inputMimeType = 'image/png',
  extra = {},
}) {
  const puter = await whenPuterReady();

  const options = { model: modelId, ...extra };
  if (tier && !extra.quality) options.quality = tier;
  if (ratio && ratio.w && ratio.h) options.ratio = { w: ratio.w, h: ratio.h };
  if (inputImages.length) {
    options.input_images = inputImages;
    options.input_image_mime_type = inputMimeType;
  }

  let result;
  try {
    result = await withTimeout(
      puter.ai.txt2img(prompt, options),
      IMAGE_TIMEOUT_MS,
      'Image generation',
    );
  } catch (err) {
    throw decorate(err, { prompt, modelId });
  }

  // 1.2.x returns an <img>; make sure it has decoded before we read pixels.
  await ensureDecoded(result);
  const src = resolveImageSrc(result);

  let blob = null;
  let bytesError = null;
  try {
    blob = await srcToBlob(src);
  } catch (err) {
    bytesError = err;
  }

  const dims = blob ? await measureBlob(blob) : { width: 0, height: 0 };
  const mime = blob?.type || guessMimeFromSrc(src) || 'image/png';

  return {
    blob,
    mime,
    width: dims.width,
    height: dims.height,
    previewSrc: src,
    bytesAvailable: !!blob,
    bytesError: bytesError ? String(bytesError.message || bytesError) : null,
    modelUsed: modelId,
  };
}

function guessMimeFromSrc(src) {
  if (!src) return null;
  if (/\.jpe?g(\?|$)/i.test(src)) return 'image/jpeg';
  if (/\.webp(\?|$)/i.test(src)) return 'image/webp';
  if (/\.png(\?|$)/i.test(src)) return 'image/png';
  return null;
}

/* ------------------------------------------------------------------ *
 * Text / vision helpers (used for style extraction + prompt rewriting)
 * ------------------------------------------------------------------ */

/**
 * Chat completion with optional image attachments.
 *
 * IMPORTANT: Puter only attaches media when the *first* argument is a plain
 * string. Passing an array of `{role, content}` messages makes the SDK ignore
 * the media argument entirely, so we send the documented
 * `chat(prompt, [mediaUrls], testMode, options)` form with the system brief
 * folded into the prompt. Verified against @heyputer/puter.js 2.6.3
 * (`src/modules/ai/chat.js`).
 *
 * @param {object} args
 * @param {string} args.prompt
 * @param {string} [args.system]
 * @param {Array<string>} [args.media] data URIs / URLs of images to attach
 * @param {string} [args.model]
 */
export async function chat({ prompt, system, media = [], model } = {}) {
  const puter = await whenPuterReady();
  const opts = {};
  if (model) opts.model = model;

  const full = system ? `${system}\n\n---\n\n${prompt}` : prompt;

  let res;
  try {
    res = await withTimeout(
      media?.length ? puter.ai.chat(full, media, false, opts) : puter.ai.chat(full, opts),
      CHAT_TIMEOUT_MS,
      'The style model',
    );
  } catch (err) {
    throw decorate(err, { stage: 'chat' });
  }
  return extractText(res);
}

/** ChatResponse shapes vary by vendor; normalise to a plain string. */
export function extractText(res) {
  if (!res) return '';
  if (typeof res === 'string') return res;
  const msg = res.message ?? res;
  const content = msg?.content ?? msg?.text ?? msg;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part;
        return part?.text ?? part?.content ?? '';
      })
      .join('')
      .trim();
  }
  if (content && typeof content === 'object' && typeof content.text === 'string') {
    return content.text;
  }
  // The SDK stubs toString()/valueOf() onto the response to expose the raw
  // message content.
  try {
    const viaToString = res.toString?.();
    if (typeof viaToString === 'string' && viaToString !== '[object Object]') return viaToString;
  } catch {
    /* ignore */
  }
  return '';
}

/* ------------------------------------------------------------------ *
 * Error handling
 * ------------------------------------------------------------------ */

/**
 * Pull a code out of the many shapes Puter errors arrive in.
 *
 * Verified shapes (headless, against @heyputer/puter.js 2.6.3): a failed driver
 * call rejects with the *parsed response body* — a plain object like
 * `{ success: false, error: { code, message } }` — not an Error. There is no
 * `err.code` and no `err.message`, so every plausible slot has to be checked
 * before falling back to string matching.
 */
export function errorCode(err) {
  if (!err) return 'unknown';
  const slots = [
    err.code,
    err.errorCode,
    err.error?.code,
    err.detail?.code,
    err.detail?.errorCode,
    err.detail?.error?.code,
  ];
  const found = slots.find((c) => typeof c === 'string' && c);
  if (found) return found;

  const status = err.status ?? err.detail?.status ?? err.detail?.error?.status;
  if (status === 402) return 'insufficient_funds';
  if (status === 429) return 'too_many_requests';
  if (status === 401) return 'unauthorized';

  let msg = '';
  try {
    msg = `${err.message || ''} ${JSON.stringify(err.detail ?? err)}`;
  } catch {
    msg = String(err.message || err);
  }
  if (/insufficient_funds|not enough (credit|funds)|\b402\b/i.test(msg)) return 'insufficient_funds';
  if (/usage_limited|usage limit/i.test(msg)) return 'insufficient_funds';
  if (/too_many_requests|rate.?limit|\b429\b/i.test(msg)) return 'too_many_requests';
  if (/moderation|flagged|safety|blocked|prohibited/i.test(msg)) return 'moderation_flagged';
  if (/upstream|unavailable|overloaded|\b5\d\d\b/i.test(msg)) return 'upstream_failed';
  if (/network|failed to fetch|load failed|networkerror/i.test(msg)) return 'network_error';
  if (/subscription_required/i.test(msg)) return 'subscription_required';
  if (/prompt_required/i.test(msg)) return 'prompt_required';
  return 'unknown';
}

export function classifyError(err) {
  const code = errorCode(err);
  const message = String(err?.message || err || 'Unknown error');
  switch (code) {
    case 'too_many_requests':
      return {
        code,
        retryable: true,
        backoff: 6000,
        severity: 'warn',
        title: 'Rate limited',
        hint: 'Puter throttled the request. Lower the concurrency to 3 (free-plan max) and it will recover on its own.',
        message,
      };
    case 'insufficient_funds':
      return {
        code,
        retryable: false,
        blocking: true,
        severity: 'error',
        title: 'Out of Puter credit',
        hint: 'The monthly free allowance on this Puter account is used up. Switch to a cheaper model, or top up at puter.com/dashboard.',
        message,
      };
    case 'moderation_flagged':
      return {
        code,
        retryable: false,
        severity: 'warn',
        title: 'Blocked by the safety filter',
        hint: 'Edit that prompt — retrying the same text will fail again.',
        message,
      };
    case 'upstream_failed':
      return {
        code,
        retryable: true,
        backoff: 3000,
        severity: 'warn',
        title: 'Provider error',
        hint: 'The model rejected the request upstream. Retrying usually works.',
        message,
      };
    case 'network_error':
      return {
        code,
        retryable: true,
        backoff: 4000,
        severity: 'warn',
        title: 'Network hiccup',
        hint: 'The request never reached Puter. Retrying.',
        message,
      };
    case 'subscription_required':
      return {
        code,
        retryable: false,
        severity: 'error',
        title: 'Plan required',
        hint: 'This model or endpoint needs a paid Puter plan.',
        message,
      };
    default:
      return {
        code,
        retryable: true,
        backoff: 4000,
        severity: 'warn',
        title: 'Generation failed',
        hint: 'Will retry.',
        message,
      };
  }
}

/**
 * Normalise a thrown Puter error into a real Error *without* losing the
 * provider's error code — the classification, the auto-downgrade and the retry
 * policy all depend on it.
 */
function decorate(err, context) {
  if (err instanceof Error && !err.detail && !err.code) {
    err.context = { ...(err.context || {}), ...context };
    return err;
  }

  const detail = err && typeof err === 'object' ? err : { message: String(err) };
  const code = errorCode(detail);
  const rawMessage =
    (typeof detail.message === 'string' && detail.message) ||
    (typeof detail.error?.message === 'string' && detail.error.message) ||
    (typeof detail.error?.status === 'string' && detail.error.status) ||
    '';

  const e = new Error(rawMessage || `Puter request failed (${code})`);
  e.name = 'PuterError';
  e.code = code === 'unknown' ? undefined : code;
  e.errorCode = e.code;
  e.status = detail.status ?? detail.error?.status;
  e.detail = detail;
  e.context = { ...context };
  return e;
}
