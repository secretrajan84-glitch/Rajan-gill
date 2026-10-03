import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { generateImage, classifyError, measureBlob } from '../lib/puterClient.js';
import { buildPrompt } from '../lib/styleEngine.js';
import { buildPlan, runPool, PauseGate, RateGovernor } from '../lib/queueEngine.js';
import { convertBlob, resizeToDataUrl, sleep, formatBytes } from '../lib/imageUtils.js';
import { MODEL_BY_ID, DOWNGRADE_LADDER, TIER_PIXELS } from '../lib/constants.js';
import { idb, STORE_NAMES } from '../lib/idb.js';

const newRunId = () => `run-${Date.now().toString(36)}`;

/**
 * Owns the whole bulk-generation lifecycle: plan building, the worker pool,
 * retries, adaptive throttling, automatic model downgrade when the account's
 * credit runs dry, and persistence of every finished image into IndexedDB.
 */
export function useGenerator() {
  const [plan, setPlan] = useState([]);
  const [phase, setPhase] = useState('idle'); // idle | running | paused | done
  const [log, setLog] = useState([]);
  const [fatal, setFatal] = useState(null);
  const [runId, setRunId] = useState(null);
  const [activeModelId, setActiveModelId] = useState(null);

  /* All live state lives in refs so the worker pool never sees stale props. */
  const settingsRef = useRef(null);
  const styleRef = useRef(null);
  const refsRef = useRef([]);
  const abortedRef = useRef(false);
  const gateRef = useRef(new PauseGate());
  const governorRef = useRef(new RateGovernor());
  const runIdRef = useRef(null);
  const planRef = useRef([]);
  const activeModelRef = useRef(null);

  /* ----------------------------- helpers ---------------------------- */

  const bump = useCallback(() => setPlan((p) => (p.length ? p.slice() : p)), []);

  const pushLog = useCallback((level, text) => {
    setLog((l) => {
      const next = [...l, { level, text, at: Date.now(), id: Math.random().toString(36).slice(2) }];
      return next.length > 400 ? next.slice(next.length - 400) : next;
    });
  }, []);

  useEffect(() => {
    planRef.current = plan;
  }, [plan]);

  /* ------------------------- one image, all in ---------------------- */

  /**
   * Generate a single plan item: retries, backoff, auto-downgrade, thumbnail,
   * IndexedDB persistence. Mutates `item` in place and bumps the UI.
   */
  const generateOneItem = useCallback(
    async (item) => {
      const s = settingsRef.current;
      let model = MODEL_BY_ID[activeModelRef.current] || MODEL_BY_ID[s.modelId];
      const isAborted = () => abortedRef.current;

      item.status = 'running';
      item.error = null;
      bump();

      let lastErr = null;
      let attempt = 0;

      while (attempt < s.maxAttempts) {
        if (isAborted()) {
          item.status = 'cancelled';
          bump();
          throw new DOMException('Aborted', 'AbortError');
        }
        attempt += 1;
        item.attempts = attempt;
        bump();

        const tier = model.tiers.includes(s.tier) ? s.tier : model.defaultTier;
        const ratio = ratioFor(s);
        const aspectId = ratio.custom ? `${ratio.w}:${ratio.h}` : s.aspect;

        const finalPrompt = buildPrompt(item.prompt, {
          style: s.useStyleDna ? styleRef.current : null,
          strength: s.styleStrength,
          aspectId,
          useStyleDna: s.useStyleDna,
        });

        const inputImages =
          s.sendReferences && model.maxRefs > 0
            ? refsRef.current.slice(0, Math.min(s.maxRefsPerCall, model.maxRefs)).map((r) => r.apiDataUrl)
            : [];

        try {
          await governorRef.current.waitTurn(isAborted);

          const res = await generateImage({
            prompt: finalPrompt,
            modelId: model.id,
            tier,
            ratio,
            inputImages,
          });

          if (!res.blob) {
            // Billed and displayed, but the provider handed back a temporary
            // link we cannot read into bytes for the archive.
            Object.assign(item, {
              status: 'done',
              bytesAvailable: false,
              previewSrc: res.previewSrc,
              mime: res.mime,
              width: res.width,
              height: res.height,
              model: model.short,
              modelId: model.id,
              tier,
              aspect: aspectId,
            });
            bump();
            pushLog(
              'warn',
              `#${item.index}: rendered, but the provider returned a temporary link — download it from the gallery, it cannot go in the ZIP.`,
            );
            return;
          }

          let blob = res.blob;
          if (s.outputFormat && s.outputFormat !== 'png') {
            blob = await convertBlob(blob, s.outputFormat);
          }

          const dims =
            res.width && res.height
              ? { width: res.width, height: res.height }
              : await measureBlob(blob);
          const thumb = await resizeToDataUrl(blob, 560, 0.78, 'image/jpeg');

          const record = {
            id: `${runIdRef.current}:${item.index}`,
            runId: runIdRef.current,
            order: item.index,
            index: item.index,
            promptIndex: item.promptIndex,
            variation: item.variation,
            prompt: item.prompt,
            blob,
            thumb: thumb.dataUrl,
            mime: blob.type || res.mime,
            width: dims.width,
            height: dims.height,
            bytes: blob.size,
            model: model.short,
            modelId: model.id,
            tier,
            aspect: aspectId,
            createdAt: new Date().toISOString(),
          };

          idb.put(STORE_NAMES.RESULTS, record).catch((err) => {
            pushLog('warn', `Could not cache #${item.index} locally: ${err.message}`);
          });

          Object.assign(item, {
            status: 'done',
            // NOTE: deliberately no `blob` here. 200 2K PNGs is ~800 MB, which
            // would kill the tab. The full-resolution bytes live in IndexedDB
            // and are streamed back out when the ZIP is assembled.
            blob: null,
            resultId: record.id,
            thumb: thumb.dataUrl,
            mime: record.mime,
            width: dims.width,
            height: dims.height,
            bytes: blob.size,
            bytesAvailable: true,
            model: model.short,
            modelId: model.id,
            tier,
            aspect: aspectId,
            createdAt: record.createdAt,
          });
          governorRef.current.reward();
          bump();
          return;
        } catch (err) {
          if (err?.name === 'AbortError') {
            item.status = 'cancelled';
            bump();
            throw err;
          }

          lastErr = err;
          const info = classifyError(err);
          item.error = info;
          bump();

          if (info.code === 'too_many_requests') {
            const waited = governorRef.current.penalize(info.backoff);
            pushLog(
              'warn',
              `Rate limited — holding new requests for ${Math.round(waited / 1000)}s. Drop concurrency to 3 if it keeps happening.`,
            );
          }

          if (info.blocking) {
            const next = settingsRef.current.autoDowngrade ? nextCheaperModel(model.id) : null;
            if (next) {
              model = next;
              activeModelRef.current = next.id;
              setActiveModelId(next.id);
              pushLog(
                'warn',
                `Puter credit used up — switched to ${next.short} to keep the run alive.`,
              );
              attempt -= 1; // the downgrade must not burn a retry
              continue;
            }
            abortedRef.current = true;
            setFatal(info);
            item.status = 'blocked';
            bump();
            throw err;
          }

          if (!info.retryable || attempt >= s.maxAttempts) break;

          const waitMs = info.backoff * attempt + Math.random() * 600;
          pushLog(
            'warn',
            `#${item.index} attempt ${attempt} failed (${info.title}) — retrying in ${(waitMs / 1000).toFixed(1)}s.`,
          );
          await sleep(waitMs).catch(() => {});
        }
      }

      const info = classifyError(lastErr);
      item.status = info.blocking ? 'blocked' : 'failed';
      item.error = info;
      bump();
      pushLog('error', `#${item.index} failed: ${info.title} — ${info.message}`);
      throw lastErr;
    },
    [bump, pushLog],
  );

  /* ------------------------------ start ----------------------------- */

  const start = useCallback(
    async ({ prompts, settings, style, refs, targetCount }) => {
      const items = buildPlan({
        prompts,
        variations: settings.variations,
        targetCount,
        indexStart: settings.indexStart,
      });
      if (!items.length) throw new Error('Add at least one prompt before generating.');

      settingsRef.current = settings;
      styleRef.current = style;
      refsRef.current = refs || [];
      abortedRef.current = false;
      gateRef.current = new PauseGate();
      governorRef.current = new RateGovernor();
      activeModelRef.current = settings.modelId;

      setFatal(null);
      setLog([]);
      setActiveModelId(settings.modelId);
      const id = newRunId();
      runIdRef.current = id;
      setRunId(id);
      setPlan(items);
      setPhase('running');

      pushLog(
        'info',
        `Queued ${items.length} image${items.length === 1 ? '' : 's'} on ${
          MODEL_BY_ID[settings.modelId]?.short || settings.modelId
        } · ${settings.concurrency} at a time.`,
      );

      idb
        .put(STORE_NAMES.META, {
          id: 'session',
          runId: id,
          createdAt: Date.now(),
          prompts: prompts.join('\n'),
          settings,
          style: style || null,
          total: items.length,
        })
        .catch(() => {});

      await runPool({
        items,
        concurrency: settings.concurrency,
        runOne: generateOneItem,
        isAborted: () => abortedRef.current,
        gate: gateRef.current,
      });

      setPhase(abortedRef.current ? 'idle' : 'done');
      const done = items.filter((i) => i.status === 'done').length;
      const failed = items.filter((i) => i.status === 'failed').length;
      if (abortedRef.current && !done) {
        pushLog('warn', 'Run stopped.');
      } else {
        pushLog(
          failed ? 'warn' : 'success',
          `Run complete — ${done} generated${failed ? `, ${failed} failed` : ''}.`,
        );
      }
    },
    [generateOneItem, pushLog],
  );

  /* ---------------------------- controls ---------------------------- */

  const pause = useCallback(() => {
    gateRef.current.pause();
    setPhase('paused');
  }, []);

  const resume = useCallback(() => {
    gateRef.current.resume();
    setPhase('running');
  }, []);

  const cancel = useCallback(() => {
    abortedRef.current = true;
    gateRef.current.resume();
    setPhase('idle');
  }, []);

  const retryFailed = useCallback(
    async ({ settings, style, refs }) => {
      const targets = planRef.current.filter(
        (i) => i.status === 'failed' || i.status === 'blocked' || i.status === 'cancelled',
      );
      if (!targets.length) return;

      settingsRef.current = settings;
      styleRef.current = style;
      refsRef.current = refs || [];
      abortedRef.current = false;
      gateRef.current = new PauseGate();
      governorRef.current = new RateGovernor();
      activeModelRef.current = settings.modelId;
      setActiveModelId(settings.modelId);
      setFatal(null);
      setPhase('running');
      pushLog('info', `Retrying ${targets.length} unfinished image(s).`);

      await runPool({
        items: targets,
        concurrency: settings.concurrency,
        runOne: async (item) => {
          item.status = 'queued';
          item.error = null;
          bump();
          await generateOneItem(item);
        },
        isAborted: () => abortedRef.current,
        gate: gateRef.current,
      });

      setPhase('done');
      const done = planRef.current.filter((i) => i.status === 'done').length;
      pushLog('success', `Retry pass finished — ${done}/${targets.length} of the retried set now generated.`);
    },
    [bump, generateOneItem, pushLog],
  );

  const clearAll = useCallback(async () => {
    abortedRef.current = true;
    gateRef.current.resume();
    planRef.current = [];
    setPlan([]);
    setLog([]);
    setFatal(null);
    setPhase('idle');
    setRunId(null);
    try {
      await idb.clear(STORE_NAMES.RESULTS);
      await idb.del(STORE_NAMES.META, 'session');
    } catch {
      /* ignore */
    }
  }, []);

  /** Restore the previous session's finished images after a reload. */
  const restore = useCallback(async () => {
    try {
      const session = await idb.get(STORE_NAMES.META, 'session');
      if (!session) return null;
      const all = (await idb.all(STORE_NAMES.RESULTS)) || [];
      const mine = all.filter((r) => !session.runId || r.runId === session.runId);
      if (!mine.length) return session;
      mine.sort((a, b) => a.order - b.order);

      const items = mine.map((r) => ({
        id: `img-${r.order}`,
        index: r.order,
        promptIndex: r.promptIndex,
        variation: r.variation,
        prompt: r.prompt,
        status: 'done',
        attempts: 1,
        resultId: r.id,
        thumb: r.thumb,
        mime: r.mime,
        width: r.width,
        height: r.height,
        bytes: r.bytes,
        bytesAvailable: true,
        model: r.model,
        modelId: r.modelId,
        tier: r.tier,
        aspect: r.aspect,
        createdAt: r.createdAt,
      }));

      planRef.current = items;
      setPlan(items);
      runIdRef.current = session.runId;
      setRunId(session.runId);
      setActiveModelId(session.settings?.modelId || null);
      setPhase('done');
      pushLog('info', `Restored ${items.length} image(s) from your previous session.`);
      return session;
    } catch {
      return null;
    }
  }, [pushLog]);

  /* ----------------------------- derived ---------------------------- */

  const results = useMemo(
    () => plan.filter((i) => i.status === 'done' && (i.thumb || i.previewSrc)),
    [plan],
  );

  const stats = useMemo(() => {
    const total = plan.length;
    const count = (s) => plan.filter((i) => i.status === s).length;
    const done = count('done');
    const failed = count('failed');
    const blocked = count('blocked');
    const cancelled = count('cancelled');
    const bytes = plan.reduce((sum, i) => sum + (i.bytes || 0), 0);
    const finished = done + failed + blocked + cancelled;
    return {
      total,
      done,
      failed,
      blocked,
      cancelled,
      running: count('running'),
      queued: count('queued'),
      bytes,
      bytesLabel: formatBytes(bytes),
      finished,
      percent: total ? Math.round((finished / total) * 100) : 0,
    };
  }, [plan]);

  /** Read one finished image's full-resolution bytes back out of IndexedDB. */
  const getResultBlob = useCallback(async (item) => {
    if (!item) return null;
    if (item.blob) return item.blob;
    const id = item.resultId || `${runIdRef.current}:${item.index}`;
    try {
      const rec = await idb.get(STORE_NAMES.RESULTS, id);
      return rec?.blob || null;
    } catch {
      return null;
    }
  }, []);

  /** Read many at once, in order. Used by the ZIP builder. */
  const getResultBlobs = useCallback(
    async (items, onProgress) => {
      const out = [];
      for (let i = 0; i < items.length; i += 1) {
        const blob = await getResultBlob(items[i]);
        if (blob) out.push({ item: items[i], blob });
        onProgress?.(i + 1, items.length);
      }
      return out;
    },
    [getResultBlob],
  );

  return {
    plan,
    results,
    stats,
    phase,
    log,
    fatal,
    runId,
    activeModelId,
    start,
    pause,
    resume,
    cancel,
    retryFailed,
    clearAll,
    restore,
    getResultBlob,
    getResultBlobs,
  };
}

/* -------------------------------------------------------------------- */

export function ratioFor(settings) {
  if (settings.aspect === 'custom') {
    return { w: Number(settings.customW) || 16, h: Number(settings.customH) || 9, custom: true };
  }
  const [w, h] = String(settings.aspect).split(':').map(Number);
  return { w: w || 1, h: h || 1, custom: false };
}

function nextCheaperModel(currentId) {
  const i = DOWNGRADE_LADDER.indexOf(currentId);
  if (i === -1 || i === DOWNGRADE_LADDER.length - 1) return null;
  return MODEL_BY_ID[DOWNGRADE_LADDER[i + 1]] || null;
}

/** Pre-flight cost estimate for the user's own Puter account. */
export function estimateCost({ count, modelId, tier }) {
  const model = MODEL_BY_ID[modelId];
  if (!model || !count) return { usd: 0, perImage: 0, model };
  const perImage = model.price?.[tier] ?? model.price?.[model.defaultTier] ?? 0;
  return { usd: perImage * count, perImage, model };
}

/** The pixel size the model will most likely return for these settings. */
export function outputDimensions(settings) {
  const model = MODEL_BY_ID[settings.modelId];
  const tier = model?.tiers.includes(settings.tier) ? settings.tier : model?.defaultTier || '1K';
  const base = TIER_PIXELS[tier] || 1024;
  const ratio = ratioFor(settings);
  const area = base * base;
  const round = (n) => Math.max(64, Math.round(n / 32) * 32);
  return {
    w: round(Math.sqrt((area * ratio.w) / ratio.h)),
    h: round(Math.sqrt((area * ratio.h) / ratio.w)),
    tier,
  };
}
