import React, { useCallback, useRef, useState } from 'react';
import { resizeToDataUrl, formatBytes, readAsDataURL } from '../lib/imageUtils.js';

const API_MAX_SIDE = 1024; // what we actually send to the model
const THUMB_MAX_SIDE = 320; // what we keep for the grid

/**
 * Unlimited reference-image upload.
 *
 * Every file is downscaled in the browser before it goes anywhere: the model
 * gets a 1024px JPEG (small payloads, fast requests) and the UI keeps a 320px
 * thumbnail so a hundred references don't melt the page.
 */
export default function ReferencePanel({ refs, setRefs, disabled }) {
  const inputRef = useRef(null);
  const [drag, setDrag] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState(null);

  const addFiles = useCallback(
    async (fileList) => {
      const files = Array.from(fileList || []).filter((f) => f.type.startsWith('image/'));
      if (!files.length) {
        setNote('Those files are not images — use PNG, JPG, WebP, AVIF or GIF.');
        return;
      }
      setBusy(true);
      setNote(null);

      const added = [];
      const failed = [];
      for (const file of files) {
        try {
          const fileUrl = await readAsDataURL(file);
          const api = await resizeToDataUrl(fileUrl, API_MAX_SIDE, 0.9, 'image/jpeg');
          const thumb = await resizeToDataUrl(api.dataUrl, THUMB_MAX_SIDE, 0.76, 'image/jpeg');
          added.push({
            id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
            name: file.name || 'reference',
            thumb: thumb.dataUrl,
            apiDataUrl: api.dataUrl,
            width: api.width,
            height: api.height,
            size: file.size,
          });
        } catch {
          failed.push(file.name);
        }
      }

      if (added.length) setRefs((prev) => [...prev, ...added]);
      if (failed.length) setNote(`Could not read: ${failed.join(', ')}`);
      setBusy(false);
    },
    [setRefs],
  );

  const onDrop = (e) => {
    e.preventDefault();
    setDrag(false);
    if (disabled) return;
    addFiles(e.dataTransfer?.files);
  };

  const onPaste = useCallback(
    (e) => {
      const items = e.clipboardData?.items;
      if (!items) return;
      const files = [];
      for (const item of items) {
        if (item.kind === 'file' && item.type.startsWith('image/')) {
          const f = item.getAsFile();
          if (f) files.push(f);
        }
      }
      if (files.length) {
        e.preventDefault();
        addFiles(files);
      }
    },
    [addFiles],
  );

  return (
    <section className="card">
      <div className="card-head">
        <span className="step">1</span>
        <h2>Reference images</h2>
        <span className="sub">
          {refs.length ? `${refs.length} uploaded` : 'unlimited'}
        </span>
      </div>

      <div className="card-body" tabIndex={-1} onPaste={onPaste}>
        <div
          className={`dropzone${drag ? ' drag' : ''}`}
          onClick={() => !disabled && inputRef.current?.click()}
          onDragOver={(e) => {
            e.preventDefault();
            if (!disabled) setDrag(true);
          }}
          onDragLeave={() => setDrag(false)}
          onDrop={onDrop}
          role="button"
          aria-label="Upload reference images"
        >
          <div className="big">{busy ? '⏳' : '🖼️'}</div>
          <strong>
            {busy ? 'Processing images…' : 'Drop reference images, click to browse, or paste'}
          </strong>
          <span>
            PNG · JPG · WebP · AVIF — upload as many as you like. The style is learned from all of
            them.
          </span>
        </div>

        <input
          ref={inputRef}
          type="file"
          accept="image/*"
          multiple
          className="sr"
          disabled={disabled}
          onChange={(e) => {
            addFiles(e.target.files);
            e.target.value = '';
          }}
        />

        {note ? <p className="hint tight">⚠ {note}</p> : null}

        {refs.length ? (
          <>
            <div className="row" style={{ marginTop: 14, justifyContent: 'space-between' }}>
              <div className="row" style={{ gap: 6 }}>
                <span className="pill info">{refs.length} reference{refs.length === 1 ? '' : 's'}</span>
                <span className="pill">
                  {formatBytes(refs.reduce((s, r) => s + (r.size || 0), 0))} uploaded
                </span>
              </div>
              <button
                className="btn xs danger"
                disabled={disabled}
                onClick={() => setRefs([])}
              >
                Remove all
              </button>
            </div>

            <div className="ref-grid">
              {refs.map((r) => (
                <div className="ref-tile" key={r.id} title={r.name}>
                  <img src={r.thumb} alt={r.name} loading="lazy" />
                  <button
                    className="ref-x"
                    aria-label={`Remove ${r.name}`}
                    disabled={disabled}
                    onClick={() => setRefs((prev) => prev.filter((x) => x.id !== r.id))}
                  >
                    ✕
                  </button>
                  <div className="ref-meta">
                    {r.width}×{r.height}
                  </div>
                </div>
              ))}
            </div>

            <p className="hint tight">
              {refs.length > 12
                ? `Big set — style analysis runs in batches of 6, and the first ${refs.length > 6 ? 6 : refs.length} images are sent to the model on every generation.`
                : 'Tip: 3–8 references that share one look give the most consistent results.'}
            </p>
          </>
        ) : null}
      </div>
    </section>
  );
}
