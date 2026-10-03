/** Image helpers: decoding, downscaling, thumbnails, byte formatting. */

export function formatBytes(n) {
  if (!n && n !== 0) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export function formatDuration(ms) {
  if (!ms || ms < 0) return '0s';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  if (m < 60) return `${m}m ${r.toString().padStart(2, '0')}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${(m % 60).toString().padStart(2, '0')}m`;
}

export function readAsDataURL(file) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result);
    fr.onerror = () => reject(fr.error || new Error('read failed'));
    fr.readAsDataURL(file);
  });
}

export function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Image decode failed'));
    img.src = src;
  });
}

export function blobToDataURL(blob) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result);
    fr.onerror = () => reject(fr.error || new Error('read failed'));
    fr.readAsDataURL(blob);
  });
}

/**
 * Downscale + re-encode an image entirely in the browser.
 * We use this for two things:
 *  1. reference images sent to the model (keeps request payloads small)
 *  2. gallery thumbnails (keeps IndexedDB + the DOM light with 200 images)
 */
export async function resizeToDataUrl(source, maxSide, quality = 0.86, mime = 'image/jpeg') {
  const src = typeof source === 'string' ? source : URL.createObjectURL(source);
  try {
    const img = await loadImage(src);
    const scale = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
    const w = Math.max(1, Math.round(img.naturalWidth * scale));
    const h = Math.max(1, Math.round(img.naturalHeight * scale));

    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    // JPEG has no alpha — paint white first so transparent PNGs don't go black.
    if (mime === 'image/jpeg') {
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, w, h);
    }
    ctx.drawImage(img, 0, 0, w, h);
    return { dataUrl: canvas.toDataURL(mime, quality), width: w, height: h };
  } finally {
    if (typeof source !== 'string') URL.revokeObjectURL(src);
  }
}

/** Re-encode a generated image into the user's chosen output format. */
export async function convertBlob(blob, format) {
  if (!blob) return blob;
  const wanted = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp' }[
    String(format).toLowerCase()
  ];
  if (!wanted) return blob;
  const current = (blob.type || '').toLowerCase();
  if (current === wanted || (wanted === 'image/jpeg' && current === 'image/jpg')) return blob;

  const url = URL.createObjectURL(blob);
  try {
    const img = await loadImage(url);
    const canvas = document.createElement('canvas');
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const ctx = canvas.getContext('2d');
    if (wanted === 'image/jpeg') {
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }
    ctx.drawImage(img, 0, 0);
    const out = await new Promise((resolve) =>
      canvas.toBlob(resolve, wanted, wanted === 'image/png' ? undefined : 0.95),
    );
    return out || blob;
  } catch {
    return blob;
  } finally {
    URL.revokeObjectURL(url);
  }
}

export function extensionFor(mime, fallback = 'png') {
  const m = String(mime || '').toLowerCase();
  if (m.includes('jpeg') || m.includes('jpg')) return 'jpg';
  if (m.includes('webp')) return 'webp';
  if (m.includes('png')) return 'png';
  return fallback;
}

/** Trigger a browser download for a Blob or data/object URL. */
export function downloadBlob(blobOrUrl, filename) {
  const url = typeof blobOrUrl === 'string' ? blobOrUrl : URL.createObjectURL(blobOrUrl);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  if (typeof blobOrUrl !== 'string') {
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }
}

export function sanitizeFilename(name, fallback = 'image') {
  const clean = String(name || '')
    .replace(/[\/\\?%*:|"<>\x00-\x1f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return clean || fallback;
}

export async function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    if (signal) {
      if (signal.aborted) {
        clearTimeout(t);
        reject(new DOMException('Aborted', 'AbortError'));
        return;
      }
      signal.addEventListener(
        'abort',
        () => {
          clearTimeout(t);
          reject(new DOMException('Aborted', 'AbortError'));
        },
        { once: true },
      );
    }
  });
}
