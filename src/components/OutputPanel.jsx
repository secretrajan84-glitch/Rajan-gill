import React from 'react';
import { MODELS, CONCURRENCY_PRESETS } from '../lib/constants.js';

const TIER_LABEL = { 512: '512px', '1K': '1K', '2K': '2K', '4K': '4K' };

export default function OutputPanel({ settings, update, disabled }) {
  const model = MODELS.find((m) => m.id === settings.modelId) || MODELS[0];
  const tier = model.tiers.includes(settings.tier) ? settings.tier : model.defaultTier;

  return (
    <section className="card">
      <div className="card-head">
        <span className="step">5</span>
        <h2>Engine &amp; output</h2>
        <span className="sub">
          {model.short} · {tier}
        </span>
      </div>

      <div className="card-body">
        {/* ------------------------- model picker ------------------------- */}
        <div className="grid-settings" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(230px, 1fr))' }}>
          {MODELS.map((m) => {
            const active = m.id === settings.modelId;
            return (
              <button
                key={m.id}
                onClick={() => !disabled && update({ modelId: m.id, tier: m.defaultTier })}
                disabled={disabled}
                className="metric"
                style={{
                  textAlign: 'left',
                  cursor: 'pointer',
                  borderColor: active ? 'var(--accent)' : 'var(--line-soft)',
                  background: active
                    ? 'linear-gradient(180deg, rgba(255,198,60,0.12), rgba(255,134,61,0.04))'
                    : 'var(--panel-2)',
                  transition: '0.15s',
                }}
                aria-pressed={active}
              >
                <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
                  <div className="val" style={{ fontSize: 14, fontFamily: 'inherit' }}>
                    {m.short}
                  </div>
                  <span className={`pill ${active ? 'accent' : ''}`} style={{ fontSize: 10 }}>
                    {m.badge}
                  </span>
                </div>
                <div className="sub" style={{ marginTop: 5, lineHeight: 1.45 }}>
                  {m.blurb}
                </div>
                <div className="row" style={{ marginTop: 7, gap: 5 }}>
                  <span className="pill" style={{ fontSize: 10 }}>
                    {m.tiers.map((t) => TIER_LABEL[t] || t).join(' / ')}
                  </span>
                  <span className="pill" style={{ fontSize: 10 }}>
                    ≈${(m.price[m.defaultTier] || 0).toFixed(3)}/img
                  </span>
                  {m.maxRefs ? (
                    <span className="pill" style={{ fontSize: 10 }}>
                      refs: {m.refs}
                    </span>
                  ) : (
                    <span className="pill warn" style={{ fontSize: 10 }}>
                      no refs
                    </span>
                  )}
                </div>
              </button>
            );
          })}
        </div>

        {/* -------------------------- resolution -------------------------- */}
        <div style={{ marginTop: 16 }}>
          <label className="field">
            <span>Resolution</span>
          </label>
          <div className="row" style={{ gap: 7 }}>
            {model.tiers.map((t) => (
              <button
                key={t}
                className={`btn sm${t === tier ? ' primary' : ''}`}
                onClick={() => !disabled && update({ tier: t })}
                disabled={disabled}
              >
                {TIER_LABEL[t] || t}
              </button>
            ))}
            {model.tiers.includes('4K') ? (
              <span className="hint">
                4K costs ~{Math.round(((model.price['4K'] || 0) / (model.price['1K'] || 1)) * 100 - 100)}%
                more per image.
              </span>
            ) : null}
          </div>
          {model.maxRefs === 0 ? (
            <p className="hint tight">
              ⚠ This model cannot see reference images — style matching falls back to the Style DNA
              text only.
            </p>
          ) : null}
        </div>

        {/* -------------------------- concurrency ------------------------- */}
        <div className="grid-settings" style={{ marginTop: 16 }}>
          <label className="field">
            <span>Images at a time</span>
            <select
              value={settings.concurrency}
              onChange={(e) => update({ concurrency: Number(e.target.value) })}
              disabled={disabled}
            >
              {CONCURRENCY_PRESETS.map((p) => (
                <option key={p.value} value={p.value}>
                  {p.label}
                </option>
              ))}
            </select>
          </label>

          <label className="field">
            <span>Output format</span>
            <select
              value={settings.outputFormat}
              onChange={(e) => update({ outputFormat: e.target.value })}
              disabled={disabled}
            >
              <option value="png">PNG — lossless</option>
              <option value="jpg">JPG — smaller files</option>
              <option value="webp">WebP — smallest</option>
            </select>
          </label>

          <label className="field">
            <span>First file number</span>
            <input
              type="number"
              min={1}
              max={9999}
              value={settings.indexStart}
              onChange={(e) => update({ indexStart: Math.max(1, Number(e.target.value) || 1) })}
              disabled={disabled}
            />
          </label>
        </div>

        {/* ---------------------------- advanced -------------------------- */}
        <details style={{ marginTop: 14 }}>
          <summary
            style={{ cursor: 'pointer', fontSize: 13, color: 'var(--muted)', userSelect: 'none' }}
          >
            Advanced
          </summary>
          <div style={{ marginTop: 10, display: 'grid', gap: 4 }}>
            <label className="switch">
              <input
                type="checkbox"
                checked={settings.sendReferences}
                onChange={(e) => update({ sendReferences: e.target.checked })}
                disabled={disabled}
              />
              <span className="switch-text">
                Send reference images with every request
                <small>
                  Strongest style lock, and the main reason output looks like your references. Turn
                  it off to save credit at the cost of fidelity.
                </small>
              </span>
            </label>

            <label className="field" style={{ maxWidth: 260, marginTop: 6 }}>
              <span>References per request</span>
              <input
                type="number"
                min={1}
                max={14}
                value={settings.maxRefsPerCall}
                onChange={(e) =>
                  update({ maxRefsPerCall: Math.max(1, Math.min(14, Number(e.target.value) || 1)) })
                }
                disabled={disabled || !settings.sendReferences}
              />
            </label>
            <p className="hint">
              More references = tighter style lock but a slower, pricier request. 4–6 is the sweet
              spot.
            </p>

            <label className="switch" style={{ marginTop: 6 }}>
              <input
                type="checkbox"
                checked={settings.autoDowngrade}
                onChange={(e) => update({ autoDowngrade: e.target.checked })}
                disabled={disabled}
              />
              <span className="switch-text">
                Stay alive when credit runs out
                <small>
                  Automatically falls back to a cheaper Nano Banana tier instead of killing a
                  200-image run halfway.
                </small>
              </span>
            </label>

            <label className="switch">
              <input
                type="checkbox"
                checked={settings.includeManifest}
                onChange={(e) => update({ includeManifest: e.target.checked })}
                disabled={disabled}
              />
              <span className="switch-text">
                Include manifest.csv + prompts.txt in the ZIP
                <small>Maps every numbered file back to the prompt that produced it.</small>
              </span>
            </label>

            <label className="field" style={{ maxWidth: 300, marginTop: 6 }}>
              <span>Split the ZIP every N images (0 = one file)</span>
              <input
                type="number"
                min={0}
                max={1000}
                value={settings.zipSplit}
                onChange={(e) => update({ zipSplit: Math.max(0, Number(e.target.value) || 0) })}
                disabled={disabled}
              />
            </label>
            <p className="hint">
              Keep at 0 for a single archive. Splitting helps browsers with limited memory when a
              batch runs into the hundreds of megabytes.
            </p>
          </div>
        </details>
      </div>
    </section>
  );
}
