import React, { useState } from 'react';
import { styleToText } from '../lib/styleEngine.js';
import { useCopy } from '../hooks/useLocalState.js';

const FIELDS = [
  { key: 'summary', label: 'Look' },
  { key: 'medium', label: 'Medium' },
  { key: 'lighting', label: 'Lighting' },
  { key: 'texture', label: 'Texture' },
  { key: 'linework', label: 'Linework' },
  { key: 'composition', label: 'Composition' },
  { key: 'cameraOrRender', label: 'Camera' },
];

const LIST_FIELDS = [
  { key: 'mood', label: 'Mood' },
  { key: 'keywords', label: 'Keywords' },
  { key: 'mustAvoid', label: 'Avoid' },
];

export default function StylePanel({
  refs,
  style,
  setStyle,
  onAnalyze,
  analyzing,
  progress,
  error,
  useStyleDna,
  setUseStyleDna,
  strength,
  setStrength,
  disabled,
}) {
  const [editing, setEditing] = useState(false);
  const { copied, copy } = useCopy();

  const update = (key, value) => setStyle((s) => ({ ...s, [key]: value }));
  const updateList = (key, value) =>
    setStyle((s) => ({
      ...s,
      [key]: String(value)
        .split(',')
        .map((x) => x.trim())
        .filter(Boolean),
    }));

  const isEmpty = !style?.analysed;

  return (
    <section className="card">
      <div className="card-head">
        <span className="step">2</span>
        <h2>Style DNA</h2>
        <span className="sub">
          {style?.analysed ? `${style.refCount} ref(s) analysed` : 'not analysed yet'}
        </span>
      </div>

      <div className="card-body">
        {error ? (
          <div className="banner warn" style={{ marginBottom: 12 }}>
            <span className="ic">⚠</span>
            <div>
              <strong>Style analysis did not finish</strong>
              <p>{error}</p>
            </div>
          </div>
        ) : null}

        {isEmpty ? (
          <div className="empty" style={{ padding: '28px 16px' }}>
            <div className="big">🎨</div>
            <p style={{ margin: '0 0 12px' }}>
              {refs.length
                ? 'Ready — read the visual DNA out of your references.'
                : 'Upload reference images above, then analyse them.'}
            </p>
            <button
              className="btn primary"
              onClick={onAnalyze}
              disabled={disabled || analyzing || !refs.length}
            >
              {analyzing
                ? `Analysing${progress ? ` ${progress.done}/${progress.total}` : ''}…`
                : '✨ Analyse reference style'}
            </button>
          </div>
        ) : (
          <>
            <div className="row" style={{ justifyContent: 'space-between', marginBottom: 4 }}>
              <div className="row" style={{ gap: 6 }}>
                <span className="pill ok">
                  <span className="dot" /> Style locked
                </span>
                {style.analysed ? <span className="pill">{style.refCount} refs</span> : null}
              </div>
              <div className="row" style={{ gap: 6 }}>
                <button className="btn xs" onClick={() => copy(styleToText(style))}>
                  {copied ? '✓ Copied' : 'Copy'}
                </button>
                <button className="btn xs" onClick={() => setEditing((v) => !v)}>
                  {editing ? 'Done' : 'Edit'}
                </button>
                <button
                  className="btn xs ghost"
                  onClick={onAnalyze}
                  disabled={disabled || analyzing || !refs.length}
                  title="Re-read the references"
                >
                  {analyzing ? '…' : '↻'}
                </button>
              </div>
            </div>

            {editing ? (
              <div className="dna-grid">
                {FIELDS.map((f) => (
                  <div className="dna-row" key={f.key}>
                    <div className="k">{f.label}</div>
                    <div className="v">
                      <input
                        type="text"
                        value={style[f.key] || ''}
                        onChange={(e) => update(f.key, e.target.value)}
                      />
                    </div>
                  </div>
                ))}
                <div className="dna-row">
                  <div className="k">Palette</div>
                  <div className="v">
                    <input
                      type="text"
                      value={(style.palette || []).join(', ')}
                      onChange={(e) => updateList('palette', e.target.value)}
                      placeholder="#111111, #f2c14e, …"
                    />
                  </div>
                </div>
                {LIST_FIELDS.map((f) => (
                  <div className="dna-row" key={f.key}>
                    <div className="k">{f.label}</div>
                    <div className="v">
                      <input
                        type="text"
                        value={(style[f.key] || []).join(', ')}
                        onChange={(e) => updateList(f.key, e.target.value)}
                      />
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="dna-grid">
                {style.summary ? (
                  <div className="dna-row">
                    <div className="k">Look</div>
                    <div className="v">{style.summary}</div>
                  </div>
                ) : null}
                {FIELDS.filter((f) => f.key !== 'summary' && style[f.key]).map((f) => (
                  <div className="dna-row" key={f.key}>
                    <div className="k">{f.label}</div>
                    <div className="v">{style[f.key]}</div>
                  </div>
                ))}
                {style.palette?.length ? (
                  <div className="dna-row">
                    <div className="k">Palette</div>
                    <div className="v">
                      <div className="swatches">
                        {style.palette.map((c, i) => (
                          <div
                            className="swatch"
                            key={`${c}-${i}`}
                            style={{ background: c }}
                            title={c}
                            onClick={() => copy(c)}
                          />
                        ))}
                      </div>
                    </div>
                  </div>
                ) : null}
                {style.mood?.length ? (
                  <div className="dna-row">
                    <div className="k">Mood</div>
                    <div className="v">
                      <div className="chips">
                        {style.mood.map((m, i) => (
                          <span className="chip" key={`${m}-${i}`}>
                            {m}
                          </span>
                        ))}
                      </div>
                    </div>
                  </div>
                ) : null}
                {style.keywords?.length ? (
                  <div className="dna-row">
                    <div className="k">Keywords</div>
                    <div className="v">
                      <div className="chips">
                        {style.keywords.map((k, i) => (
                          <span className="chip" key={`${k}-${i}`}>
                            {k}
                          </span>
                        ))}
                      </div>
                    </div>
                  </div>
                ) : null}
                {style.mustAvoid?.length ? (
                  <div className="dna-row">
                    <div className="k">Avoid</div>
                    <div className="v">
                      <div className="chips">
                        {style.mustAvoid.map((k, i) => (
                          <span className="chip" key={`${k}-${i}`} style={{ color: 'var(--warn)' }}>
                            {k}
                          </span>
                        ))}
                      </div>
                    </div>
                  </div>
                ) : null}
              </div>
            )}
          </>
        )}

        <div style={{ marginTop: 14, borderTop: '1px solid var(--line-soft)', paddingTop: 12 }}>
          <label className="switch">
            <input
              type="checkbox"
              checked={useStyleDna}
              onChange={(e) => setUseStyleDna(e.target.checked)}
              disabled={disabled}
            />
            <span className="switch-text">
              Apply Style DNA to every prompt
              <small>
                Appends the style brief to all 200 prompts so the whole batch reads as one series.
              </small>
            </span>
          </label>

          <label className="field" style={{ marginTop: 8, maxWidth: 260 }}>
            <span>Style strength</span>
            <select
              value={strength}
              onChange={(e) => setStrength(e.target.value)}
              disabled={disabled || !useStyleDna}
            >
              <option value="light">Light — prompt wins</option>
              <option value="balanced">Balanced — default</option>
              <option value="strict">Strict — locked house style</option>
            </select>
          </label>
        </div>
      </div>
    </section>
  );
}
