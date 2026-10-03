import React, { useEffect, useRef } from 'react';
import { formatBytes, formatDuration } from '../lib/imageUtils.js';
import { MODEL_BY_ID } from '../lib/constants.js';

const AVG_BYTES = { '512': 420_000, '1K': 1_700_000, '2K': 3_700_000, '4K': 9_400_000 };

export default function RunPanel({
  stats,
  phase,
  log,
  fatal,
  settings,
  dims,
  model,
  activeModelId,
  total,
  estimate,
  warnings,
  refCount,
  onPause,
  onResume,
  onCancel,
  onRetryFailed,
  startedAt,
}) {
  const logRef = useRef(null);

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [log]);

  const running = phase === 'running' || phase === 'paused';
  const runningModel = activeModelId ? MODEL_BY_ID[activeModelId] || model : model;
  const downgraded = !!runningModel && !!model && runningModel.id !== model.id;
  const avg = AVG_BYTES[settings.tier] || AVG_BYTES['1K'];
  const estZip = total * avg;
  const elapsed = startedAt && running ? Date.now() - startedAt : 0;
  const perImage = stats.finished > 1 ? elapsed / stats.finished : 0;
  const remainingMs = perImage * Math.max(0, total - stats.finished);

  return (
    <section className="card">
      <div className="card-head">
        <span className="step">6</span>
        <h2>Batch run</h2>
        <span className="sub">
          {running
            ? `${stats.done}/${stats.total} done`
            : stats.total
              ? `${stats.done}/${stats.total} generated`
              : 'ready when you are'}
        </span>
      </div>

      <div className="card-body">
        <div className="run-summary">
          <div className="metric">
            <div className="lbl">Images</div>
            <div className="val">{total}</div>
            <div className="sub">
              {settings.variations > 1 ? `×${settings.variations} per prompt` : 'one per prompt'}
            </div>
          </div>
          <div className="metric">
            <div className="lbl">Output</div>
            <div className="val">
              {dims ? `${dims.w}×${dims.h}` : '—'}
            </div>
            <div className="sub">{settings.tier} · {settings.outputFormat.toUpperCase()}</div>
          </div>
          <div className="metric">
            <div className="lbl">Model</div>
            <div className="val" style={{ fontSize: 14 }}>
              {runningModel?.short || '—'}
            </div>
            <div className="sub">
              {runningModel?.full}
              {downgraded ? ' · auto-downgraded' : ''}
            </div>
          </div>
          <div className="metric">
            <div className="lbl">Est. archive</div>
            <div className="val" style={{ fontSize: 15 }}>
              {formatBytes(estZip)}
            </div>
            <div className="sub">before ZIP overhead</div>
          </div>
          <div className="metric">
            <div className="lbl">Est. usage</div>
            <div className="val" style={{ fontSize: 15 }}>
              ${estimate.usd.toFixed(2)}
            </div>
            <div className="sub">${estimate.perImage.toFixed(3)}/image</div>
          </div>
        </div>

        {warnings.length ? (
          <div style={{ marginTop: 13, display: 'grid', gap: 8 }}>
            {warnings.map((w) => (
              <div className={`banner ${w.tone}`} key={w.id} style={{ marginBottom: 0 }}>
                <span className="ic">{w.icon}</span>
                <div>
                  <strong>{w.title}</strong>
                  <p>{w.body}</p>
                </div>
              </div>
            ))}
          </div>
        ) : null}

        {fatal ? (
          <div className="banner err" style={{ marginTop: 13, marginBottom: 0 }}>
            <span className="ic">🛑</span>
            <div>
              <strong>{fatal.title}</strong>
              <p>
                {fatal.hint} {fatal.message ? <span className="mono">({fatal.message})</span> : null}
              </p>
            </div>
          </div>
        ) : null}

        {stats.total ? (
          <div style={{ marginTop: 15 }}>
            <div className="row" style={{ justifyContent: 'space-between', marginBottom: 6 }}>
              <span className="hint">
                {stats.done} generated
                {stats.failed ? ` · ${stats.failed} failed` : ''}
                {stats.blocked ? ` · ${stats.blocked} blocked` : ''}
                {stats.running ? ` · ${stats.running} in flight` : ''}
                {stats.queued ? ` · ${stats.queued} queued` : ''}
              </span>
              <span className="hint mono">{stats.percent}%</span>
            </div>
            <div className="progress">
              <i style={{ width: `${stats.percent}%` }} />
            </div>

            <div className="row" style={{ marginTop: 11, justifyContent: 'space-between' }}>
              <div className="row" style={{ gap: 7 }}>
                {phase === 'running' ? (
                  <button className="btn sm" onClick={onPause}>
                    ⏸ Pause
                  </button>
                ) : null}
                {phase === 'paused' ? (
                  <button className="btn sm primary" onClick={onResume}>
                    ▶ Resume
                  </button>
                ) : null}
                {running ? (
                  <button className="btn sm danger" onClick={onCancel}>
                    ✕ Stop
                  </button>
                ) : null}
                {!running && (stats.failed || stats.blocked || stats.cancelled) ? (
                  <button className="btn sm ok" onClick={onRetryFailed}>
                    ↻ Retry {stats.failed + stats.blocked + stats.cancelled} unfinished
                  </button>
                ) : null}
              </div>
              <span className="hint mono">
                {stats.bytesLabel} · {stats.running ? `~${formatDuration(remainingMs)} left` : `${stats.finished}/${stats.total}`}
              </span>
            </div>
          </div>
        ) : null}

        {log.length ? (
          <div ref={logRef} className="log" style={{ marginTop: 13 }}>
            {log.slice(-120).map((l) => (
              <div className={`log-line ${l.level}`} key={l.id}>
                <span className="t">
                  {new Date(l.at).toLocaleTimeString([], {
                    hour: '2-digit',
                    minute: '2-digit',
                    second: '2-digit',
                  })}
                </span>
                <span className="m">{l.text}</span>
              </div>
            ))}
          </div>
        ) : null}
      </div>
    </section>
  );
}
