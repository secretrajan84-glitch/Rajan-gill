import React, { useMemo, useRef, useState } from 'react';
import { entryName } from '../lib/zip.js';

const LINE_RE = /\r?\n/;

export default function PromptPanel({
  promptsText,
  setPromptsText,
  variations,
  setVariations,
  targetCount,
  setTargetCount,
  filenamePattern,
  setFilenamePattern,
  onSuggest,
  onEnhanceAll,
  busy,
  disabled,
}) {
  const fileRef = useRef(null);
  const [theme, setTheme] = useState('');
  const [themeCount, setThemeCount] = useState(10);
  const [localMsg, setLocalMsg] = useState(null);

  const lines = useMemo(
    () =>
      promptsText
        .split(LINE_RE)
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith('#')),
    [promptsText],
  );

  const perPrompt = Math.max(1, Number(variations) || 1);
  const auto = lines.length * perPrompt;
  const total = Number(targetCount) > 0 ? Math.min(Number(targetCount), 2000) : auto;

  /** First, second and last file names, so the pattern is provable before a run. */
  const preview = useMemo(() => {
    if (!lines.length || !total) return [];
    const at = (i) => ({
      index: i + 1,
      promptIndex: (i % lines.length) + 1,
      variation: Math.floor(i / lines.length) + 1,
      mime: 'image/png',
    });
    const picks = [...new Set([0, 1, total - 1].filter((i) => i >= 0 && i < total))];
    return picks.map((i) => entryName(at(i), { pattern: filenamePattern, total }));
  }, [lines.length, total, filenamePattern]);

  const importFile = async (file) => {
    try {
      const text = await file.text();
      let rows = text;
      if (file.name.toLowerCase().endsWith('.csv')) {
        rows = text
          .split(LINE_RE)
          .map((line) => {
            // first column of each CSV row, honouring simple quoting
            const m = line.match(/^\s*"((?:[^"]|"")*)"|^\s*([^,]*)/);
            return (m?.[1] ?? m?.[2] ?? '').replace(/""/g, '"');
          })
          .filter((l) => l && !/^prompt$/i.test(l.trim()))
          .join('\n');
      }
      setPromptsText((prev) => (prev.trim() ? `${prev.trimEnd()}\n${rows}` : rows));
      setLocalMsg(`Imported ${file.name}`);
    } catch (err) {
      setLocalMsg(`Could not read ${file.name}: ${err.message}`);
    }
  };

  const dedupe = () => {
    const seen = new Set();
    const out = lines.filter((l) => {
      const k = l.toLowerCase();
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    setPromptsText(out.join('\n'));
    setLocalMsg(`Removed ${lines.length - out.length} duplicate line(s).`);
  };

  const shuffle = () => {
    const out = [...lines];
    for (let i = out.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1));
      [out[i], out[j]] = [out[j], out[i]];
    }
    setPromptsText(out.join('\n'));
  };

  return (
    <section className="card">
      <div className="card-head">
        <span className="step">3</span>
        <h2>Bulk prompts</h2>
        <span className="sub">one prompt per line</span>
      </div>

      <div className="card-body">
        <textarea
          rows={12}
          value={promptsText}
          onChange={(e) => setPromptsText(e.target.value)}
          disabled={disabled}
          spellCheck={false}
          placeholder={`a lone lighthouse keeper on a stormy cliff\na bustling night market seen from a rooftop\nan astronaut botanist tending greenhouse tomatoes\n…`}
        />

        <div className="prompt-stats">
          <span className="pill accent">{lines.length} prompt{lines.length === 1 ? '' : 's'}</span>
          <span className="pill">× {perPrompt} variation{perPrompt === 1 ? '' : 's'}</span>
          <span className={`pill ${total > 400 ? 'warn' : 'info'}`}>→ {total} images</span>
          {lines.length ? (
            <span className="pill mono">
              001 → {String(total).padStart(Math.max(3, String(total).length), '0')}
            </span>
          ) : null}
        </div>

        <div className="row" style={{ marginTop: 10, gap: 6 }}>
          <button className="btn xs ghost" onClick={() => fileRef.current?.click()} disabled={disabled}>
            ⤒ Import .txt / .csv
          </button>
          <button className="btn xs ghost" onClick={dedupe} disabled={disabled || !lines.length}>
            Dedupe
          </button>
          <button className="btn xs ghost" onClick={shuffle} disabled={disabled || lines.length < 2}>
            Shuffle
          </button>
          <button
            className="btn xs ghost danger"
            onClick={() => setPromptsText('')}
            disabled={disabled || !promptsText}
          >
            Clear
          </button>
          <input
            ref={fileRef}
            type="file"
            accept=".txt,.csv,text/plain,text/csv"
            className="sr"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) importFile(f);
              e.target.value = '';
            }}
          />
        </div>

        {localMsg ? <p className="hint tight">{localMsg}</p> : null}

        {/* ---- AI prompt helpers ---- */}
        <div
          style={{
            marginTop: 14,
            paddingTop: 13,
            borderTop: '1px solid var(--line-soft)',
            display: 'grid',
            gap: 10,
          }}
        >
          <div className="row" style={{ gap: 8 }}>
            <input
              type="text"
              value={theme}
              onChange={(e) => setTheme(e.target.value)}
              placeholder="Theme — e.g. rainy Tokyo alleyways at night"
              disabled={disabled}
              style={{ flex: 1, minWidth: 180 }}
            />
            <input
              type="number"
              min={1}
              max={100}
              value={themeCount}
              onChange={(e) => setThemeCount(Number(e.target.value))}
              disabled={disabled}
              style={{ width: 76 }}
              title="How many prompts to write"
            />
            <button
              className="btn sm"
              disabled={disabled || busy === 'suggest' || !theme.trim()}
              onClick={async () => {
                setLocalMsg(null);
                try {
                  await onSuggest(theme.trim(), themeCount);
                } catch (err) {
                  setLocalMsg(err.message);
                }
              }}
            >
              {busy === 'suggest' ? 'Writing…' : '✨ Write prompts in my style'}
            </button>
          </div>

          <div className="row" style={{ gap: 8 }}>
            <button
              className="btn sm ghost"
              disabled={disabled || busy === 'enhance' || !lines.length}
              onClick={async () => {
                setLocalMsg(null);
                try {
                  await onEnhanceAll();
                } catch (err) {
                  setLocalMsg(err.message);
                }
              }}
              title="Rewrite every prompt with more craft, still in your reference style"
            >
              {busy === 'enhance' ? 'Rewriting…' : '🪄 Enrich every prompt'}
            </button>
            <span className="hint">Keeps your subjects — adds framing, light and materials.</span>
          </div>
        </div>

        {/* ---- batch sizing ---- */}
        <div
          style={{
            marginTop: 14,
            paddingTop: 13,
            borderTop: '1px solid var(--line-soft)',
            display: 'grid',
            gap: 12,
          }}
        >
          <div className="grid-settings">
            <label className="field">
              <span>Variations per prompt</span>
              <input
                type="number"
                min={1}
                max={50}
                value={variations}
                disabled={disabled}
                onChange={(e) => setVariations(Math.max(1, Math.min(50, Number(e.target.value) || 1)))}
              />
            </label>
            <label className="field">
              <span>Target image count</span>
              <input
                type="number"
                min={0}
                max={2000}
                value={targetCount || ''}
                placeholder={auto ? `${auto} (auto)` : 'auto'}
                disabled={disabled}
                onChange={(e) => setTargetCount(Math.max(0, Number(e.target.value) || 0))}
              />
            </label>
            <label className="field">
              <span>File name pattern</span>
              <input
                type="text"
                value={filenamePattern}
                disabled={disabled}
                onChange={(e) => setFilenamePattern(e.target.value)}
                placeholder="{index}"
              />
            </label>
          </div>

          <div className="quick-fill">
            <span className="hint" style={{ alignSelf: 'center' }}>
              Quick batch:
            </span>
            {[50, 100, 200, 500].map((n) => (
              <button
                key={n}
                className="btn xs"
                disabled={disabled || !lines.length}
                onClick={() => setTargetCount(n)}
                title={
                  lines.length
                    ? `Cycle your ${lines.length} prompt(s) until ${n} images are queued`
                    : 'Add prompts first'
                }
              >
                {n}
              </button>
            ))}
            <button className="btn xs ghost" disabled={disabled} onClick={() => setTargetCount(0)}>
              auto
            </button>
          </div>

          {preview.length ? (
            <div className="hint mono" style={{ fontSize: 11.5 }}>
              Files →&nbsp;{preview.length > 2 ? `${preview[0]}, … , ${preview[2]}` : preview.join(', ')}
              <span style={{ marginLeft: 8, color: 'var(--muted-2)' }}>
                ({total} file{total === 1 ? '' : 's'} in the ZIP)
              </span>
            </div>
          ) : null}
          {targetCount > 0 && lines.length ? (
            <p className="hint">
              Your {lines.length} prompt{lines.length === 1 ? '' : 's'} will be cycled to reach{' '}
              {total} images — each pass counts as another variation.
            </p>
          ) : null}
        </div>
      </div>
    </section>
  );
}
