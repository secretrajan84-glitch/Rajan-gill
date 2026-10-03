/**
 * ZIP packaging.
 *
 * Everything is stored with `STORE` (no deflate): PNG/JPEG/WebP payloads are
 * already compressed, so re-compressing them would burn minutes of CPU and
 * memory for roughly zero size gain.
 */

import JSZip from 'jszip';
import { extensionFor } from './imageUtils.js';

export function buildManifestCsv(entries) {
  const head = [
    'filename',
    'index',
    'prompt_number',
    'variation',
    'prompt',
    'model',
    'quality',
    'aspect_ratio',
    'width',
    'height',
    'bytes',
    'created_at',
  ];
  const rows = entries.map((e) => [
    e.name,
    e.index,
    e.promptIndex,
    e.variation,
    e.prompt,
    e.model,
    e.tier,
    e.aspect,
    e.width,
    e.height,
    e.bytes,
    e.createdAt,
  ]);
  return [head, ...rows]
    .map((r) => r.map(csvCell).join(','))
    .join('\r\n');
}

function csvCell(v) {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function buildPromptsTxt(entries) {
  const lines = [
    'StyleForge Bulk — prompt list',
    `Generated: ${new Date().toISOString()}`,
    `Images: ${entries.length}`,
    '',
  ];
  entries.forEach((e) => {
    lines.push(`${e.name}`);
    lines.push(`  prompt #${e.promptIndex}${e.variation > 1 ? ` (variation ${e.variation})` : ''}`);
    lines.push(`  ${e.prompt}`);
    lines.push('');
  });
  return lines.join('\r\n');
}

/**
 * @param {Array} entries  [{ name, blob, index, promptIndex, variation, ... }]
 * @returns {Promise<Blob>}
 */
export async function buildZipBlob(entries, { onProgress, includeManifest = true } = {}) {
  const zip = new JSZip();
  const folder = null;

  entries.forEach((e) => {
    const target = folder ? zip.folder(folder) : zip;
    target.file(e.name, e.blob, { compression: 'STORE', date: e.createdAtDate || new Date() });
  });

  if (includeManifest) {
    zip.file('manifest.csv', buildManifestCsv(entries));
    zip.file('prompts.txt', buildPromptsTxt(entries));
    zip.file(
      'README.txt',
      [
        'StyleForge Bulk — generated image pack',
        '',
        `Images in this archive: ${entries.length}`,
        'Files are numbered in prompt order (001, 002, 003, ...) so they sort exactly',
        'the way they were requested.',
        '',
        'manifest.csv maps every file back to its source prompt.',
        '',
        'Generated with Nano Banana Pro via Puter.js — no API key, no watermark.',
      ].join('\r\n'),
    );
  }

  const blob = await zip.generateAsync(
    { type: 'blob', compression: 'STORE', streamFiles: false },
    (meta) => onProgress?.(meta.percent, meta.currentFile),
  );
  return blob;
}

/** Split a batch into N parts, keeping the prompt order intact. */
export function splitEntries(entries, perPart) {
  if (!perPart || perPart <= 0 || entries.length <= perPart) return [entries];
  const parts = [];
  for (let i = 0; i < entries.length; i += perPart) parts.push(entries.slice(i, i + perPart));
  return parts;
}

export function zipNameFor(partIndex, partsTotal) {
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  return partsTotal > 1
    ? `styleforge-images-part${String(partIndex + 1).padStart(2, '0')}-${stamp}.zip`
    : `styleforge-images-${stamp}.zip`;
}

/**
 * File name for one image inside the archive.
 *
 * Zero-padded to at least three digits — 001, 002, 003 … — so a folder of
 * results always sorts in prompt order, whatever the batch size.
 */
export function entryName(item, { pattern = '{index}', total = 0 } = {}) {
  const ext = extensionFor(item.mime);
  const width = Math.max(3, String(Math.max(total, item.index)).length);
  const pad = String(item.index).padStart(width, '0');
  const name = String(pattern || '{index}')
    .replace(/\{index\}/g, pad)
    .replace(/\{n\}/g, String(item.index))
    .replace(/\{prompt\}/g, String(item.promptIndex))
    .replace(/\{variation\}/g, String(item.variation || 1))
    .replace(/[^a-zA-Z0-9._-]+/g, '_')
    .replace(/^_+|_+$/g, '');
  const safe = name || pad;
  return /\.(png|jpe?g|webp)$/i.test(safe) ? safe : `${safe}.${ext}`;
}
