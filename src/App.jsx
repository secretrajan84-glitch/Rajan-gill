import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import TopBar from './components/TopBar.jsx';
import ReferencePanel from './components/ReferencePanel.jsx';
import StylePanel from './components/StylePanel.jsx';
import PromptPanel from './components/PromptPanel.jsx';
import AspectRatioTabs from './components/AspectRatioTabs.jsx';
import OutputPanel from './components/OutputPanel.jsx';
import RunPanel from './components/RunPanel.jsx';
import ResultsPanel from './components/ResultsPanel.jsx';

import { useGenerator, estimateCost, outputDimensions, ratioFor } from './hooks/useGenerator.js';
import { useLocalState } from './hooks/useLocalState.js';
import { analyzeStyle, enhancePrompt, suggestPrompts, EMPTY_STYLE } from './lib/styleEngine.js';
import { MODEL_BY_ID, DEFAULT_SETTINGS } from './lib/constants.js';
import { idb, STORE_NAMES } from './lib/idb.js';
import { getUser, isSignedIn, signIn, onUsageLimit } from './lib/puterClient.js';
import { formatBytes } from './lib/imageUtils.js';
import { requestPersistence, storageEstimate, formatQuota } from './lib/storage.js';

export default function App() {
  /* ------------------------------ state ------------------------------ */
  const [settings, setSettings] = useLocalState('sf.settings', DEFAULT_SETTINGS);
  const [promptsText, setPromptsText] = useLocalState('sf.prompts', '');
  const [refs, setRefs] = useState([]);
  const [style, setStyle] = useState(EMPTY_STYLE);
  const [analyzing, setAnalyzing] = useState(false);
  const [analyzeProgress, setAnalyzeProgress] = useState(null);
  const [analyzeError, setAnalyzeError] = useState(null);
  const [busy, setBusy] = useState(null);
  const [actionError, setActionError] = useState(null);
  const [helpOpen, setHelpOpen] = useState(false);
  const [signedIn, setSignedIn] = useState(false);
  const [buildingZip, setBuildingZip] = useState(false);
  const [startedAt, setStartedAt] = useState(null);
  const [booted, setBooted] = useState(false);
  const [creditHit, setCreditHit] = useState(false);
  const [persisted, setPersisted] = useState(null);
  const [storage, setStorage] = useState(null);

  const gen = useGenerator();
  const fileRestored = useRef(false);

  /* Puter's own upgrade modal is removed by the client; surface it inline. */
  useEffect(() => onUsageLimit(() => setCreditHit(true)), []);

  const update = useCallback(
    (patch) => setSettings((s) => ({ ...s, ...patch })),
    [setSettings],
  );

  /* ------------------------------ boot ------------------------------- */
  useEffect(() => {
    (async () => {
      try {
        const stored = await idb.all(STORE_NAMES.REFS);
        if (stored?.length) {
          stored.sort((a, b) => (a.order || 0) - (b.order || 0));
          setRefs(stored);
        }
      } catch {
        /* ignore */
      }
      // Only start mirroring refs to IndexedDB once the first read finished,
      // otherwise we would wipe what we are about to load.
      fileRestored.current = true;

      const session = await gen.restore();
      if (session) {
        if (session.prompts) setPromptsText(session.prompts);
        if (session.settings) setSettings((s) => ({ ...s, ...session.settings }));
        if (session.style) setStyle({ ...EMPTY_STYLE, ...session.style });
      }

      setSignedIn(isSignedIn());
      setBooted(true);
      getUser().then((u) => setSignedIn(!!u));

      // Ask the browser to keep our results, then read the quota.
      requestPersistence().then(setPersisted);
      storageEstimate().then(setStorage);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* persist references so a refresh does not lose a 40-image upload set */
  useEffect(() => {
    if (!fileRestored.current) return;
    idb
      .clear(STORE_NAMES.REFS)
      .then(() => idb.putAll(STORE_NAMES.REFS, refs.map((r, i) => ({ ...r, order: i }))))
      .catch(() => {});
  }, [refs]);

  /* Refresh the quota reading as results accumulate (cheap, debounced). */
  const doneCount = gen.stats.done;
  useEffect(() => {
    if (!doneCount || doneCount % 10 !== 0) return undefined;
    const t = setTimeout(() => storageEstimate().then(setStorage), 1200);
    return () => clearTimeout(t);
  }, [doneCount]);

  /* ---------------------------- derived ------------------------------ */
  const lines = useMemo(
    () =>
      promptsText
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith('#')),
    [promptsText],
  );

  const autoTotal = lines.length * Math.max(1, Number(settings.variations) || 1);
  const total = Number(settings.targetCount) > 0 ? Math.min(Number(settings.targetCount), 2000) : autoTotal;

  const model = MODEL_BY_ID[settings.modelId] || MODEL_BY_ID[DEFAULT_SETTINGS.modelId];
  const dims = outputDimensions(settings);
  const estimate = estimateCost({ count: total, modelId: settings.modelId, tier: settings.tier });

  const aspectRatio = ratioFor(settings);

  /* Rough bytes the finished batch will occupy on disk / in the browser. */
  const AVG_BYTES = { '512': 420_000, '1K': 1_700_000, '2K': 3_700_000, '4K': 9_400_000 };
  const FORMAT_FACTOR = { png: 1, jpg: 0.3, webp: 0.24 };
  const planBytes =
    total * (AVG_BYTES[dims.tier] || AVG_BYTES['1K']) * (FORMAT_FACTOR[settings.outputFormat] || 1);

  /* ------------------------------ actions ---------------------------- */

  /**
   * Everything AI-related needs a Puter session. The SDK would otherwise open
   * its sign-in popup in the middle of a background request, where a blocker
   * can swallow it and leave the promise hanging. Asking here means the sign-in
   * happens on a real user gesture, with a real error if it is blocked.
   */
  const requireAuth = useCallback(async () => {
    if (isSignedIn()) return true;
    try {
      await signIn();
      setSignedIn(true);
      return true;
    } catch (err) {
      const msg = String(err?.message || err);
      setActionError(
        /popup|blocked|window/i.test(msg)
          ? 'The Puter sign-in popup was blocked. Allow popups for this page (or open StyleForge in its own browser tab), then press the button again.'
          : `Sign-in failed: ${msg}`,
      );
      return false;
    }
  }, []);

  const handleAnalyze = useCallback(async () => {
    if (!refs.length) return;
    if (!(await requireAuth())) return;
    setAnalyzing(true);
    setAnalyzeError(null);
    setAnalyzeProgress({ done: 0, total: Math.ceil(Math.min(refs.length, 18) / 6) });
    try {
      const { profile, problems } = await analyzeStyle(refs, {
        chunkSize: 6,
        onProgress: (done, t) => setAnalyzeProgress({ done, total: t }),
      });
      setStyle(profile);
      if (problems?.length) setAnalyzeError(problems[0]);
    } catch (err) {
      setAnalyzeError(err.message);
    } finally {
      setAnalyzing(false);
      setAnalyzeProgress(null);
    }
  }, [refs, requireAuth]);

  const handleSuggest = useCallback(
    async (theme, count) => {
      if (!(await requireAuth())) return;
      setBusy('suggest');
      setActionError(null);
      try {
        const out = await suggestPrompts({
          theme,
          count,
          style: style.analysed ? style : null,
          aspectId: settings.aspect,
        });
        setPromptsText((prev) => (prev.trim() ? `${prev.trimEnd()}\n${out.join('\n')}` : out.join('\n')));
      } finally {
        setBusy(null);
      }
    },
    [style, settings.aspect, setPromptsText, requireAuth],
  );

  const handleEnhanceAll = useCallback(async () => {
    if (
      lines.length > 30 &&
      !window.confirm(
        `Rewrite ${lines.length} prompts? That is ${lines.length} text-model calls, one after another — it will take a few minutes.`,
      )
    ) {
      return;
    }
    if (!(await requireAuth())) return;
    setBusy('enhance');
    setActionError(null);
    try {
      const next = [];
      for (const line of lines) {
        // Sequential on purpose: a 200-prompt burst would trip the same rate
        // limiter the image queue depends on.
        next.push(
          await enhancePrompt(line, {
            style: style.analysed ? style : null,
            aspectId: settings.aspect,
          }),
        );
      }
      setPromptsText(next.join('\n'));
    } finally {
      setBusy(null);
    }
  }, [lines, style, settings.aspect, setPromptsText, requireAuth]);

  const handleStart = useCallback(async () => {
    if (!lines.length) return;
    if (!(await requireAuth())) return;
    setStartedAt(Date.now());
    setActionError(null);
    try {
      await gen.start({
        prompts: lines,
        settings,
        style: style.analysed ? style : null,
        refs,
        targetCount: Number(settings.targetCount) > 0 ? Number(settings.targetCount) : 0,
      });
    } catch (err) {
      setActionError(err.message);
    } finally {
      setStartedAt(null);
    }
  }, [lines, settings, style, refs, gen, requireAuth]);

  const handleClear = useCallback(async () => {
    if (!window.confirm('Delete every generated image in this session? This cannot be undone.')) return;
    await gen.clearAll();
    setActionError(null);
  }, [gen]);

  /* ----------------------------- warnings ---------------------------- */
  const warnings = useMemo(() => {
    const out = [];
    if (!refs.length) {
      out.push({
        id: 'noref',
        tone: 'warn',
        icon: '🖼️',
        title: 'No reference images yet',
        body: 'Without references the model has no style to copy. Upload a few, or keep going if plain prompts are intentional.',
      });
    } else if (!style.analysed) {
      out.push({
        id: 'nostyle',
        tone: 'info',
        icon: '✨',
        title: 'Style not analysed',
        body: `Your ${refs.length} reference image(s) will still be sent with every request, but running “Analyse reference style” locks the look across all ${total} images.`,
      });
    }
    if (settings.concurrency > 3) {
      out.push({
        id: 'conc',
        tone: 'warn',
        icon: '⚡',
        title: `Concurrency ${settings.concurrency} exceeds the free tier`,
        body: 'Puter allows 3 simultaneous AI requests on a free account. Above that you will see rate-limit retries (the runner backs off automatically, so nothing is lost — it just slows down).',
      });
    }
    if (storage && planBytes > 0 && storage.free < planBytes * 1.15) {
      out.push({
        id: 'quota',
        tone: 'warn',
        icon: '💾',
        title: `This batch may not fit in browser storage`,
        body: `${formatBytes(planBytes)} of images against roughly ${formatQuota(storage.free)} still available for this site. Images are cached locally so a refresh never loses them — if the quota runs out, generation continues but the newest images will only exist in the gallery until you download the ZIP. Clearing other tabs or using JPG/WebP output frees a lot of room.`,
      });
    }
    if (persisted && persisted.supported && !persisted.persisted) {
      out.push({
        id: 'persist',
        tone: 'info',
        icon: '🔒',
        title: 'Browser storage is on a best-effort basis',
        body: 'The browser declined to make this site\'s storage persistent, so it may clear cached images under disk pressure. Download the ZIP as soon as a batch finishes.',
      });
    }
    if (estimate.usd > 5) {
      out.push({
        id: 'cost',
        tone: estimate.usd > 20 ? 'warn' : 'info',
        icon: '💳',
        title: `≈ $${estimate.usd.toFixed(2)} of model usage for ${total} images`,
        body: settings.autoDowngrade
          ? 'Puter bills your own account at real cost. There is no API key and no fee from this app, but a free Puter allowance will not cover a batch this size — “Stay alive when credit runs out” is on, so the runner drops to a cheaper Nano Banana tier and keeps going.'
          : 'Puter bills your own account at real cost. This batch will stop with “insufficient funds” once the allowance is gone. Turn on “Stay alive when credit runs out” or pick a cheaper tier.',
      });
    }
    return out;
  }, [
    refs,
    style,
    settings.concurrency,
    settings.autoDowngrade,
    estimate.usd,
    total,
    storage,
    planBytes,
    persisted,
  ]);

  const running = gen.phase === 'running' || gen.phase === 'paused';
  const ready = lines.length > 0 && !running;

  let embedded = false;
  try {
    embedded = typeof window !== 'undefined' && window.self !== window.top;
  } catch {
    embedded = true;
  }

  /* -------------------------------- UI ------------------------------- */
  return (
    <div className="app">
      <TopBar onHelp={() => setHelpOpen(true)} onAuth={setSignedIn} />

      {embedded ? (
        <div className="banner info">
          <span className="ic">🪟</span>
          <div>
            <strong>Running inside a preview frame</strong>
            <p>
              Sign-in opens a popup, which some embedded frames block.{' '}
              <a href={window.location.href} target="_blank" rel="noreferrer">
                Open StyleForge in its own tab
              </a>{' '}
              if the Puter login does not appear.
            </p>
          </div>
        </div>
      ) : null}

      {creditHit ? (
        <div className="banner warn">
          <span className="ic">💳</span>
          <div>
            <strong>Puter says this account has hit its usage limit</strong>
            <p>
              The run {settings.autoDowngrade ? 'switched to a cheaper Nano Banana tier and kept going' : 'stopped'}.
              Each Puter account gets a free monthly allowance; top-ups and plan details live at{' '}
              <a href="https://puter.com/dashboard" target="_blank" rel="noreferrer">
                puter.com/dashboard
              </a>
              . Nothing here costs you anything beyond that — there is no per-app fee and no API key.
            </p>
          </div>
          <button className="btn xs ghost" onClick={() => setCreditHit(false)}>
            Dismiss
          </button>
        </div>
      ) : null}

      {actionError ? (
        <div className="banner err">
          <span className="ic">⚠</span>
          <div>
            <strong>Something went wrong</strong>
            <p>{actionError}</p>
          </div>
        </div>
      ) : null}

      <div style={{ display: 'grid', gap: 18 }}>
        <ReferencePanel refs={refs} setRefs={setRefs} disabled={running} />

        <div className="grid-2">
          <StylePanel
            refs={refs}
            style={style}
            setStyle={setStyle}
            onAnalyze={handleAnalyze}
            analyzing={analyzing}
            progress={analyzeProgress}
            error={analyzeError}
            useStyleDna={settings.useStyleDna}
            setUseStyleDna={(v) => update({ useStyleDna: v })}
            strength={settings.styleStrength}
            setStrength={(v) => update({ styleStrength: v })}
            disabled={running}
          />

          <PromptPanel
            promptsText={promptsText}
            setPromptsText={setPromptsText}
            variations={settings.variations}
            setVariations={(v) => update({ variations: v })}
            targetCount={settings.targetCount}
            setTargetCount={(v) => update({ targetCount: v })}
            filenamePattern={settings.filenamePattern}
            setFilenamePattern={(v) => update({ filenamePattern: v })}
            onSuggest={handleSuggest}
            onEnhanceAll={handleEnhanceAll}
            busy={busy}
            disabled={running}
          />
        </div>

        <AspectRatioTabs
          value={settings.aspect}
          onChange={(v) => update({ aspect: v })}
          tier={dims.tier}
          customW={settings.customW}
          customH={settings.customH}
          onCustom={(k, v) => update(k === 'w' ? { customW: v } : { customH: v })}
          disabled={running}
        />

        <OutputPanel settings={settings} update={update} disabled={running} />

        <RunPanel
          stats={gen.stats}
          phase={gen.phase}
          log={gen.log}
          fatal={gen.fatal}
          settings={settings}
          dims={dims}
          model={model}
          activeModelId={gen.activeModelId}
          total={total}
          estimate={estimate}
          warnings={warnings}
          refCount={refs.length}
          startedAt={startedAt}
          onPause={gen.pause}
          onResume={gen.resume}
          onCancel={gen.cancel}
          onRetryFailed={() => gen.retryFailed({ settings, style: style.analysed ? style : null, refs })}
        />

        <ResultsPanel
          plan={gen.plan}
          results={gen.results}
          settings={settings}
          onClear={handleClear}
          hasRun={gen.plan.length > 0}
          buildingZip={buildingZip}
          setBuildingZip={setBuildingZip}
          getResultBlobs={gen.getResultBlobs}
        />
      </div>

      {/* -------------------------- action bar -------------------------- */}
      <div className="actionbar">
        <div className="actionbar-inner">
          <div>
            <div className="title">
              {total
                ? `${total} image${total === 1 ? '' : 's'} · ${dims.w}×${dims.h} · ${model.short}`
                : 'Waiting for prompts'}
            </div>
            <div className="sub">
              {lines.length
                ? `Aspect ${settings.aspect} · ${settings.tier} · ${settings.concurrency} at a time${
                    refs.length ? ` · ${refs.length} reference${refs.length === 1 ? '' : 's'}` : ''
                  }`
                : 'Paste one prompt per line in step 3'}
            </div>
          </div>

          {gen.stats.total ? (
            <div className="bar-mini">
              <div className="row" style={{ justifyContent: 'space-between', marginBottom: 4 }}>
                <span className="hint">{gen.stats.percent}% complete</span>
                <span className="hint mono">
                  {gen.stats.done}/{gen.stats.total}
                </span>
              </div>
              <div className="progress">
                <i style={{ width: `${gen.stats.percent}%` }} />
              </div>
            </div>
          ) : null}

          <div className="row" style={{ gap: 8 }}>
            {gen.results.length ? (
              <span className="pill">{formatBytes(gen.stats.bytes)} generated</span>
            ) : null}
            {gen.phase === 'running' ? (
              <>
                <button className="btn" onClick={gen.pause}>
                  ⏸ Pause
                </button>
                <button className="btn danger" onClick={gen.cancel}>
                  ✕ Stop
                </button>
              </>
            ) : gen.phase === 'paused' ? (
              <button className="btn primary" onClick={gen.resume}>
                ▶ Resume
              </button>
            ) : (
              <button
                className="btn primary"
                onClick={handleStart}
                disabled={!ready || !booted}
                title={lines.length ? '' : 'Add prompts first'}
              >
                ▶ Generate {total || ''} image{total === 1 ? '' : 's'}
              </button>
            )}
            {!signedIn && ready && !running ? (
              <span className="hint" style={{ maxWidth: 220 }}>
                Sign in with the free Puter account button above — no API key, ever.
              </span>
            ) : null}
          </div>
        </div>
      </div>

      {helpOpen ? <HelpModal onClose={() => setHelpOpen(false)} /> : null}
    </div>
  );
}

/* ------------------------------------------------------------------ */

function HelpModal({ onClose }) {
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <header>How StyleForge Bulk works</header>
        <div className="body">
          <ul style={{ margin: 0, paddingLeft: 18, display: 'grid', gap: 9, fontSize: 13.5 }}>
            <li>
              <strong>No API key, ever.</strong> The app talks to Google's Nano Banana Pro model
              through <a href="https://developer.puter.com/" target="_blank" rel="noreferrer">Puter.js</a>,
              which uses a “User-Pays” model: you sign in once with a normal Puter login and your own
              account's free allowance covers the model usage. Nothing is stored on a server we own —
              there is no backend.
            </li>
            <li>
              <strong>Same style as your references.</strong> Two things happen. First, a vision
              model reads your uploaded references and writes a “Style DNA” brief (palette, lighting,
              texture, keywords). Second, the reference images themselves ride along with every
              request as `input_images`. Text + vision together are what keep 200 images consistent.
            </li>
            <li>
              <strong>Bulk prompts.</strong> Paste as many lines as you like, set variations and a
              target count, and the runner walks the queue with a fixed number of workers, retries
              failures, and backs off globally when the API rate-limits.
            </li>
            <li>
              <strong>Honest limits.</strong> Puter allows 3 simultaneous AI requests and 30 requests
              per 10 seconds on a free account. 200 Nano Banana Pro images is also far more than a
              free monthly allowance covers — the run is designed to keep going by dropping to a
              cheaper Nano Banana tier when credit runs out, and you can turn that off.
            </li>
            <li>
              <strong>Watermarks.</strong> Nothing this app or Puter adds is drawn onto your image —
              no logo, no watermark, no border. (Google does embed an invisible SynthID provenance
              marker in Gemini-generated pixels; it is not visible and does not change the picture.)
            </li>
            <li>
              <strong>ZIP export.</strong> “Download all … as ZIP” packages every finished image into
              one archive, named 001, 002, 003 … in prompt order, with a manifest.csv mapping each
              file back to its prompt.
            </li>
            <li>
              <strong>Your work is cached locally.</strong> Finished images are written to this
              browser's IndexedDB as they arrive, so a refresh or crash does not throw away an hour of
              generation. “Clear” deletes them.
            </li>
          </ul>
        </div>
        <footer>
          <button className="btn" onClick={onClose}>
            Got it
          </button>
        </footer>
      </div>
    </div>
  );
}
