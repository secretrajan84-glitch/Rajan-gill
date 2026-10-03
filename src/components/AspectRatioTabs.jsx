import React from 'react';
import { ASPECT_RATIOS, TIER_PIXELS } from '../lib/constants.js';

const MAX = 40;

/** Little proportional rectangle used inside each tab. */
function Shape({ w, h }) {
  let width;
  let height;
  if (w >= h) {
    width = MAX;
    height = Math.round((MAX * h) / w);
  } else {
    height = MAX;
    width = Math.round((MAX * w) / h);
  }
  return (
    <i
      style={{
        width: `${Math.max(width, 8)}px`,
        height: `${Math.max(height, 8)}px`,
      }}
    />
  );
}

/**
 * The aspect-ratio tab bar.
 *
 * These are the ten shapes Gemini's image models render natively, so nothing
 * gets silently snapped to a different ratio. `ratio: { w, h }` is forwarded to
 * Puter.js verbatim.
 */
export default function AspectRatioTabs({ value, onChange, tier, customW, customH, onCustom, disabled }) {
  const base = TIER_PIXELS[tier] || 1024;

  const pixelsFor = (ratio) => {
    const area = base * base;
    const round = (n) => Math.max(64, Math.round(n / 32) * 32);
    return {
      w: round(Math.sqrt((area * ratio.w) / ratio.h)),
      h: round(Math.sqrt((area * ratio.h) / ratio.w)),
    };
  };

  return (
    <section className="card">
      <div className="card-head">
        <span className="step">4</span>
        <h2>Aspect ratio</h2>
        <span className="sub">applied to every image in the batch</span>
      </div>

      <div className="card-body">
        <div className="aspect-tabs" role="tablist" aria-label="Aspect ratio">
          {ASPECT_RATIOS.map((r) => {
            const px = pixelsFor(r);
            const active = value === r.id;
            return (
              <button
                key={r.id}
                role="tab"
                aria-selected={active}
                className={`aspect-tab${active ? ' active' : ''}`}
                onClick={() => !disabled && onChange(r.id)}
                disabled={disabled}
                title={`${r.use} · ≈${px.w}×${px.h}`}
              >
                <div className="shape">
                  <Shape w={r.w} h={r.h} />
                </div>
                <div className="id">{r.label}</div>
                <div className="note">{r.note}</div>
              </button>
            );
          })}

          <button
            role="tab"
            aria-selected={value === 'custom'}
            className={`aspect-tab${value === 'custom' ? ' active' : ''}`}
            onClick={() => !disabled && onChange('custom')}
            disabled={disabled}
            title="Any ratio — Gemini snaps it to the nearest shape it can render"
          >
            <div className="shape">
              <i style={{ width: 34, height: 26, borderStyle: 'dashed' }} />
            </div>
            <div className="id">
              {value === 'custom' ? `${customW}:${customH}` : 'Custom'}
            </div>
            <div className="note">snaps</div>
          </button>
        </div>

        {value === 'custom' ? (
          <div className="row" style={{ marginTop: 4 }}>
            <input
              type="number"
              min={1}
              max={64}
              value={customW}
              onChange={(e) => onCustom('w', Number(e.target.value) || 1)}
              style={{ width: 78 }}
              disabled={disabled}
            />
            <span className="mono" style={{ color: 'var(--muted)' }}>
              :
            </span>
            <input
              type="number"
              min={1}
              max={64}
              value={customH}
              onChange={(e) => onCustom('h', Number(e.target.value) || 1)}
              style={{ width: 78 }}
              disabled={disabled}
            />
            <span className="hint">
              Non-native ratios are rounded to the closest shape Gemini can actually render.
            </span>
          </div>
        ) : null}

        <p className="hint tight">
          Every generated file in the ZIP uses this one ratio, so the whole set drops straight into a
          layout.
        </p>
      </div>
    </section>
  );
}
