import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { buildZipBlob, splitEntries, zipNameFor, entryName } from '../lib/zip.js';
import { downloadBlob, formatBytes, formatDuration, sleep } from '../lib/imageUtils.js';
import { useCopy } from '../hooks/useLocalState.js';

/** Peak bytes we let a single ZIP part occupy before auto-splitting. */
const PART_BUDGET_BYTES = 320 * 1024 * 1024;

export default function ResultsPanel({
  plan,
  results,
  settings,
  onClear,
  hasRun,
  buildingZip,
  setBuildingZip,
  getResultBlobs,
}) {
  const [lightbox, setLightbox] = useState(null); // index into `done` list
  const [fullSrc, setFullSrc] = useState(null); // full-resolution URL for the lightbox
  const [zipProgress, setZipProgress] = useState(null);
  const [zipMsg, setZipMsg] = useState(null);
  const [filter, setFilter] = useState('all');

  const done = results;
  const pending = plan.filter((i) => i.status === 'running' || i.status === 'queued');
  const failed = plan.filter((i) => i.status === 'failed' || i.status === 'blocked');

  const totalBytes = useMemo(() => done.reduce((s, i) => s + (i.bytes || 0), 0), [done]);
  const archivable = done.filter((i) => i.resultId || i.blob);

  /* ------------------------------- ZIP ------------------------------- */

  const downloadZip = useCallback(async () => {
    if (!archivable.length) return;
    setZipMsg(null);
    setBuildingZip(true);
    setZipProgress({ percent: 0, label: 'Preparing…' });

    try {
      const ordered = archivable.slice().sort((a, b) => a.index - b.index);

      /*
       * Split the batch so one ZIP is never held entirely in memory at once.
       *
       * - an explicit "split every N" always wins
       * - otherwise we split only when the batch would blow past the part
       *   budget, so a normal 100-200 image run still comes out as ONE file
       */
      const explicit = settings.zipSplit > 0 ? settings.zipSplit : 0;
      const estTotal = ordered.reduce((sum, i) => sum + (i.bytes || 0), 0);
      const autoSplit =
        explicit ||
        (estTotal > PART_BUDGET_BYTES && ordered.length > 20
          ? Math.max(20, Math.ceil((PART_BUDGET_BYTES / estTotal) * ordered.length))
          : 0);
      const parts = splitEntries(ordered, autoSplit);

      for (let p = 0; p < parts.length; p += 1) {
        const partLabel = parts.length > 1 ? `part ${p + 1} of ${parts.length} · ` : '';
        setZipProgress({ percent: 0, label: `${partLabel}reading images from local cache…` });

        const loaded = await getResultBlobs(parts[p], (i, n) => {
          if (i % 5 === 0 || i === n) {
            setZipProgress({
              percent: (i / n) * 20,
              label: `${partLabel}reading images ${i}/${n}…`,
            });
          }
        });

        const entries = loaded.map(({ item, blob }) => ({
          name: entryName(item, {
            pattern: settings.filenamePattern,
            total: ordered.length || item.index,
          }),
          blob,
          index: item.index,
          promptIndex: item.promptIndex,
          variation: item.variation,
          prompt: item.prompt,
          model: item.model,
          tier: item.tier,
          aspect: item.aspect,
          width: item.width,
          height: item.height,
          bytes: blob.size || item.bytes,
          createdAt: item.createdAt || new Date().toISOString(),
        }));

        if (!entries.length) continue;

        const label = `${partLabel}compressing archive…`;
        setZipProgress({ percent: 20, label });
        const blob = await buildZipBlob(entries, {
          includeManifest: settings.includeManifest,
          onProgress: (percent, currentFile) =>
            setZipProgress({
              percent: 20 + percent * 0.8,
              label: currentFile ? `${label} ${currentFile}` : label,
            }),
        });

        downloadBlob(blob, zipNameFor(p, parts.length));
        setZipMsg(
          `ZIP ready — ${entries.length} image${entries.length === 1 ? '' : 's'}, ${formatBytes(
            blob.size,
          )}${parts.length > 1 ? ` (part ${p + 1} of ${parts.length})` : ''}.`,
        );
        // Give the browser room to release the previous part's memory.
        if (parts.length > 1) await sleep(1600);
      }
    } catch (err) {
      setZipMsg(`ZIP failed: ${err.message}`);
    } finally {
      setZipProgress(null);
      setBuildingZip(false);
    }
  }, [archivable, settings, plan.length, setBuildingZip, getResultBlobs]);

  /* ----------------------------- lightbox ---------------------------- */

  const closeLightbox = useCallback(() => setLightbox(null), []);
  const step = useCallback(
    (delta) => {
      setLightbox((cur) => {
        if (cur === null) return cur;
        const next = cur + delta;
        if (next < 0 || next >= done.length) return cur;
        return next;
      });
    },
    [done.length],
  );

  useEffect(() => {
    if (lightbox === null) return undefined;
    const onKey = (e) => {
      if (e.key === 'Escape') closeLightbox();
      if (e.key === 'ArrowLeft') step(-1);
      if (e.key === 'ArrowRight') step(1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [lightbox, closeLightbox, step]);

  const active = lightbox !== null ? done[lightbox] : null;

  /* Load the full-resolution image for the lightbox, and release it on close. */
  useEffect(() => {
    let url = null;
    let cancelled = false;
    setFullSrc(null);
    if (!active) return undefined;
    (async () => {
      const loaded = await getResultBlobs([active]);
      if (cancelled || !loaded.length) return;
      url = URL.createObjectURL(loaded[0].blob);
      setFullSrc(url);
    })();
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [active, getResultBlobs]);

  if (!plan.length) {
    return (
      <section className="card">
        <div className="card-head">
          <span className="step">7</span>
          <h2>Results</h2>
          <span className="sub">nothing generated yet</span>
        </div>
        <div className="card-body">
          <div className="empty">
            <div className="big">🗂️</div>
            <p style={{ margin: 0 }}>
              Generated images land here, numbered 001, 002, 003 … ready to download as one ZIP.
            </p>
          </div>
        </div>
      </section>
    );
  }

  return (
    <section className="card">
      <div className="card-head">
        <span className="step">7</span>
        <h2>Results</h2>
        <span className="sub">
          {done.length}/{plan.length} ready
          {totalBytes ? ` · ${formatBytes(totalBytes)}` : ''}
        </span>
      </div>

      <div className="card-body">
        <div className="row" style={{ justifyContent: 'space-between', marginBottom: 13 }}>
          <div className="row" style={{ gap: 7 }}>
            <button
              className="btn primary"
              onClick={downloadZip}
              disabled={buildingZip || !archivable.length}
            >
              {buildingZip
                ? `Zipping… ${zipProgress ? `${Math.round(zipProgress.percent)}%` : ''}`
                : `⬇ Download all ${archivable.length} as ZIP`}
            </button>
            {failed.length ? (
              <button className="btn sm ghost" onClick={() => setFilter(filter === 'failed' ? 'all' : 'failed')}>
                {filter === 'failed' ? 'Show all' : `Show ${failed.length} failed`}
              </button>
            ) : null}
          </div>
          <div className="row" style={{ gap: 7 }}>
            <span className="pill">{settings.outputFormat.toUpperCase()}</span>
            <span className="pill">{settings.tier}</span>
            <button className="btn sm ghost danger" onClick={onClear} disabled={buildingZip}>
              Clear
            </button>
          </div>
        </div>

        {zipProgress || zipMsg ? (
          <div style={{ marginBottom: 13 }}>
            {zipProgress ? (
              <>
                <div className="hint mono" style={{ marginBottom: 5 }}>
                  {zipProgress.label}
                </div>
                <div className="progress">
                  <i style={{ width: `${zipProgress.percent}%` }} />
                </div>
              </>
            ) : (
              <div className="banner info" style={{ marginBottom: 0 }}>
                <span className="ic">📦</span>
                <div>
                  <strong>{zipMsg}</strong>
                  <p>
                    Files are named 001, 002, 003 … in prompt order
                    {settings.includeManifest ? ', with manifest.csv + prompts.txt inside' : ''}.
                  </p>
                </div>
              </div>
            )}
          </div>
        ) : null}

        <div className="results-grid">
          {filter === 'failed'
            ? failed.map((item) => (
                <div className="tile failed" key={item.id}>
                  <div className="fail-body">
                    <div className="num" style={{ position: 'static', display: 'inline-block', marginBottom: 8 }}>
                      #{String(item.index).padStart(3, '0')}
                    </div>
                    <div>{item.error?.title || 'Failed'}</div>
                    <div style={{ color: 'var(--muted)', marginTop: 6, fontSize: 10.5 }}>
                      {item.error?.message?.slice(0, 160)}
                    </div>
                  </div>
                </div>
              ))
            : plan.map((item) => {
                if (item.status === 'done') {
                  const idx = done.indexOf(item);
                  return (
                    <div className="tile show-overlay" key={item.id}>
                      <img src={item.thumb || item.previewSrc} alt={`Image ${item.index}`} loading="lazy" />
                      <span className="num">{String(item.index).padStart(3, '0')}</span>
                      <div className="overlay">
                        <span className="info">
                          {item.width}×{item.height}
                        </span>
                        <button
                          className="icon-btn"
                          title="View"
                          onClick={() => setLightbox(idx)}
                        >
                          ⤢
                        </button>
                        <button
                          className="icon-btn"
                          title="Download this image"
                          onClick={async () => {
                            const blob = await getResultBlobs([item]).then((r) => r[0]?.blob);
                            const name = entryName(item, {
                              pattern: settings.filenamePattern,
                              total: plan.length,
                            });
                            if (blob) downloadBlob(blob, name);
                            else if (item.previewSrc) downloadBlob(item.previewSrc, name);
                            else setZipMsg('That image is no longer in the local cache.');
                          }}
                        >
                          ⬇
                        </button>
                      </div>
                    </div>
                  );
                }
                if (item.status === 'failed' || item.status === 'blocked') {
                  return (
                    <div className="tile failed" key={item.id}>
                      <div className="fail-body">
                        <div style={{ fontFamily: 'var(--mono)', fontWeight: 700, marginBottom: 5 }}>
                          #{String(item.index).padStart(3, '0')}
                        </div>
                        <div>{item.error?.title || 'Failed'}</div>
                        {item.attempts > 1 ? (
                          <div style={{ color: 'var(--muted)', marginTop: 5, fontSize: 10.5 }}>
                            {item.attempts} attempts
                          </div>
                        ) : null}
                      </div>
                    </div>
                  );
                }
                return (
                  <div className="tile skeleton" key={item.id}>
                    <div className="skel-inner">
                      {item.status === 'running' ? <div className="spinner" /> : null}
                      <div>#{String(item.index).padStart(3, '0')}</div>
                      <div>{item.status === 'running' ? 'rendering…' : 'queued'}</div>
                    </div>
                  </div>
                );
              })}
        </div>

        {pending.length ? (
          <p className="hint tight" style={{ marginTop: 12 }}>
            {pending.length} image{pending.length === 1 ? '' : 's'} still in the queue —{' '}
            {formatDuration(pending.length * 12 * 1000)} or so left at this pace.
          </p>
        ) : null}
      </div>

      {/* ---------------------------- lightbox ---------------------------- */}
      {active ? (
        <div className="lightbox" onClick={closeLightbox}>
          <div className="stage" onClick={(e) => e.stopPropagation()}>
            <img
              src={fullSrc || active.thumb || active.previewSrc}
              alt={`Image ${active.index}`}
              style={fullSrc ? undefined : { filter: 'blur(2px)', opacity: 0.7 }}
            />
            {!fullSrc ? (
              <div
                className="hint mono"
                style={{ position: 'absolute', bottom: 22, left: '50%', transform: 'translateX(-50%)' }}
              >
                loading full resolution…
              </div>
            ) : null}
            {lightbox > 0 ? (
              <button className="nav-btn prev" onClick={() => step(-1)} aria-label="Previous">
                ‹
              </button>
            ) : null}
            {lightbox < done.length - 1 ? (
              <button className="nav-btn next" onClick={() => step(1)} aria-label="Next">
                ›
              </button>
            ) : null}
          </div>

          <aside className="side" onClick={(e) => e.stopPropagation()}>
            <div className="row" style={{ justifyContent: 'space-between', marginBottom: 14 }}>
              <strong style={{ fontSize: 16, fontFamily: 'var(--mono)' }}>
                {entryName(active, { pattern: settings.filenamePattern, total: plan.length })}
              </strong>
              <button className="btn sm ghost" onClick={closeLightbox}>
                ✕
              </button>
            </div>

            <dl className="kv">
              <dt>Prompt #</dt>
              <dd>{active.promptIndex}</dd>
              <dt>Variation</dt>
              <dd>{active.variation}</dd>
              <dt>Model</dt>
              <dd>{active.model}</dd>
              <dt>Quality</dt>
              <dd>{active.tier}</dd>
              <dt>Size</dt>
              <dd>
                {active.width}×{active.height} · {formatBytes(active.bytes)}
              </dd>
              <dt>Aspect</dt>
              <dd>{active.aspect}</dd>
            </dl>

            <div style={{ marginTop: 14 }}>
              <div className="lbl" style={{ fontSize: 11, color: 'var(--muted-2)', marginBottom: 4 }}>
                PROMPT
              </div>
              <div
                style={{
                  fontSize: 12.5,
                  color: '#cfd5e4',
                  background: 'var(--panel-2)',
                  border: '1px solid var(--line-soft)',
                  borderRadius: 9,
                  padding: 10,
                  maxHeight: 190,
                  overflowY: 'auto',
                  whiteSpace: 'pre-wrap',
                }}
              >
                {active.prompt}
              </div>
            </div>

            <div className="row" style={{ marginTop: 14, gap: 7 }}>
              <button
                className="btn sm primary"
                onClick={async () => {
                  const blob = await getResultBlobs([active]).then((r) => r[0]?.blob);
                  const name = entryName(active, {
                    pattern: settings.filenamePattern,
                    total: plan.length,
                  });
                  if (blob) downloadBlob(blob, name);
                  else if (active.previewSrc) downloadBlob(active.previewSrc, name);
                }}
              >
                ⬇ Download
              </button>
              <CopyPromptButton prompt={active.prompt} />
            </div>
          </aside>
        </div>
      ) : null}
    </section>
  );
}

function CopyPromptButton({ prompt }) {
  const { copied, copy } = useCopy();
  return (
    <button className="btn sm ghost" onClick={() => copy(prompt)}>
      {copied ? '✓ Copied' : 'Copy prompt'}
    </button>
  );
}
